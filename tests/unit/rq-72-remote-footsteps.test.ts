import { describe, expect, it } from 'vitest'
import { AUDIO, NET, PLAYER } from '@shared/constants'
import { stepMovement, type MoveInput, type MoveState } from '@shared/sim/movement'
import {
  createRemoteEntityInterpolator,
  type RemoteEntityInterpolator,
  type RemoteSnapshot,
} from '@client/net/interpolation'

/**
 * RQ-72 발소리 구현 2/2-a(원격 배선) — `src/client/net/interpolation.ts` 확장
 * 단위 테스트 (ADR-0008: 순수 함수·결정론. ADR-0011: 이 라운드는 Red-first로
 * 진행 — team-lead 지시, GA-83이 반증 가능한 골든이라 Red가 실제 신호를 낸다).
 *
 * **매핑된 골든**: GA-83(`harness/evals/golden/track-a-product.jsonl`, 유일한
 * `status: todo`) — "원격 플레이어가 mode='run'으로 접지 이동 중이고, 청취자
 * 클라이언트 A는 60fps B는 20fps로 렌더한다. 두 클라이언트가 받는 서버
 * 스냅샷(30Hz)은 동일하다. 그 원격 플레이어가 굽은 경로 12.0m를 이동하면
 * 두 클라이언트가 듣는 발소리 횟수와 발생 지점이 같다."
 *
 * **이 파일이 다루지 않는 것(스코프 밖)**:
 * - **오디오 합성**(Web Audio 노이즈+엔벨로프, ADR-0014 결정 2) — 2/2-b.
 *   이 라운드 끝에도 소리는 안 난다. 이 파일은 "몇 번·어느 스냅샷에서
 *   울려야 하는가"라는 **판정**만 고정한다.
 * - `src/shared/sim/footsteps.ts`의 순수 함수 자체(`stepFootstepAccumulator`
 *   등) — 이미 `tests/unit/sim-footsteps.test.ts`(GA-77~89 중 GA-83 제외
 *   11건)가 덮는다. 이 파일은 그 함수가 **원격 스냅샷 스트림 위에서 올바르게
 *   호출되는지**(threading)만 검증한다 — 판정 로직 자체를 재검증하지 않는다.
 * - `RemoteSnapshot.mode`·`getMode`·`getPosition`·GA-37/38/39/75 — 기존
 *   `tests/unit/rq-63-interpolation.test.ts`가 이미 덮고 그대로 유효하다.
 *   이 파일은 **순증**이다(기존 파일은 건드리지 않는다).
 * - **자기 발소리**(`prediction.ts` 경로) — `stepMovement`가 매 틱 실제
 *   변위를 만들어 내므로 `sim-footsteps.test.ts`의 `driveReal` 패턴이 이미
 *   자기 경로의 판정 로직을 검증한다. 자기 쪽 **배선**(prediction.ts가
 *   `stepFootstepAccumulator`를 실제로 호출하는지)은 이 RQ의 스코프 밖
 *   판단(원장 24br)과 무관하게 이 파일이 다루는 대상이 **아니다** —
 *   `interpolation.ts` 확장만 다룬다.
 * - `src/client/net/connection.ts`가 이 모듈을 실제로 호출·배선하는지,
 *   `PlayerMeshes.tsx`가 결과를 어떻게 소비하는지 — `harness/workflow/fe.md`
 *   레벨 분리 원칙(RQ-63 test-writer 선례와 동일 근거) 그대로 배선·렌더링은
 *   면제한다.
 *
 * ---
 *
 * ## 왜 열려 있었는가 — 실측 격차(원장 24br)
 *
 * `interpolation.ts`에 `grounded`가 **0건**이었다(`InterpolationPosition`·
 * `RemoteSnapshot` 어디에도 없다) — 스키마(`GameState.ts:38`)에는 있는데
 * 보간 출력에는 없어 원격 발소리 판정에 필요한 입력(`FootstepTickInput.
 * wasGrounded`/`isGrounded`)을 만들 수 없었다. 이 파일이 그 간극을 닫는다.
 *
 * ## API 확장 계약(test-writer 지정 — coder가 아래대로 구현하면 이 파일이
 * Green이 된다. `getMode`/GA-75(원장 24az)가 확립한 "계단 함수, 위치와는
 * 다른 독립 경로" 패턴을 그대로 따른다)
 *
 * ```ts
 * export interface RemoteSnapshot extends InterpolationPosition {
 *   receivedAt: number
 *   mode?: MoveInput['mode']
 *
 *   // RQ-72 2/2(GA-83) — 발소리 누적 eligible 판정 입력. GameState.ts:38의
 *   // grounded와 동일한 의미(서버가 매 틱 권위 값을 싣는다). 옵셔널 —
 *   // 생략하면 true(GameState.grounded 기본값과 동일한 하위 호환 관례,
 *   // mode 필드와 동일 패턴 — 기존 스냅샷 리터럴 전부와 호환).
 *   grounded?: boolean
 *
 *   // RQ-72 2/2(GA-83) — 위치 불연속(리스폰) 검출 신호. GameState.ts:56의
 *   // hp와 동일한 의미. 옵셔널 — 생략하면 PLAYER.MAX_HP(GameState.hp 기본값과
 *   // 동일한 하위 호환 관례). 직전 스냅샷의 hp가 정확히 0이고 이번 스냅샷의
 *   // hp가 정확히 PLAYER.MAX_HP면 그 스냅샷 쌍은 discontinuous로 처리된다
 *   // (리스폰 — respawnPlayer가 같은 틱에 좌표·hp를 함께 대입,
 *   // GameRoom.ts:1396-1407. 사용자 결정, 원장 24br).
 *   hp?: number
 * }
 *
 * export interface RemoteEntityInterpolator {
 *   // ...(기존 addSnapshot·getPosition·copyPositionInto·getMode 그대로)...
 *
 *   // RQ-92 v2.4 패턴 재사용 — grounded의 계단 함수 조회(getMode와 동일한
 *   // 탐색·경계 정책·기본값·GA-39 계약). 렌더 시각을 감싸는 스냅샷 쌍
 *   // (from,to)을 찾으면 from.grounded를 그대로 반환한다(가중 평균 없음).
 *   // ⚠️ 아래 getFootstepCount는 이 접근자를 **쓰지 않는다** — 완전히
 *   // 독립된 경로다(바로 아래 근거).
 *   getGrounded(sessionId: string, renderTime: number): boolean | undefined
 *
 *   // RQ-72 2/2/GA-83 — 이 세션(원격 플레이어)의 누적 발소리 총 발생 횟수
 *   // (addSnapshot 호출 시점부터 지금까지 누적된 단조 증가값). **renderTime
 *   // 인자를 받지 않는다** — 이것이 GA-83의 핵심 방어선이다. getPosition/
 *   // getMode/getGrounded는 "렌더 시각을 감싸는 두 스냅샷을 그때그때
 *   // 찾아" 계산하므로 **몇 번, 언제 조회하든 항상 같은 값**을 내지만(순수
 *   // 조회), 발소리 누적은 **상태가 있는 계산**(이전 스냅샷과 이번 스냅샷의
 *   // 차분을 두 번 세면 안 된다)이라 같은 패턴을 그대로 쓰면 "조회 시점의
 *   // 렌더 시각"이 계산에 끼어들 여지가 생긴다. renderTime을 아예 인자로
 *   // 받지 않으면 그 여지가 시그니처 수준에서 사라진다 — **계산은 오직
 *   // addSnapshot 호출(서버 스냅샷 수신, 30Hz, 렌더 프레임률과 무관)에서만
 *   // 일어나고, getFootstepCount는 그 결과를 읽기만 한다.**
 *   //
 *   // 계산 규칙(addSnapshot 내부, 세션별로 "직전 스냅샷"을 별도 보관):
 *   // - 이 세션의 **첫** addSnapshot 호출이면(직전 스냅샷 없음) 발소리를
 *   //   내지 않는다 — 최초 스폰과 동일한 취급(RQ-72 "최초 스폰의 변위는
 *   //   누적하지 않는다"). 비교할 "직전"이 없으므로 discontinuous로
 *   //   본다(누적 0에서 시작, 이번 호출로 카운트가 늘지 않는다).
 *   // - 그 외: previous.hp(생략 시 PLAYER.MAX_HP)가 정확히 0이고
 *   //   current.hp(생략 시 PLAYER.MAX_HP)가 정확히 PLAYER.MAX_HP면
 *   //   그 쌍은 discontinuous=true(리스폰) — 누적을 0으로 리셋하고 이번
 *   //   호출로 카운트가 늘지 않는다.
 *   // - 그 외: `stepFootstepAccumulator`(@shared/sim/footsteps)에 아래를
 *   //   먹여 누적 상태를 전진시키고 반환된 footstepCount를 총합에 더한다.
 *   //   { wasGrounded: previous.grounded ?? true,
 *   //     isGrounded: current.grounded ?? true,
 *   //     mode: current.mode ?? 'run',
 *   //     horizontalDeltaM: Math.hypot(current.x - previous.x, current.z - previous.z),
 *   //     discontinuous: false }
 *   //   strideM은 `AUDIO.FOOTSTEP_STRIDE_M`(ADR-0010 — 값 복제 금지).
 *   //
 *   // 세션을 모르면(스냅샷을 한 번도 받지 못함) undefined — getPosition과
 *   // 동일한 GA-39 계약. selfSessionId는 addSnapshot 단계에서 이미
 *   // 무시되므로 자동으로 같은 결과(undefined)다.
 *   getFootstepCount(sessionId: string): number | undefined
 * }
 * ```
 *
 * ## 설계 결정(test-writer 재량 — GA-83·team-lead 지시가 직접 규정하지 않은 부분)
 *
 * 1. **`getFootstepCount`를 `getGrounded`(신규)와 나란히 두되 renderTime을
 *    받지 않는다** — 계산 방식의 근본적인 차이(무상태 조회 vs 유상태 누적)를
 *    시그니처로 드러낸다. 위 계약 설명 참고.
 * 2. **`getGrounded`를 새로 추가하되 `getFootstepCount`가 이를 재사용하지
 *    않는다** — team-lead 지시("grounded·hp도 계단 조회 접근자")를 따르되,
 *    `getMode`의 "왜 `computePosition`을 재사용하지 않는가"와 같은 방어
 *    논리를 한 단계 더 적용한다: `getGrounded`가 렌더 시각 기반이면
 *    `getFootstepCount`가 내부에서 그것을 불러 쓰는 순간 렌더 프레임률이
 *    다시 계산에 스며든다. 두 접근자를 물리적으로 분리해야 이 통로 자체가
 *    없어진다.
 * 3. **`getHp` 접근자는 추가하지 않는다** — `hp`는 이 라운드에서 오직
 *    discontinuous 판정의 내부 입력일 뿐, 이 라운드 범위(GA-83, 배선까지)
 *    안에 hp를 렌더 시각으로 조회해야 하는 소비자가 없다(RQ-72는 원격
 *    체력 UI를 요구하지 않는다). 필요해지면 그 소비자가 생기는 라운드가
 *    추가한다(YAGNI, CLAUDE.md 스코프 규율) — 지금 추가하면 테스트도 못
 *    받쳐주는 죽은 표면적이 된다.
 * 4. **첫 addSnapshot은 무조건 무음** — 직전 스냅샷이 없어 델타를 정의할
 *    수 없다. `discontinuous`로 취급하는 것이 "최초 스폰" 문면과 가장
 *    가깝고, `stepFootstepAccumulator`가 이미 그 분기(누적 0 유지)를
 *    지원한다.
 * 5. **`getFootstepCount`는 소진(drain)이 아니라 단조 누적 총합이다** —
 *    호출해도 상태를 소비하지 않는다(순수 읽기). 2/2-b(오디오 배선)가
 *    "직전에 관측한 값과의 차이"를 스스로 추적해 그만큼 소리를 재생하면
 *    된다 — drain 방식(호출과 동시에 리셋)은 두 소비자가 동시에 조회할 때
 *    한쪽이 다른 쪽의 몫을 가로채는 위험이 있고, 이 라운드가 그 소비자
 *    수를 규정할 근거가 없다.
 *
 * ## GA-83이 실제로 막는 함정 — 스크래치 실측(산출물 아님, 검증 후 삭제)
 *
 * 굽은 경로(직각 코너, 60틱·12.0m)를 준비해 (a) **스냅샷 델타 합**과
 * (b) **렌더 프레임 위치 표본화**(60fps/20fps 각각 `getPosition`을 호출해
 * 직전 프레임과의 거리를 누적) 두 계산법을 비교했다. 실측(zigzag 12.0m,
 * 90° 코너 16개 변형): 델타 합=6회(정확), 60fps 표본화=5회(실측
 * 11.4769m), 20fps 표본화=4회(실측 9.9394m) — **20fps가 60fps보다,
 * 60fps가 델타 합보다 체계적으로 덜 운다**(골든 본문 "20fps 쪽이 덜
 * 울린다"와 정확히 일치). 이 파일이 검증하는 API(`getFootstepCount`,
 * renderTime 미수신)는 애초에 (b) 계산 방식 자체가 불가능하도록 설계됐다
 * — 함정이 실재함을 확인한 뒤, 그 함정에 물리적으로 도달할 수 없는
 * 시그니처를 골랐다.
 *
 * ## 골든 매핑
 *
 * | 골든 | describe/it | 검증 |
 * |---|---|---|
 * | GA-83 | `RQ-72/GA-83` describe 블록 전체 | 굽은 경로 12.0m, 두 클라이언트(폴링 빈도 다름)가 총 6회·코너 지점 3회로 일치 |
 * | (threading, GA-83의 전제 보강) | eligible 판정 threading describe | mode·grounded가 원격 스냅샷에서 정확히 `stepFootstepAccumulator`로 전달되는지(순수 로직 자체는 `sim-footsteps.test.ts`가 이미 검증) |
 * | (원장 24br 사용자 결정 1) | hp 전이 describe | GA-89(리스폰 무음)의 원격 대응 |
 *
 * ## 스펙 질문 — 없음
 *
 * team-lead가 이번 라운드의 핵심 설계 축 2건(discontinuous=hp 전이, 스코프=
 * 배선까지)을 이미 확정했다. 나머지는 "네가 API를 정하라"는 위임 범위 안의
 * 결정이라 위 "설계 결정" 절에 근거를 남기고 질문 없이 진행했다.
 */

