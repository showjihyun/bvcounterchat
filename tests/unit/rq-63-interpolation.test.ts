import { describe, expect, it } from 'vitest'
import { NET } from '@shared/constants'
import {
  createRemoteEntityInterpolator,
  type RemoteEntityInterpolator,
  type RemoteSnapshot,
} from '@client/net/interpolation'

/**
 * RQ-63 다른 플레이어 보간(entity interpolation) — 순수 로직 단위 테스트
 * (ADR-0008: 순수 함수, 결정론. `harness/workflow/fe.md` netcode 레이어
 * "다른 플레이어 보간(RQ-62/63)" 책임).
 *
 * 매핑된 골든 케이스: GA-37~39 (`harness/evals/golden/track-a-product.jsonl`).
 * - GA-37: "타 플레이어의 서버 스냅샷 2개(t1, t2) 수신 → 렌더 시각이 t1~t2
 *   사이 → 표시 위치가 두 스냅샷의 선형 보간 중간값이다 — 지연 버퍼(한
 *   스냅샷 간격 이상)를 둔 과거 시점을 그린다(ADR-0003)"
 * - GA-38: "스냅샷 도착 간격이 불규칙(지터) → 연속 렌더 → 표시 위치가
 *   순간이동(스냅) 없이 연속적으로 움직인다 — 버퍼에 스냅샷이 있는 한
 *   보간이 유지된다"
 * - GA-39: "자기 자신 → 렌더 → 자기 캐릭터는 보간 대상이 아니라 예측(RQ-62)
 *   위치로 그려진다 — 두 경로가 섞이지 않는다"
 *
 * RQ-63 전문: "클라이언트는 다른 플레이어의 위치를 서버 스냅샷 사이에서
 * 보간(Interpolation)해 표시해야 한다."
 *
 * ADR-0003 근거: "원격 엔티티는 항상 최신 스냅샷보다 한 스냅샷 간격 이상
 * (약 33~66ms) 뒤처진 시점을 그린다 — 두 스냅샷 사이를 보간할 여유를
 * 확보해야 스터터 없이 매끄러운 움직임이 나온다." 버린 대안: "외삽(dead
 * reckoning)만 사용, 보간 생략 — 방향 전환 시 오버슈트가 크고 정정(snap
 * correction)이 눈에 띈다."
 *
 * **레벨 분리(ADR-0008)**: 이 파일은 보간 모듈 자체의 순수 로직만 다룬다.
 * `src/client/net/connection.ts`(Colyseus 배선)·`src/client/store/gameStore.ts`
 * (game state 캐시)·`PlayerMeshes.tsx`(R3F 렌더링)와의 실제 결합은 스코프
 * 밖이다 — fe.md가 렌더링·네트워크 배선을 TDD 파이프라인 테스트 대상에서
 * 제외하고 typecheck·lint·스모크·수동 확인으로 대체하는 것과 동일하게
 * (RQ-62 `connection.ts` 배선도 단위 테스트되지 않았다 — `prediction.ts`
 * 순수 모듈만 단위 테스트됨, `tests/unit/rq-62-prediction.test.ts` 선례).
 *
 * **가정(coder에게 — 이 모듈은 아직 없다. 이 테스트가 계약을 정의한다.
 * `src/client/net/prediction.ts`(RQ-62)가 신규 모듈일 때 test-writer가 shape을
 * 지정했던 선례를 그대로 따른다)**:
 *
 * 배치 위치: `src/client/net/interpolation.ts` — `harness/workflow/fe.md`의
 * 레이어 표가 "다른 플레이어 보간(RQ-62/63)"을 netcode 레이어
 * (`src/client/net/`) 책임으로 명시하기 때문이다.
 *
 * ```ts
 * export interface InterpolationPosition {
 *   x: number
 *   y: number
 *   z: number
 * }
 *
 * export interface RemoteSnapshot extends InterpolationPosition {
 *   // 이 스냅샷을 수신한 시각(ms, 임의의 단조 증가 시각 축). 실제 시각
 *   // 소스(performance.now() 등)는 배선 계층(connection.ts)의 책임이다 —
 *   // 이 모듈은 주입된 값만 쓴다(ADR-0008 결정론, team-lead 지시: "시각
 *   // 주입 — 시각의 실측은 배선 계층 몫"). Math.random()·Date.now()·
 *   // performance.now()를 이 모듈이 직접 호출하지 않는다.
 *   receivedAt: number
 * }
 *
 * export interface RemoteEntityInterpolator {
 *   // 다른 플레이어의 서버 스냅샷을 시각과 함께 버퍼에 추가한다(GA-37/38).
 *   // sessionId가 생성 시 지정한 selfSessionId와 같으면 아무 일도 하지
 *   // 않는다(GA-39 — 자기 자신은 이 경로에 진입하지 않는다. 예측(RQ-62,
 *   // createClientPredictor)이 그 역할을 대신한다).
 *   addSnapshot(sessionId: string, snapshot: RemoteSnapshot): void
 *
 *   // 주어진 렌더 시각(ms)에서 표시할 위치를 계산한다.
 *   // - GA-37: 두 스냅샷이 렌더 시각(에서 지연을 뺀 시점)을 감싸면 그
 *   //   구간의 선형 보간 중간값.
 *   // - GA-38: 스냅샷이 몇 개든, 도착 간격이 불규칙하든 연속적인 함수값.
 *   // - 경계(스펙 미기재, 이 모듈의 설계 결정 — 아래 "경계 정책" 참고):
 *   //   스냅샷이 1개뿐이면 그 위치로 고정. 지연 반영 렌더 시각이 최신
 *   //   스냅샷보다 앞서면 외삽하지 않고 최신 위치로 고정(ADR-0003이 외삽
 *   //   대안을 명시적으로 기각). 가장 오래된 스냅샷보다도 이전이면 그
 *   //   스냅샷 위치로 고정.
 *   // - GA-39: sessionId가 selfSessionId와 같거나, 그 sessionId에 대해
 *   //   스냅샷이 한 번도 추가된 적 없으면 undefined.
 *   getPosition(sessionId: string, renderTime: number): InterpolationPosition | undefined
 * }
 *
 * // delayMs를 선택 인자가 아니라 필수 인자로 둔다 — "기본 지연값"이라는
 * // 개념 자체를 이 모듈에 두지 않는다. ADR-0003은 "약 33~66ms"라는 범위만
 * // 제시할 뿐 정확한 스펙 수치를 정하지 않았고(다른 상수들과 달리
 * // `@shared/constants`에 값으로 없다), 프로덕션에서 어떤 값을 쓸지는
 * // 배선 계층(connection.ts)의 Green 단계 판단 사항이다 — 이 계약은 그
 * // 판단을 강제하지 않고 호출자가 값으로 주입하게 한다(ADR-0008 정신과
 * // 일관).
 * export function createRemoteEntityInterpolator(
 *   selfSessionId: string,
 *   delayMs: number,
 * ): RemoteEntityInterpolator
 * ```
 *
 * **설계 결정(test-writer 재량, GA가 직접 규정하지 않은 부분)**:
 *
 * 1. **다중 엔티티 매니저 형태(세션ID로 다중화)** — 단일 엔티티용 버퍼
 *    하나만 만들지 않고 `sessionId` 인자로 여러 원격 플레이어를 한
 *    인스턴스가 관리하게 했다. 실제 게임에는 여러 원격 플레이어가 존재하고
 *    (개별 버퍼 인스턴스를 호출자가 일일이 만들고 없애는 것보다 낫다),
 *    무엇보다 **이 형태 자체가 GA-39(자기/타인 경로 분리)를 모듈 계약
 *    수준에서 직접 관찰 가능하게 만든다** — self는 이 매니저가 구조적으로
 *    거부한다(추가해도 무시, 조회해도 undefined).
 * 2. **`delayMs` 필수 인자** — 위 계약 설명 참고.
 * 3. **경계 정책 3종**(스냅샷 1개뿐, 렌더 시각이 최신보다 앞섬, 렌더
 *    시각이 최고참보다도 앞섬)은 모두 "고정(freeze)"으로 통일했다 —
 *    ADR-0003이 외삽을 명시적으로 버린 대안으로 기록했으므로, 보간할 두
 *    스냅샷이 없는 모든 경우에 외삽 대신 가장 가까운 실측 위치로 고정하는
 *    것이 일관된 정책이다.
 * 4. **스냅샷 도착 순서 가정** — 같은 sessionId에 대해 `addSnapshot`은
 *    `receivedAt` 오름차순으로 호출된다고 가정한다(Colyseus는 WebSocket
 *    기반 TCP 전송이라 같은 연결 내 순서가 보장된다, ADR-0002). 순서
 *    역전(네트워크 재정렬) 처리는 이 모듈의 계약에 포함하지 않는다 —
 *    발생하지 않는다고 가정된 입력에 대한 동작까지 테스트하면 스펙에
 *    없는 행동을 테스트화하는 것이다(CLAUDE.md 금지 항목).
 *
 * **스코프 밖(과잉 결합 금지 — 이 파일이 테스트하지 않는 것, 전부
 * `_workspace/RQ-63/01_test-writer_red.md`에 근거 기록)**:
 * - `src/client/net/connection.ts`가 이 모듈을 실제로 호출·배선하는지
 *   (room.onStateChange에서 원격 스냅샷을 이 매니저에 먹이는지, 렌더
 *   시각을 어디서 얻는지) — Green·리뷰 단계 판단.
 * - `src/client/store/gameStore.ts`에 보간 결과를 담을 필드를 추가할지,
 *   `PlayerMeshes.tsx`가 그 필드를 어떻게 읽을지 — 렌더링 배선, fe.md
 *   면제 대상.
 * - **20d 부기(침묵 disconnect 시 전송 인터벌·구독 정리)**: 이 항목은
 *   면제한다 — 근거는 `_workspace/RQ-63/01_test-writer_red.md` §3.2.
 *
 * **REV — 리뷰 대응(major: 보간 버퍼 무한 성장, `_workspace/review/feat-RQ-63-
 * interpolation.md`)**: 최초 라운드는 "버퍼 메모리 정리(오래된 스냅샷
 * 프루닝)"를 "ADR 근거 수치가 없어 임의값을 강제할 수 없다"는 이유로
 * 실패 테스트 없이 권고만 남겼었다. 리뷰가 실제 구현(`interpolation.ts`)의
 * `addSnapshot`이 push만 하고 프루닝이 전혀 없어 상설 세션(RQ-04)에서
 * 세션당 버퍼가 무한히 자라고(메모리) `computePosition`의 최고참발 선형
 * 스캔 비용도 세션 길이에 비례해 늘어난다(연산, `useFrame` 안에서 매
 * 프레임 호출됨)는 것을 실제로 지적했다 — 이제 "필요성"이 판정됐으므로
 * 아래 새 describe 블록에서 delayMs(생성 시 주입값, 이미 이 계약의
 * 일부)에서 도출한 두 경계로 프루닝을 실패 테스트로 강제한다. 내부
 * 배열·구현 방식(링버퍼 vs 조회 기반 프루닝)은 규정하지 않는다 — 오직
 * "기존 '가장 오래된 스냅샷 고정' 정책이 반환하는 값"이라는 이미 있던
 * 관찰 지점을 통해서만 검증한다(리뷰가 지적한 "oldest 고정 정책과의
 * 상호작용" 그 자체가 관찰 지점).
 */

