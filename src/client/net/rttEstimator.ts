/**
 * RQ-64 랙 보상 — 클라이언트 RTT 조달(평가 F1 대응, `_workspace/RQ-64/
 * 03_evaluator_report.md` F1) 순수 로직. `harness/workflow/fe.md`가
 * "netcode 레이어" 책임으로 두는 예측(RQ-62)·보간(RQ-63)과 같은 위상의
 * 순수 계산 모듈이다(ADR-0011: 클라이언트 모듈은 test-after 허용).
 *
 * 그린필드 계약은 `tests/unit/rq-64-rtt-estimator.test.ts` 상단 docblock
 * (test-writer 지정)이 정본이다 — 이 파일은 그 계약을 그대로 구현한다.
 *
 * **설계**: 새 ping/pong 프로토콜을 두지 않는다 — 클라이언트가 이미 `move`
 * 메시지에 싣는 시퀀스 번호(`seq`, `@client/net/prediction`의 `applyInput`)와
 * 서버가 그 처리 결과로 돌려주는 `lastProcessedInputSeq`(스키마 필드) 왕복을
 * 그대로 RTT 표본으로 재사용한다(`connection.ts`가 배선한다).
 *
 * **결정론(ADR-0008)**: 이 모듈은 `Date.now()`·`performance.now()`를 직접
 * 호출하지 않는다 — 모든 시각은 호출자가 값으로 주입한다(`connection.ts`가
 * "성능 시계를 읽는 유일한 지점"이라는 기존 원칙과 합류, `prediction.ts`·
 * `interpolation.ts`와 동일한 분리).
 */

/** 미확인 전송 기록 상한 — `prediction.ts`의 `BUFFER_CAP`(100, "클라가 서버
 * 틱 레이트와 동일한 주기로 입력을 보낸다는 전제 하 약 3.3초 분량")과 동일한
 * 근거·동일한 값을 재사용한다 — 같은 종류의 "미확인 seq 버퍼"라 새 값을
 * 발명하지 않는다(ADR-0010 정신). 서버가 오래 확인해 주지 않아도(스냅샷
 * 기아) 메모리가 무한정 늘지 않는다. */
export const RTT_SEND_BUFFER_CAP = 100

export interface RttEstimator {
  /** `seq`를 `sentAtMs` 시각에 전송했다고 기록한다(`connection.ts`의
   * `sendMoveInput`이 `predictor.applyInput` 직후 호출). */
  recordSend(seq: number, sentAtMs: number): void
  /** 서버가 확정한 최신 처리 시퀀스(`lastProcessedInputSeq`)가 도착했을 때
   * 호출한다(`connection.ts`의 `handleStateChange`가
   * `readSelfAuthoritativeState` 성공 시 호출). */
  onAck(confirmedSeq: number, ackedAtMs: number): void
  /** 현재 추정 RTT(ms) — 아직 유효 표본이 없으면 0(=되감기 미적용과 동일한
   * 안전한 기본값, RQ-64 "RTT 0/미보고" 회귀 경로와 합류). */
  getRttMs(): number
}

interface PendingSend {
  seq: number
  sentAtMs: number
}

/**
 * `smoothingAlpha`는 필수 인자다(`interpolation.ts`의 `delayMs`와 동일한
 * 원칙 — 임의의 튜닝 상수를 모듈 내부에 감추지 않는다). 배선 계층
 * (`connection.ts`)이 실제 값을 정한다 — 값 자체는 밸런싱 판단이라 이
 * 계약이 규정하지 않는다.
 */
export function createRttEstimator(smoothingAlpha: number): RttEstimator {
  // `prediction.ts`의 `buffer`와 동일한 자료구조 선택(seq 오름차순 배열,
  // 상한 초과 시 가장 오래된 것부터 shift) — 같은 "미확인 seq 버퍼" 문제라
  // 같은 해법을 재사용한다.
  let pending: PendingSend[] = []
  let rttMs = 0
  let hasSample = false

  return {
    recordSend(seq: number, sentAtMs: number): void {
      pending.push({ seq, sentAtMs })
      if (pending.length > RTT_SEND_BUFFER_CAP) {
        pending.shift()
      }
    },

    onAck(confirmedSeq: number, ackedAtMs: number): void {
      const matched = pending.find((entry) => entry.seq === confirmedSeq)
      // `prediction.ts`의 `reconcile`(`buffer.filter(entry => entry.seq >
      // serverState.lastProcessedInputSeq)`)과 동일한 정리 패턴 — 확정된
      // seq 이하는 전부 제거해, 같은 confirmedSeq로 onAck가 다시 와도(다음
      // 패치가 아직 새 입력을 반영하지 못한 경우, 실 클라이언트에서 흔함)
      // 중복 표본이 생기지 않는다.
      pending = pending.filter((entry) => entry.seq > confirmedSeq)

      if (!matched) return // 정확히 그 seq가 기록된 적 없다(예: 서버 초기값 0) — no-op

      // 방어적 클램프(시계 역전 등) — `applyDamage`가 hp를 0 아래로 내리지
      // 않는 것과 동일한 정신.
      const sample = Math.max(0, ackedAtMs - matched.sentAtMs)

      if (!hasSample) {
        // 첫 표본은 평활 없이 그대로 기준값이 된다(부트스트랩) — "이전
        // 값=0"을 평활 공식에 넣어 첫 표본이 부당하게 깎이는 것을 막는다.
        rttMs = sample
        hasSample = true
      } else {
        rttMs = smoothingAlpha * sample + (1 - smoothingAlpha) * rttMs
      }
    },

    getRttMs(): number {
      return rttMs
    },
  }
}