const SELF = 'self-session'
const REMOTE = 'remote-1'

/**
 * GA-83 "굽은 경로 12.0m" 시나리오 — 실제 `stepMovement`를 재생해(round-1
 * `driveReal` 패턴과 동일 근거: floating-point 반올림 양상이 상수 반복
 * 가산과 다르다) 30틱 +x·30틱 +z(직각 코너, run·접지)로 서버 30Hz 스냅샷을
 * 재현한다. 인덱스 0이 최초 스냅샷(베이스라인), 인덱스 30이 코너, 인덱스
 * 60이 종점 — 실측 총 이동거리 ≈12.0m(1e-13 오차, FP), 발소리 정확히 6회,
 * 코너(인덱스 30) 시점 누적 3회(node 스크래치 프로브로 실측·검증됨, 아래
 * "전제 확인" 테스트가 그 실측을 코드로 고정한다).
 */
function buildCornerPathSnapshots(): RemoteSnapshot[] {
  const RUN_X: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
  const RUN_Z: MoveInput = { dirX: 0, dirZ: 1, mode: 'run', jump: false }

  const snapshots: RemoteSnapshot[] = []
  let s: MoveState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true }
  snapshots.push({ x: s.x, y: s.y, z: s.z, receivedAt: 0, mode: 'run', grounded: true })

  for (let i = 1; i <= 30; i++) {
    s = stepMovement(s, RUN_X)
    snapshots.push({ x: s.x, y: s.y, z: s.z, receivedAt: i * NET.TICK_MS, mode: 'run', grounded: true })
  }
  for (let i = 31; i <= 60; i++) {
    s = stepMovement(s, RUN_Z)
    snapshots.push({ x: s.x, y: s.y, z: s.z, receivedAt: i * NET.TICK_MS, mode: 'run', grounded: true })
  }
  return snapshots
}