const SELF = 'self-session'

describe('RQ-63/GA-37: 서버 스냅샷 2개 사이 렌더 시각 → 선형 보간 중간값(지연 버퍼 반영)', () => {
  it('RQ-63/GA-37: 지연 버퍼를 실제 틱 간격(NET.TICK_MS, ADR-0003의 하한)으로 설정해도 정확히 중간값을 그린다', () => {
    const delayMs = NET.TICK_MS // ADR-0003: "한 스냅샷 간격 이상"의 하한값
    const interpolator: RemoteEntityInterpolator = createRemoteEntityInterpolator(SELF, delayMs)

    interpolator.addSnapshot('remote-1', { x: 0, y: 0, z: 0, receivedAt: 0 })
    interpolator.addSnapshot('remote-1', { x: 10, y: 0, z: 0, receivedAt: NET.TICK_MS })

    // renderTime = 1.5틱 → te(=renderTime-delay) = 0.5틱 → 두 스냅샷의 정확히 중간.
    const renderTime = NET.TICK_MS * 1.5
    const position = interpolator.getPosition('remote-1', renderTime)

    expect(position?.x).toBeCloseTo(5, 5)
    expect(position?.y).toBe(0)
    expect(position?.z).toBe(0)
  })

  it('RQ-63/GA-37: 50%가 아닌 임의 비율(30%) 지점에서도 x·y·z 세 축 모두 독립적으로 선형 보간된다', () => {
    const interpolator: RemoteEntityInterpolator = createRemoteEntityInterpolator(SELF, 50)
    interpolator.addSnapshot('remote-1', { x: 0, y: 2, z: 0, receivedAt: 0 })
    interpolator.addSnapshot('remote-1', { x: 10, y: 6, z: -4, receivedAt: 100 })

    // te = 80 - 50 = 30 → 구간 [0,100]의 30% 지점.
    const position = interpolator.getPosition('remote-1', 80)

    expect(position?.x).toBeCloseTo(3, 5)
    expect(position?.y).toBeCloseTo(3.2, 5)
    expect(position?.z).toBeCloseTo(-1.2, 5)
  })

  it('RQ-63/GA-37: 스냅샷이 3개 이상이어도 렌더 시각을 실제로 감싸는 두 스냅샷 쌍을 정확히 골라 보간한다(첫 쌍에 고정되지 않는다)', () => {
    const interpolator: RemoteEntityInterpolator = createRemoteEntityInterpolator(SELF, 20)
    interpolator.addSnapshot('remote-1', { x: 0, y: 0, z: 0, receivedAt: 0 })
    interpolator.addSnapshot('remote-1', { x: 5, y: 0, z: 0, receivedAt: 50 })
    interpolator.addSnapshot('remote-1', { x: 20, y: 0, z: 0, receivedAt: 150 })

    // te = 120 - 20 = 100 → 두 번째 구간 [50,150] 사이, 그 구간의 50% 지점.
    const position = interpolator.getPosition('remote-1', 120)

    expect(position?.x).toBeCloseTo(12.5, 5)
  })
})

