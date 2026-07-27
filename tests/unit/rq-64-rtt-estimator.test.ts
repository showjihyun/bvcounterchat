import { describe, expect, it } from 'vitest'
import { createRttEstimator, RTT_SEND_BUFFER_CAP, type RttEstimator } from '@client/net/rttEstimator'

/**
 * RQ-64 랙 보상 — 클라이언트 RTT 조달(평가 F1 대응, `_workspace/RQ-64/
 * 03_evaluator_report.md` F1) 순수 로직 단위 테스트 (ADR-0008: 순수 함수·
 * 결정론. ADR-0011: 클라이언트 모듈은 test-after 허용 — 단 테스트는 같은
 * PR에 동반해야 한다는 조건을 이 파일이 충족한다).
 *
 * **F1 요약**: 서버(`GameRoom.handleFire`)는 `fire` payload의 `rttMs`를
 * 이미 신뢰하지 않고 상한에서 절단하도록 구현돼 있지만, 실 클라이언트
 * 경로(`PlayerControls.tsx` → `chatInputGate.ts`)는 이 필드를 **전혀
 * 생산하지 않는다** — RQ-64가 제품에서 발화하지 않는다는 평가 blocker.
 *
 * ## 설계 — RTT 조달 방법(team-lead 지시 검토 결과)
 *
 * 새 ping/pong 메시지 타입을 추가하지 않는다. 클라이언트는 이미 `move`
 * 메시지에 시퀀스 번호(`seq`, `@client/net/prediction`의 `applyInput`이
 * 매 호출 1씩 증가시켜 부여)를 실어 보내고, 서버는 그 처리 결과를
 * `Player.lastProcessedInputSeq`(스키마 필드, 이미 존재)로 브로드캐스트한다
 * (`connection.ts`의 `readSelfAuthoritativeState`가 이미 이 값을 읽는다).
 * **이 기존 왕복을 그대로 RTT 측정에 재사용한다** — 새 프로토콜이 필요
 * 없다. 전송 시각을 seq별로 기록해 두고, 그 seq(또는 그 이상)가 확정돼
 * 돌아오면 경과 시간을 표본으로 삼는다.
 *
 * **잰 값이 "네트워크 RTT"보다 다소 큰 이유(설계 결정, 문제 아님)**: 확정은
 * Colyseus 상태 패치(기본 20Hz)를 통해 도착하므로, 이 표본에는 패치 배치
 * 지연(최대 ~50ms)이 섞여 실제 왕복 시간보다 다소 과대 추정될 수 있다.
 * 이는 오히려 **안전한 방향**이다 — 서버의 되감기 상한(200ms, RQ-64)은
 * 어차피 보고값을 절단하므로, 과소 추정(체감 저하)보다 과대 추정(상한
 * 근처로 더 자주 클램프)이 "너무 적게 되감아 체감이 나쁜" 방향보다 안전한
 * 실패 모드다.
 *
 * ## 그린필드 계약(test-writer 지정, `prediction.ts`의 시퀀스 버퍼·
 * `interpolation.ts`의 "필수 인자로 튜닝값을 받는다" 선례와 동일한 권한·
 * 원칙)
 *
 * ```ts
 * // src/client/net/rttEstimator.ts (신규)
 *
 * export interface RttEstimator {
 *   // seq를 sentAtMs 시각에 전송했다고 기록한다(`connection.ts`의
 *   // sendMoveInput이 predictor.applyInput 직후 호출).
 *   recordSend(seq: number, sentAtMs: number): void
 *   // 서버가 확정한 최신 처리 시퀀스(lastProcessedInputSeq)가 도착했을 때
 *   // 호출한다(`connection.ts`의 handleStateChange가
 *   // readSelfAuthoritativeState 성공 시 호출).
 *   onAck(confirmedSeq: number, ackedAtMs: number): void
 *   // 현재 추정 RTT(ms) — 아직 유효 표본이 없으면 0(=되감기 미적용과
 *   // 동일한 안전한 기본값, RQ-64 "RTT 0/미보고" 회귀 경로와 합류).
 *   getRttMs(): number
 * }
 *
 * // smoothingAlpha는 필수 인자다(interpolation.ts의 delayMs와 동일한
 * // 원칙 — 임의의 튜닝 상수를 모듈 내부에 감추지 않는다. 배선 계층
 * // (connection.ts)이 값을 정한다 — 값 자체는 밸런싱 판단이라 이 계약이
 * // 규정하지 않는다).
 * export function createRttEstimator(smoothingAlpha: number): RttEstimator
 *
 * // 미확인 전송 기록 상한 — `prediction.ts`의 BUFFER_CAP(100, "클라가
 * // 서버 틱 레이트와 동일한 주기로 입력을 보낸다는 전제 하 약 3.3초 분량")
 * // 과 동일한 근거·동일한 자릿수를 재사용한다(같은 종류의 "미확인 seq
 * // 버퍼"이므로 값을 새로 발명하지 않는다, ADR-0010 정신). 서버가 오래
 * // 확인해 주지 않아도(스냅샷 기아) 메모리가 무한정 늘지 않는다.
 * export const RTT_SEND_BUFFER_CAP: number // = 100
 * ```
 *
 * **결정론(ADR-0008 핵심)**: 이 모듈은 `Date.now()`·`performance.now()`를
 * 직접 호출하지 않는다 — 모든 시각은 호출자가 값으로 주입한다(연결 배선
 * 계층인 `connection.ts`가 유일하게 실제 시계를 읽는 지점이라는 기존 원칙,
 * `connection.ts` 상단 주석 "이 모듈이 유일하게 성능 시계를 읽는 지점이다"
 * 과 합류).
 *
 * **평활(EMA) 규칙**: 첫 표본은 그대로 기준값이 된다(부트스트랩 — "이전
 * 값=0"을 평활 공식에 넣어 첫 표본이 깎이면 안 된다). 이후 표본은
 * `rtt = alpha·sample + (1-alpha)·이전rtt`로 갱신한다. 표본 자체는 0
 * 미만으로 내려가지 않는다(음수 방어 — 시계 역전 등 방어적 클램프,
 * `@shared/sim/combat`의 `applyDamage`가 hp를 0 아래로 내리지 않는 것과
 * 동일한 정신).
 *
 * **정리(purge) 규칙**: `onAck(confirmedSeq, ...)`가 호출되면 기록된 전송
 * 중 `seq <= confirmedSeq`인 것은 전부 제거한다(확정됐으므로) —
 * `prediction.ts`의 `reconcile`이 `buffer.filter(entry => entry.seq >
 * serverState.lastProcessedInputSeq)`로 하는 것과 동일한 패턴. 이 정리
 * 덕분에 같은 `confirmedSeq`로 다시 `onAck`가 호출돼도(다음 패치가 아직
 * 새 입력을 반영하지 못한 경우 — 실 클라이언트에서 흔하다) 중복 표본이
 * 생기지 않는다(이미 정리돼 일치하는 항목이 없다 → no-op).
 *
 * **정확히 그 seq가 기록되지 않았을 때**: `confirmedSeq`와 정확히 일치하는
 * 전송 기록이 없으면(예: 서버 기본값 `lastProcessedInputSeq=0`은
 * `nextSeq`가 1부터 시작하는 `prediction.ts`와 절대 일치할 수 없다) 새
 * 표본을 만들지 않는다(no-op) — 다만 `seq <= confirmedSeq`인 다른 기록은
 * 여전히 정리한다(있다면).
 */