describe('RQ-72/GA-83: 원격 발소리 — 스냅샷 델타 기반이라 렌더 프레임률·폴링 빈도와 무관하다', () => {
  it('전제 확인 — 코너(직각) 있는 60틱 경로의 실측 총 수평 이동거리가 12.0m다(부동소수점 오차 이내)', () => {
    const snapshots = buildCornerPathSnapshots()
    let total = 0
    for (let i = 1; i < snapshots.length; i++) {
      total += Math.hypot(snapshots[i]!.x - snapshots[i - 1]!.x, snapshots[i]!.z - snapshots[i - 1]!.z)
    }
    expect(total).toBeCloseTo(12.0, 9)
  })

  it('GA-83: 서버 스냅샷(30Hz)이 동일한 두 클라이언트(A: 매 스냅샷마다 폴링 ≈60fps, B: 3개마다 1번 폴링 ≈20fps)가 최종적으로 동일한 총 발소리 수(6회 = 12.0m ÷ 2.0m)를 관측한다', () => {
    const snapshots = buildCornerPathSnapshots()
    const interpolatorA = createRemoteEntityInterpolator(SELF, 50) // 클라이언트 A(별도 인스턴스)
    const interpolatorB = createRemoteEntityInterpolator(SELF, 50) // 클라이언트 B(별도 인스턴스) — 동일 서버 스냅샷을 받는다

    for (let i = 0; i < snapshots.length; i++) {
      // 두 클라이언트 모두 서버가 보낸 것과 동일한 스냅샷을 받는다(ADR-0014
      // 결정 1 — @filter 0건이라 정보량이 클라마다 다르지 않다).
      interpolatorA.addSnapshot(REMOTE, snapshots[i]!)
      interpolatorB.addSnapshot(REMOTE, snapshots[i]!)

      // A는 스냅샷이 도착할 때마다 폴링("60fps"). B는 3개마다 1번만
      // 폴링("20fps" — 60개 스냅샷 구간에 20회 폴링, 60:20 = 3:1 비율).
      interpolatorA.getFootstepCount(REMOTE)
      if (i % 3 === 2) {
        interpolatorB.getFootstepCount(REMOTE)
      }
    }

    const expectedTotal = Math.floor(12.0 / AUDIO.FOOTSTEP_STRIDE_M)
    expect(interpolatorA.getFootstepCount(REMOTE)).toBe(expectedTotal)
    expect(interpolatorB.getFootstepCount(REMOTE)).toBe(expectedTotal)
  })

  it('GA-83 "발생 지점이 같다" — 코너 지점(인덱스 30)에서 폴링해도 두 클라이언트가 동일한 중간값(3회)을 관측한다(끝에서만 우연히 맞는 것이 아니다)', () => {
    const snapshots = buildCornerPathSnapshots()
    const interpolatorA = createRemoteEntityInterpolator(SELF, 50)
    const interpolatorB = createRemoteEntityInterpolator(SELF, 50)

    let countAtCornerA: number | undefined
    let countAtCornerB: number | undefined

    for (let i = 0; i < snapshots.length; i++) {
      interpolatorA.addSnapshot(REMOTE, snapshots[i]!)
      interpolatorB.addSnapshot(REMOTE, snapshots[i]!)

      if (i === 30) {
        // A는 코너에서 즉시 폴링(매 스냅샷 폴링 패턴), B는 인덱스 30이
        // 3의 배수(30 % 3 === 0, 즉 i % 3 === 2 조건과는 다른 위상이라
        // B의 "정규" 폴링 시점은 아니다 — 그래도 지금 당장 조회하면
        // A와 같은 값이 나와야 한다. 이것이 "폴링 시점이 값에 영향을
        // 주지 않는다"는 계약의 핵심이다.
        countAtCornerA = interpolatorA.getFootstepCount(REMOTE)
        countAtCornerB = interpolatorB.getFootstepCount(REMOTE)
      }
    }

    expect(countAtCornerA).toBe(3)
    expect(countAtCornerB).toBe(3)
  })

  it('여러 원격 세션의 발소리 누적은 서로 독립적이다(한 인스턴스가 다중 세션을 다중화 — 기존 buffers 설계와 동일한 축)', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, 50)
    interpolator.addSnapshot('remote-A', { x: 0, y: 0, z: 0, receivedAt: 0, mode: 'run', grounded: true })
    interpolator.addSnapshot('remote-B', { x: 0, y: 0, z: 0, receivedAt: 0, mode: 'run', grounded: true })
    interpolator.addSnapshot('remote-A', { x: 4, y: 0, z: 0, receivedAt: 1000, mode: 'run', grounded: true }) // 4.0m
    interpolator.addSnapshot('remote-B', { x: 1, y: 0, z: 0, receivedAt: 1000, mode: 'run', grounded: true }) // 1.0m

    expect(interpolator.getFootstepCount('remote-A')).toBe(2)
    expect(interpolator.getFootstepCount('remote-B')).toBe(0)
  })
})