describe('RQ-63 경계: 보간할 두 스냅샷이 없는 상황의 고정(freeze) 정책 — 외삽 금지(ADR-0003)', () => {
  it('RQ-63: 버퍼에 스냅샷이 1개뿐이면 보간할 수 없어 그 위치로 고정된다(렌더 시각이 앞서든 뒤서든)', () => {
    const interpolator: RemoteEntityInterpolator = createRemoteEntityInterpolator(SELF, 30)
    interpolator.addSnapshot('remote-1', { x: 3, y: 1, z: 4, receivedAt: 100 })

    expect(interpolator.getPosition('remote-1', 100)).toEqual({ x: 3, y: 1, z: 4 })
    expect(interpolator.getPosition('remote-1', 1000)).toEqual({ x: 3, y: 1, z: 4 })
    expect(interpolator.getPosition('remote-1', 0)).toEqual({ x: 3, y: 1, z: 4 })
  })

  it('RQ-63/ADR-0003: 렌더 시각(지연 반영)이 최신 스냅샷보다 앞서면 외삽하지 않고 최신 위치에 고정된다(외삽 대안 기각)', () => {
    const interpolator: RemoteEntityInterpolator = createRemoteEntityInterpolator(SELF, 10)
    interpolator.addSnapshot('remote-1', { x: 0, y: 0, z: 0, receivedAt: 0 })
    interpolator.addSnapshot('remote-1', { x: 10, y: 0, z: 0, receivedAt: 100 })

    // te = 5000 - 10 = 4990, 최신 스냅샷(100)보다 한참 앞선다. 외삽했다면
    // 관측된 속도(10유닛/100ms)로 계속 나아가 x가 10보다 훨씬 컸을 것이다.
    const position = interpolator.getPosition('remote-1', 5000)

    expect(position).toEqual({ x: 10, y: 0, z: 0 })
  })

  it('RQ-63: 렌더 시각(지연 반영)이 가장 오래된 스냅샷보다도 이전이면(접속 직후 등) 외삽하지 않고 그 스냅샷 위치에 고정된다', () => {
    const interpolator: RemoteEntityInterpolator = createRemoteEntityInterpolator(SELF, 10)
    interpolator.addSnapshot('remote-1', { x: 5, y: 0, z: 0, receivedAt: 1000 })
    interpolator.addSnapshot('remote-1', { x: 8, y: 0, z: 0, receivedAt: 1100 })

    // te = 500 - 10 = 490, 가장 오래된 스냅샷(1000)보다도 이전이다.
    const position = interpolator.getPosition('remote-1', 500)

    expect(position).toEqual({ x: 5, y: 0, z: 0 })
  })
})