const ALPHA = 0.5

describe('RQ-64/F1 RTT 조달 — createRttEstimator: 표본·평활', () => {
  it('아직 확정 표본이 없으면 getRttMs()는 0이다(안전한 기본값)', () => {
    const estimator: RttEstimator = createRttEstimator(ALPHA)
    expect(estimator.getRttMs()).toBe(0)
  })

  it('recordSend만 하고 onAck가 없으면 여전히 0이다', () => {
    const estimator: RttEstimator = createRttEstimator(ALPHA)
    estimator.recordSend(1, 1000)
    estimator.recordSend(2, 1010)
    expect(estimator.getRttMs()).toBe(0)
  })

  it('첫 표본은 평활 없이 그대로 기준값이 된다(부트스트랩) — alpha=0.5인데 절반으로 깎이지 않는다', () => {
    const estimator: RttEstimator = createRttEstimator(ALPHA)
    estimator.recordSend(1, 1000)
    estimator.onAck(1, 1050) // sample = 50
    expect(estimator.getRttMs()).toBe(50)
  })

  it('두 번째 표본부터 EMA로 평활된다: rtt = alpha·sample + (1-alpha)·이전rtt', () => {
    const estimator: RttEstimator = createRttEstimator(ALPHA)
    estimator.recordSend(1, 1000)
    estimator.onAck(1, 1050) // rtt = 50 (부트스트랩)
    estimator.recordSend(2, 2000)
    estimator.onAck(2, 2100) // sample = 100 → rtt = 0.5*100 + 0.5*50 = 75
    expect(estimator.getRttMs()).toBe(75)
  })

  it('smoothingAlpha 값을 실제로 반영한다(하드코딩 아님) — alpha=0.25로 다른 결과', () => {
    const estimator: RttEstimator = createRttEstimator(0.25)
    estimator.recordSend(1, 1000)
    estimator.onAck(1, 1040) // rtt = 40 (부트스트랩)
    estimator.recordSend(2, 2000)
    estimator.onAck(2, 2080) // sample = 80 → rtt = 0.25*80 + 0.75*40 = 50
    expect(estimator.getRttMs()).toBe(50)
  })

  it('여러 미확인 전송이 한 번의 onAck(가장 최근 seq)로 함께 확정되면, 그 seq의 전송 시각으로 표본을 계산한다', () => {
    const estimator: RttEstimator = createRttEstimator(ALPHA)
    estimator.recordSend(1, 1000)
    estimator.recordSend(2, 1010)
    estimator.recordSend(3, 1020)
    // 서버가 패치 배치로 세 입력을 한꺼번에 반영해 seq=3만 확인해 온다.
    estimator.onAck(3, 1200) // sample = 1200 - 1020 = 180 (seq=3의 전송 시각 기준)
    expect(estimator.getRttMs()).toBe(180)
  })

  it('같은 confirmedSeq로 onAck가 중복 호출돼도 두 번째 호출은 표본을 추가하지 않는다(정리 후 재일치 없음)', () => {
    const estimator: RttEstimator = createRttEstimator(ALPHA)
    estimator.recordSend(1, 1000)
    estimator.onAck(1, 1050) // rtt = 50
    estimator.onAck(1, 9999) // 이미 정리됨 → no-op
    expect(estimator.getRttMs()).toBe(50)
  })

  it('한 번도 기록되지 않은 seq로 onAck가 호출돼도(예: 서버 초기값 0) 크래시 없이 무시된다', () => {
    const estimator: RttEstimator = createRttEstimator(ALPHA)
    // prediction.ts의 nextSeq는 1부터 시작하므로 seq=0은 실제로 전송된 적이 없다.
    estimator.onAck(0, 500)
    expect(estimator.getRttMs()).toBe(0)

    estimator.recordSend(1, 1000)
    estimator.onAck(1, 1030)
    expect(estimator.getRttMs()).toBe(30)
  })

  it('표본이 음수가 되면(시계 역전 등 방어적 상황) 0으로 클램프한다', () => {
    const estimator: RttEstimator = createRttEstimator(ALPHA)
    estimator.recordSend(1, 1000)
    estimator.onAck(1, 900) // ackedAtMs < sentAtMs — 방어적 클램프
    expect(estimator.getRttMs()).toBe(0)
  })

  it(`전송 기록 상한(RTT_SEND_BUFFER_CAP=${RTT_SEND_BUFFER_CAP})을 넘겨도 가장 최근 seq는 여전히 확인 가능하다(무한정 증가 방지, prediction.ts BUFFER_CAP과 동일 근거)`, () => {
    expect(RTT_SEND_BUFFER_CAP).toBe(100)
    const estimator: RttEstimator = createRttEstimator(ALPHA)
    for (let seq = 1; seq <= RTT_SEND_BUFFER_CAP + 50; seq += 1) {
      estimator.recordSend(seq, 1000 + seq)
    }
    const latestSeq = RTT_SEND_BUFFER_CAP + 50
    estimator.onAck(latestSeq, 1000 + latestSeq + 42)
    expect(estimator.getRttMs()).toBe(42)
  })

  it('상한 초과로 이미 밀려난(가장 오래된) seq는 onAck가 와도 표본을 만들지 않는다', () => {
    const estimator: RttEstimator = createRttEstimator(ALPHA)
    for (let seq = 1; seq <= RTT_SEND_BUFFER_CAP + 50; seq += 1) {
      estimator.recordSend(seq, 1000 + seq)
    }
    // seq=1은 상한(100)을 훨씬 초과해 밀려났어야 한다(가장 오래된 것부터 폐기).
    estimator.onAck(1, 999_999)
    expect(estimator.getRttMs()).toBe(0)
  })
})