describe('RQ-72 2/2: 세션의 첫 addSnapshot은 발소리를 발생시키지 않는다(직전 스냅샷이 없다 — 최초 스폰과 동일 취급)', () => {
  it('첫 스냅샷은 좌표가 무엇이든 즉시 조회하면 0이다', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, 50)
    interpolator.addSnapshot(REMOTE, { x: 999, y: 0, z: 999, receivedAt: 0, mode: 'run', grounded: true })
    expect(interpolator.getFootstepCount(REMOTE)).toBe(0)
  })
})

describe('RQ-72 2/2: eligible 판정이 스냅샷 필드를 정확히 threading한다(mode·grounded — 순수 로직 자체는 sim-footsteps.test.ts가 검증)', () => {
  it('mode=\'walk\' 원격 스냅샷은 큰 변위가 있어도 발소리가 0회다', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, 50)
    interpolator.addSnapshot(REMOTE, { x: 0, y: 0, z: 0, receivedAt: 0, mode: 'walk', grounded: true })
    interpolator.addSnapshot(REMOTE, { x: 10, y: 0, z: 0, receivedAt: 1000, mode: 'walk', grounded: true }) // 10m
    expect(interpolator.getFootstepCount(REMOTE)).toBe(0)
  })

  it('grounded=false(공중) 구간은 큰 변위가 있어도 발소리가 0회다', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, 50)
    interpolator.addSnapshot(REMOTE, { x: 0, y: 5, z: 0, receivedAt: 0, mode: 'run', grounded: false })
    interpolator.addSnapshot(REMOTE, { x: 10, y: 5, z: 0, receivedAt: 1000, mode: 'run', grounded: false }) // 10m
    expect(interpolator.getFootstepCount(REMOTE)).toBe(0)
  })

  it('접지→공중 전이 스냅샷 쌍(이함)의 변위는 누적되지 않는다(GA-85 원격 대응 — 시작·끝 모두 grounded여야 eligible)', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, 50)
    interpolator.addSnapshot(REMOTE, { x: 0, y: 0, z: 0, receivedAt: 0, mode: 'run', grounded: true })
    interpolator.addSnapshot(REMOTE, { x: 5, y: 1, z: 0, receivedAt: 1000, mode: 'run', grounded: false }) // 이함, 5m
    expect(interpolator.getFootstepCount(REMOTE)).toBe(0)
  })

  it('grounded 필드를 생략해도 기본값 true로 취급되어 정상 카운트된다(하위 호환 — 기존 스냅샷 리터럴과의 호환)', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, 50)
    interpolator.addSnapshot(REMOTE, { x: 0, y: 0, z: 0, receivedAt: 0, mode: 'run' }) // grounded 생략
    interpolator.addSnapshot(REMOTE, { x: 4, y: 0, z: 0, receivedAt: 1000, mode: 'run' }) // grounded 생략, 4m
    expect(interpolator.getFootstepCount(REMOTE)).toBe(2)
  })
})