describe('RQ-63/GA-38: 지터(불규칙 도착 간격)에도 순간이동 없이 연속적으로 움직인다', () => {
  const REMOTE = 'remote-jitter'
  const DELAY_MS = 20

  // 불규칙 도착 간격(지터) 시퀀스 — 간격이 15/65/15/85ms로 들쭉날쭉하다.
  const snapshots: RemoteSnapshot[] = [
    { x: 0, y: 0, z: 0, receivedAt: 0 },
    { x: 1, y: 0, z: 0, receivedAt: 15 },
    { x: 6, y: 0, z: 0, receivedAt: 80 },
    { x: 7, y: 0, z: 0, receivedAt: 95 },
    { x: 12, y: 0, z: 0, receivedAt: 180 },
  ]

  function buildInterpolator(): RemoteEntityInterpolator {
    const interpolator = createRemoteEntityInterpolator(SELF, DELAY_MS)
    for (const snapshot of snapshots) {
      interpolator.addSnapshot(REMOTE, snapshot)
    }
    return interpolator
  }

  // 각 구간(연속 스냅샷 쌍)이 암시하는 이동 속도(단위/ms) 중 최댓값 — 어느
  // 렌더 시각 구간에서도 실제 위치 변화가 이 상한을 넘으면 "순간이동(스냅)"이다.
  // 보간 함수는 구간별 기울기가 이 값을 넘지 않는 구분적 선형 함수이므로
  // (고정 구간은 기울기 0), 이 상한은 스윕 구간·스텝 크기에 관계없이
  // 전 구간에서 성립해야 하는 불변식이다.
  function maxImpliedSpeedPerMs(): number {
    let max = 0
    for (let i = 1; i < snapshots.length; i += 1) {
      const dt = snapshots[i]!.receivedAt - snapshots[i - 1]!.receivedAt
      const dx = Math.abs(snapshots[i]!.x - snapshots[i - 1]!.x)
      max = Math.max(max, dx / dt)
    }
    return max
  }

  it('RQ-63/GA-38: 인접한 렌더 시각 사이의 위치 변화가 스냅샷이 암시하는 최대 이동 속도 이내로 유지된다(연속성 — 스냅 없음)', () => {
    const interpolator = buildInterpolator()
    const maxSpeedPerMs = maxImpliedSpeedPerMs()
    const stepMs = 5
    const EPS = 1e-6

    // 가장 오래된 스냅샷(0)보다 한참 이전(고정 구간)부터 가장 최신
    // 스냅샷(180)보다 한참 이후(고정 구간)까지 전 구간을 스윕한다.
    const startRenderTime = DELAY_MS - 80
    const endRenderTime = 180 + DELAY_MS + 100

    let previous = interpolator.getPosition(REMOTE, startRenderTime)!
    for (let renderTime = startRenderTime + stepMs; renderTime <= endRenderTime; renderTime += stepMs) {
      const current = interpolator.getPosition(REMOTE, renderTime)!
      const delta = Math.abs(current.x - previous.x)
      expect(delta).toBeLessThanOrEqual(maxSpeedPerMs * stepMs + EPS)
      previous = current
    }
  })

  it('RQ-63/GA-38: 가장 긴 도착 간격(65ms) 구간 한가운데서도 실제로 보간이 진행 중이다(정지·스냅이 아니라 실제 이동 — "연속성" 테스트가 상수 함수를 통과시키는 허점을 배제)', () => {
    const interpolator = buildInterpolator()
    // seg2: t=15(x=1) ~ t=80(x=6), 정확히 중간 te=47.5 → renderTime = 47.5+지연.
    const renderTime = 47.5 + DELAY_MS
    const position = interpolator.getPosition(REMOTE, renderTime)

    expect(position?.x).toBeCloseTo(3.5, 5)
  })
})

describe('RQ-63/GA-39: 자기 자신은 보간 경로가 아니라 예측(RQ-62) 경로를 쓴다 — 두 경로 불혼합', () => {
  it('RQ-63/GA-39: selfSessionId로 addSnapshot을 호출해도 버퍼에 반영되지 않고, getPosition은 항상 undefined다', () => {
    const interpolator: RemoteEntityInterpolator = createRemoteEntityInterpolator(SELF, 40)

    expect(() => interpolator.addSnapshot(SELF, { x: 1, y: 2, z: 3, receivedAt: 0 })).not.toThrow()
    interpolator.addSnapshot(SELF, { x: 4, y: 5, z: 6, receivedAt: 100 })

    expect(interpolator.getPosition(SELF, 0)).toBeUndefined()
    expect(interpolator.getPosition(SELF, 50)).toBeUndefined()
    expect(interpolator.getPosition(SELF, 100)).toBeUndefined()
  })

  it('RQ-63/GA-39(대조군): self 배제가 다른 세션의 보간 기능 자체를 죽인 게 아니다 — 같은 인터폴레이터에서 타 세션은 정상적으로 보간된다', () => {
    const interpolator: RemoteEntityInterpolator = createRemoteEntityInterpolator(SELF, 40)
    interpolator.addSnapshot(SELF, { x: 999, y: 999, z: 999, receivedAt: 0 }) // 무시되어야 한다
    interpolator.addSnapshot('other-session', { x: 0, y: 0, z: 0, receivedAt: 0 })
    interpolator.addSnapshot('other-session', { x: 10, y: 0, z: 0, receivedAt: 100 })

    // te = 90 - 40 = 50 → 정확히 중간.
    const position = interpolator.getPosition('other-session', 90)

    expect(position?.x).toBeCloseTo(5, 5)
    expect(interpolator.getPosition(SELF, 90)).toBeUndefined()
  })

  it('RQ-63: 스냅샷을 한 번도 받지 못한(존재 자체를 아직 모르는) sessionId는 undefined를 반환한다', () => {
    const interpolator: RemoteEntityInterpolator = createRemoteEntityInterpolator(SELF, 40)
    expect(interpolator.getPosition('never-seen', 1000)).toBeUndefined()
  })
})