describe('RQ-72 2/2/hp 전이(정확히 0→PLAYER.MAX_HP) — 리스폰 순간이동을 발소리로 오인하지 않는다(GA-89 원격 대응, 원장 24br 사용자 결정)', () => {
  it('사망 전 누적이 남아있어도 리스폰 순간이동(hp 0→MAX_HP, 20m 점프)은 발소리를 내지 않고 누적을 리셋한다', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, 50)

    // 최초 관측(베이스라인) — hp=100, 발소리 없음(첫 스냅샷 규칙).
    interpolator.addSnapshot(REMOTE, { x: 0, y: 0, z: 0, receivedAt: 0, mode: 'run', grounded: true, hp: 100 })
    // run으로 1.8m 이동(2.0m 미만 — 아직 무음).
    interpolator.addSnapshot(REMOTE, { x: 1.8, y: 0, z: 0, receivedAt: 1000, mode: 'run', grounded: true, hp: 100 })
    expect(interpolator.getFootstepCount(REMOTE)).toBe(0)

    // 사망(hp 100→0), 같은 자리 — discontinuous 조건(직전 hp===0)을 아직
    // 만족하지 않는다(이번 스냅샷 자체가 0이 되는 전이라 "직전이 0"이 아니다).
    interpolator.addSnapshot(REMOTE, { x: 1.8, y: 0, z: 0, receivedAt: 1033, mode: 'run', grounded: true, hp: 0 })
    expect(interpolator.getFootstepCount(REMOTE)).toBe(0)

    // 리스폰 — 직전 hp===0, 이번 hp===PLAYER.MAX_HP(정확히 일치) → discontinuous.
    // 좌표는 20m 떨어진 스폰 지점으로 순간이동.
    interpolator.addSnapshot(REMOTE, {
      x: 21.8,
      y: 0,
      z: 0,
      receivedAt: 4033,
      mode: 'run',
      grounded: true,
      hp: PLAYER.MAX_HP,
    })
    expect(interpolator.getFootstepCount(REMOTE)).toBe(0) // 20m 순간이동이 누적되지 않았다

    // 부활 후 소량 이동(0.4m) — 2.0m에 못 미쳐 여전히 무음(리셋이 실제로 됐다는 증거).
    interpolator.addSnapshot(REMOTE, {
      x: 22.2,
      y: 0,
      z: 0,
      receivedAt: 4066,
      mode: 'run',
      grounded: true,
      hp: PLAYER.MAX_HP,
    })
    expect(interpolator.getFootstepCount(REMOTE)).toBe(0)
  })

  it('리스폰 이후 발소리는 정상적으로 다시 쌓인다(리셋이 영구 정지가 아니다)', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, 50)
    interpolator.addSnapshot(REMOTE, { x: 0, y: 0, z: 0, receivedAt: 0, mode: 'run', grounded: true, hp: 0 })
    interpolator.addSnapshot(REMOTE, {
      x: 20,
      y: 0,
      z: 0,
      receivedAt: 33,
      mode: 'run',
      grounded: true,
      hp: PLAYER.MAX_HP,
    }) // 리스폰(직전 hp===0 충족)
    interpolator.addSnapshot(REMOTE, {
      x: 24,
      y: 0,
      z: 0,
      receivedAt: 1033,
      mode: 'run',
      grounded: true,
      hp: PLAYER.MAX_HP,
    }) // 4.0m 추가 이동
    expect(interpolator.getFootstepCount(REMOTE)).toBe(2)
  })

  it('hp 필드를 계속 생략해도(기본값 PLAYER.MAX_HP) 리스폰으로 오검출되지 않는다 — 정상 이동이 그대로 카운트된다', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, 50)
    interpolator.addSnapshot(REMOTE, { x: 0, y: 0, z: 0, receivedAt: 0, mode: 'run', grounded: true }) // hp 생략
    interpolator.addSnapshot(REMOTE, { x: 4, y: 0, z: 0, receivedAt: 1000, mode: 'run', grounded: true }) // hp 생략, 4m
    expect(interpolator.getFootstepCount(REMOTE)).toBe(2)
  })
})