/**
 * 리뷰 major 대응 — 세션별 보간 버퍼 프루닝 계약(`_workspace/review/feat-RQ-63-
 * interpolation.md` "보간 버퍼가 무한 성장한다" 절). `addSnapshot`이 프루닝
 * 없이 push만 하면(현재 구현) 상설 세션(RQ-04)에서 세션당 버퍼가 무한히
 * 자란다 — 두 경계 모두 `delayMs`(생성 시 이미 주입되는 값)에서 도출했으므로
 * 임의값이 아니다.
 *
 * 시나리오 공통 설정: `delayMs=100`, 20ms 간격으로 300개 스냅샷을
 * 연속으로 추가한다(receivedAt 0~5980, x=0~299 — 위치가 시간에 따라
 * 단조 증가하므로 "어느 스냅샷이 살아남았는지"가 반환값의 크기로 직접
 * 드러난다). 총 이력 길이(5980ms)는 `delayMs`의 약 60배 — 리뷰가 언급한
 * "상시 2~4개 스냅샷이면 충분"이라는 정상 동작 요구량보다 훨씬 길게
 * 실행된 세션을 흉내낸다.
 */
describe('RQ-63 리뷰 major 대응: 세션별 보간 버퍼는 무한 성장하지 않는다(프루닝 계약, delayMs에서 도출)', () => {
  const REMOTE = 'remote-long-session'
  const DELAY_MS = 100
  const ARRIVAL_INTERVAL_MS = 20
  const TOTAL_SNAPSHOTS = 300 // 5980ms 분량 — delayMs(100)의 약 60배

  function buildLongRunningInterpolator(): RemoteEntityInterpolator {
    const interpolator = createRemoteEntityInterpolator(SELF, DELAY_MS)
    for (let i = 0; i < TOTAL_SNAPSHOTS; i += 1) {
      interpolator.addSnapshot(REMOTE, { x: i, y: 0, z: 0, receivedAt: i * ARRIVAL_INTERVAL_MS })
    }
    return interpolator
  }

  it('RQ-63/리뷰 major: 최초 스냅샷의 원래 수신 시각을 조회해도("가장 오래된 스냅샷 고정" 정책 경로) 더 이상 그 스냅샷 값이 나오지 않는다 — 오래된 스냅샷이 실제로 버려졌다는 증거', () => {
    const interpolator = buildLongRunningInterpolator()

    // te = renderTime - delayMs = 0(최초 스냅샷의 원래 receivedAt). 프루닝이
    // 전혀 없다면(현재 버그) "가장 오래된 스냅샷 고정" 정책이 정확히 x=0을
    // 반환한다 — snapshot[0]이 60×delayMs가 지난 지금도 여전히 버퍼의
    // "가장 오래된" 항목이기 때문이다.
    const renderTime = DELAY_MS + 0
    const position = interpolator.getPosition(REMOTE, renderTime)

    // 관대한 상한선: 10×delayMs(=1000ms)보다 오래된 데이터는 어떤 합리적인
    // 프루닝 구현도 이 시점엔 버렸어야 한다(리뷰의 "상시 2~4개면 충분"
    // 추정보다 5~10배 여유롭다). 그렇다면 최신 스냅샷(receivedAt=5980)
    // 기준 1000ms 이내, 즉 receivedAt>=4980(index>=249)인 스냅샷만
    // "가장 오래된 생존자"로 남아있어야 한다 — x가 249 미만이면 프루닝이
    // 이 관대한 상한보다도 안 됐다는 뜻이고, 정확히 0이면 프루닝이 전혀
    // 없다는 뜻이다(현재 버그).
    expect(position?.x).toBeGreaterThanOrEqual(249)
  })

  it('RQ-63/리뷰 major: 프루닝이 있어도 delayMs 이내(정상 동작이 항상 필요로 하는 lookback)의 최근 구간은 여전히 정확하게 선형 보간된다 — 과잉 프루닝으로 GA-37이 깨지지 않는다', () => {
    const interpolator = buildLongRunningInterpolator()

    // 최신 스냅샷(index 299, receivedAt=5980)에서 75ms 전 — delayMs(100ms)
    // 이내로, 정상 동작이 항상 감당해야 하는 lookback 범위 안이다.
    // snapshot[295](receivedAt=5900,x=295)와 snapshot[296](receivedAt=5920,
    // x=296) 사이, 비율 5/20=0.25 → x = 295 + 0.25*(296-295) = 295.25.
    const targetTime = 5905
    const renderTime = targetTime + DELAY_MS
    const position = interpolator.getPosition(REMOTE, renderTime)

    expect(position?.x).toBeCloseTo(295.25, 5)
  })
})