describe('RQ-72 2/2: getFootstepCount의 GA-39 계약(자기 자신 제외·미지 세션 undefined — 기존 getPosition/getMode와 동일)', () => {
  it('selfSessionId로 addSnapshot을 호출해도 무시되고(GA-39, 기존 계약), getFootstepCount도 undefined다', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, 50)
    interpolator.addSnapshot(SELF, { x: 0, y: 0, z: 0, receivedAt: 0, mode: 'run', grounded: true })
    interpolator.addSnapshot(SELF, { x: 10, y: 0, z: 0, receivedAt: 1000, mode: 'run', grounded: true })
    expect(interpolator.getFootstepCount(SELF)).toBeUndefined()
  })

  it('스냅샷을 한 번도 받지 못한 sessionId는 getFootstepCount도 undefined다', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, 50)
    expect(interpolator.getFootstepCount('never-seen')).toBeUndefined()
  })
})

describe('RQ-72 2/2: RemoteSnapshot.grounded 계단 함수 접근자 getGrounded — getMode(GA-75)와 동일한 패턴', () => {
  const T1 = 0
  const T2 = 100
  const DELAY_MS = 20

  function buildGroundedInterpolator(): RemoteEntityInterpolator {
    const interpolator = createRemoteEntityInterpolator(SELF, DELAY_MS)
    interpolator.addSnapshot(REMOTE, { x: 0, y: 0, z: 0, receivedAt: T1, grounded: true })
    interpolator.addSnapshot(REMOTE, { x: 10, y: 0, z: 0, receivedAt: T2, grounded: false })
    return interpolator
  }

  it('T1~T2 사이 모든 중간 렌더 시각에서 getGrounded가 true(from 값)다 — 중간값(블렌딩)이 없다', () => {
    const interpolator = buildGroundedInterpolator()
    for (let targetTime = T1; targetTime < T2; targetTime += 5) {
      expect(interpolator.getGrounded(REMOTE, targetTime + DELAY_MS)).toBe(true)
    }
  })

  it('renderTime이 T2(=false 스냅샷의 receivedAt)에 도달하는 순간 즉시 false로 바뀌고 그 이후로도 계속 false다', () => {
    const interpolator = buildGroundedInterpolator()
    expect(interpolator.getGrounded(REMOTE, T2 + DELAY_MS)).toBe(false)
    expect(interpolator.getGrounded(REMOTE, T2 + DELAY_MS + 500)).toBe(false)
  })

  it('경계: 스냅샷이 1개뿐이면 그 grounded 값으로 고정된다(렌더 시각이 앞서든 뒤서든)', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, 30)
    interpolator.addSnapshot('solo', { x: 0, y: 0, z: 0, receivedAt: 100, grounded: false })
    expect(interpolator.getGrounded('solo', 100)).toBe(false)
    expect(interpolator.getGrounded('solo', 1000)).toBe(false)
    expect(interpolator.getGrounded('solo', 0)).toBe(false)
  })

  it('경계: grounded를 생략한 스냅샷은 기본값 true로 취급된다(하위 호환 — 기존 리터럴과의 호환 근거)', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, 10)
    interpolator.addSnapshot('legacy', { x: 0, y: 0, z: 0, receivedAt: 0 }) // grounded 생략
    expect(interpolator.getGrounded('legacy', 10)).toBe(true)
  })

  it('GA-39와 동일한 계약 — 자기 자신·미지 세션은 undefined', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, 40)
    interpolator.addSnapshot(SELF, { x: 0, y: 0, z: 0, receivedAt: 0, grounded: true })
    expect(interpolator.getGrounded(SELF, 0)).toBeUndefined()
    expect(interpolator.getGrounded('never-seen', 1000)).toBeUndefined()
  })
})
