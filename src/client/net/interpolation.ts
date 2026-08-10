/**
 * RQ-63 다른 플레이어 보간(entity interpolation) — 순수 로직 (ADR-0003 지연
 * 버퍼, ADR-0008 결정론). `harness/workflow/fe.md`의 레이어 표가 "다른
 * 플레이어 보간(RQ-62/63)"을 netcode 레이어(`src/client/net/`) 책임으로
 * 명시하는 배치를 따른다.
 *
 * 이 모듈은 `Math.random()`·`Date.now()`·`performance.now()`를 직접 호출하지
 * 않는다 — 스냅샷 수신 시각(`RemoteSnapshot.receivedAt`)과 조회 시각
 * (`getPosition`/`copyPositionInto`의 `renderTime`)은 전부 호출자가 값으로
 * 주입한다. 실제 시각 소스(성능 시계)를 읽는 것은 배선 계층
 * (`src/client/net/connection.ts`)의 책임이다.
 *
 * ADR-0003: 원격 엔티티는 항상 최신 스냅샷보다 "한 스냅샷 간격 이상"
 * (약 33~66ms) 뒤처진 시점을 그린다 — 두 스냅샷 사이를 보간할 여유를
 * 확보해야 스터터 없이 매끄러운 움직임이 나온다. 보간할 두 스냅샷이 없는
 * 경계(스냅샷 1개뿐 / 지연 반영 렌더 시각이 버퍼 범위 밖)에서는 항상
 * "고정(freeze)" — 외삽(dead reckoning)은 ADR-0003이 명시적으로 기각한
 * 대안이다.
 *
 * 상세 계약·설계 근거·경계 정책은 `tests/unit/rq-63-interpolation.test.ts`
 * 상단 주석과 `_workspace/RQ-63/01_test-writer_red.md` §2·§3을 참고.
 */

import { AUDIO, PLAYER } from '@shared/constants'
import type { MoveInput } from '@shared/sim/movement'
import { stepFootstepAccumulator } from '@shared/sim/footsteps'

export interface InterpolationPosition {
  x: number
  y: number
  z: number
}

export interface RemoteSnapshot extends InterpolationPosition {
  /** 이 스냅샷을 수신한 시각(ms, 임의의 단조 증가 시각 축) — 값으로 주입. */
  receivedAt: number
  /** RQ-92 v2.4(원장 24az, GA-75) — 이 스냅샷 시점의 서버 확정 자세.
   * 옵셔널 — 생략하면 `'run'`(기존 스냅샷 리터럴 전부와의 하위 호환,
   * 순증 규칙). **위치와 달리 보간하지 않는다** — `getMode`(아래) 참고. */
  mode?: MoveInput['mode']
  /** RQ-72 2/2(GA-83) — 이 스냅샷 시점의 서버 확정 접지 여부
   * (`GameState.grounded`와 동일 의미). 옵셔널 — 생략하면 `true`(기존
   * 스냅샷 리터럴 전부와의 하위 호환, `mode`와 동일 관례). 발소리 누적
   * eligible 판정(`getFootstepCount`)의 입력이자, `getGrounded`(아래)로도
   * 조회할 수 있다. */
  grounded?: boolean
  /** RQ-72 2/2(GA-83) — 이 스냅샷 시점의 서버 확정 체력(`GameState.hp`와
   * 동일 의미). 옵셔널 — 생략하면 `PLAYER.MAX_HP`(`mode`·`grounded`와
   * 동일 관례). 오직 위치 불연속(리스폰) 검출의 내부 입력이다 — 이
   * 라운드에는 hp 자체를 렌더 시각으로 조회하는 별도 접근자가 없다
   * (소비자 없음, YAGNI). 직전 스냅샷의 hp가 정확히 0이고 이번 스냅샷의
   * hp가 정확히 `PLAYER.MAX_HP`면 그 쌍은 리스폰으로 간주해 발소리 누적을
   * 0으로 리셋한다(`GameRoom.ts`의 `respawnPlayer`가 같은 틱에 좌표·hp를
   * 함께 대입하므로 좌표 점프가 이동으로 오검출되지 않는다). */
  hp?: number
}

export interface RemoteEntityInterpolator {
  /**
   * 다른 플레이어의 서버 스냅샷을 시각과 함께 버퍼에 추가한다(GA-37/38).
   * `sessionId`가 생성 시 지정한 `selfSessionId`와 같으면 무시한다(GA-39 —
   * 자기 자신은 이 경로에 진입하지 않는다. 예측(RQ-62,
   * `createClientPredictor`)이 그 역할을 대신한다). 같은 sessionId에 대해
   * `receivedAt` 오름차순으로 호출된다고 가정한다(ADR-0002, WebSocket/TCP
   * 순서 보장 — 재정렬 처리는 이 모듈의 계약 밖).
   */
  addSnapshot(sessionId: string, snapshot: RemoteSnapshot): void

  /**
   * 주어진 렌더 시각(ms)에서 표시할 위치를 계산해 **새 객체**로 반환한다.
   * - GA-37: 두 스냅샷이 지연 반영 렌더 시각을 감싸면 그 구간의 선형 보간.
   * - GA-38: 스냅샷이 몇 개든, 도착 간격이 불규칙하든 연속적인 함수값.
   * - 경계: 스냅샷이 1개뿐이면 그 위치로 고정. 지연 반영 렌더 시각이 최신
   *   스냅샷보다 앞서면 최신 위치로, 가장 오래된 스냅샷보다도 이전이면 그
   *   위치로 고정한다(외삽 금지, ADR-0003).
   * - GA-39: `sessionId`가 `selfSessionId`와 같거나, 그 `sessionId`에 대해
   *   스냅샷이 한 번도 추가된 적 없으면 `undefined`.
   */
  getPosition(sessionId: string, renderTime: number): InterpolationPosition | undefined

  /**
   * `getPosition`과 동일한 계산 결과를 `out`에 덮어써 반환하되, 새 객체를
   * 할당하지 않는다(`harness/workflow/fe.md` 프레임 예산 — `useFrame` 안에서
   * 매 프레임 호출해도 GC 압박이 없다). 렌더 배선(`PlayerMeshes.tsx`) 전용
   * 진입점이다 — 단위 테스트 계약은 `getPosition`만 다룬다. 위치가 없으면
   * (GA-39, 미지의 세션) `out`을 건드리지 않고 `false`를 반환한다.
   */
  copyPositionInto(sessionId: string, renderTime: number, out: InterpolationPosition): boolean

  /**
   * RQ-92 v2.4(원장 24az, GA-75) — 주어진 렌더 시각에서의 자세.
   * **위치(`getPosition`)와 다른 점 — 선형 보간하지 않고 step(계단) 함수로
   * 조회한다**: 렌더 시각을 감싸는 스냅샷 쌍 `(from, to)`을 찾으면(위치와
   * 같은 탐색) `from.mode`를 그대로 반환한다(가중 평균하지 않는다 —
   * targetTime이 `from.receivedAt`과 `to.receivedAt` 사이에 있는 한, "그
   * 순간까지 알려진 최신 자세"는 아직 `to`가 도착하기 전인 `from`의 값이다).
   * 경계 정책은 위치와 동일하게 통일한다: 스냅샷 1개뿐이면 그 값, 렌더
   * 시각이 최신보다 앞서면 최신 값, 가장 오래된 스냅샷보다도 이전이면 그
   * 값(모두 "고정"). 세션 자체를 모르면(스냅샷을 한 번도 받지 못함)
   * `undefined` — `getPosition`과 동일한 GA-39 계약.
   *
   * **왜 위치용 가중 평균 코드(`computePosition`)를 재사용하지 않고 별도
   * 경로를 두는가**: 자세를 그 같은 가중 평균 코드에 태우면(예: 문자열을
   * 숫자 코드로 바꿔 `from + (to-from)*t`류로 확장) 그 순간 중간값이 생겨
   * "자세는 보간하지 않는다"(RQ-92 v2.4 본문, RQ-63 예외)가 정면으로
   * 깨진다 — 구조적으로 분리된 함수 자체가 위치용 가중 평균 경로에 자세가
   * 물리적으로 들어갈 자리를 없앤다(`hitboxForMode` 선례 "값 선택은 순수
   * 함수, 배선은 면제"의 반대 축 방어).
   */
  getMode(sessionId: string, renderTime: number): MoveInput['mode'] | undefined

  /**
   * RQ-72 2/2(GA-83) — 주어진 렌더 시각에서의 접지 여부. `getMode`(GA-75)와
   * 완전히 동일한 계단 함수 조회 패턴 — 렌더 시각을 감싸는 스냅샷 쌍
   * `(from, to)`을 찾으면 `from.grounded`를 그대로 반환한다(가중 평균 없음).
   * 경계 정책도 위치·자세와 동일(스냅샷 1개뿐이면 그 값, 최신보다 앞서면
   * 최신 값, 가장 오래된 스냅샷보다도 이전이면 그 값 — 모두 "고정").
   * 세션을 모르면(스냅샷을 한 번도 받지 못함) `undefined` — `getPosition`/
   * `getMode`와 동일한 GA-39 계약.
   *
   * ⚠️ `getFootstepCount`(아래)는 이 접근자를 재사용하지 않는다 — 완전히
   * 독립된 경로다(발소리 누적은 렌더 시각과 무관해야 하므로, 렌더 시각
   * 기반 조회를 내부에서 부르면 그 통로로 프레임률이 다시 스며든다).
   */
  getGrounded(sessionId: string, renderTime: number): boolean | undefined

  /**
   * RQ-72 2/2(GA-83) — 이 세션(원격 플레이어)의 누적 발소리 총 발생 횟수
   * (`addSnapshot` 호출 시점부터 지금까지 누적된 단조 증가값). **`renderTime`
   * 인자를 받지 않는다** — 이것이 GA-83의 핵심 방어선이다. `getPosition`/
   * `getMode`/`getGrounded`는 "렌더 시각을 감싸는 두 스냅샷을 그때그때
   * 찾아" 계산하는 무상태 조회라 몇 번을 조회하든 항상 같은 값을 내지만,
   * 발소리 누적은 유상태 계산(같은 델타를 두 번 세면 안 된다)이다 —
   * 렌더 시각을 인자로 받지 않으면 "조회 시점의 렌더 시각"이 계산에 끼어들
   * 통로가 시그니처 수준에서 사라진다. 계산은 오직 `addSnapshot`(서버
   * 스냅샷 수신, 렌더 프레임률과 무관)에서만 일어나고, 이 접근자는
   * 그 결과를 읽기만 한다(소진(drain)이 아니라 순수 읽기 — 여러 소비자가
   * 동시에 읽어도 서로 간섭하지 않는다).
   *
   * 세션을 모르면(스냅샷을 한 번도 받지 못함) `undefined` — `getPosition`과
   * 동일한 GA-39 계약. `selfSessionId`는 `addSnapshot` 단계에서 이미
   * 무시되므로 자동으로 같은 결과(`undefined`)다.
   */
  getFootstepCount(sessionId: string): number | undefined
}

interface RemoteBuffer {
  /** `receivedAt` 오름차순 — `addSnapshot` 계약의 순서 가정을 그대로 따른다. */
  snapshots: RemoteSnapshot[]
  /** RQ-72 2/2(GA-83) — 발소리 누적 상태. `snapshots`(보간용, 렌더 시각
   * 조회에 쓰임)와 물리적으로 분리된 별도 상태다 — `getFootstepCount`가
   * `renderTime`을 받지 않는 이유(위 인터페이스 docblock)와 짝을 이룬다.
   * `addSnapshot` 호출 시점에만 전진하고, 렌더 프레임 조회는 이 상태를
   * 절대 건드리지 않는다. */
  footstep: {
    /** 직전 `addSnapshot` 호출의 스냅샷(델타 계산용 "직전 상태"). 이
     * 세션의 첫 `addSnapshot`이면 `undefined` — 비교할 직전이 없으므로
     * 최초 스폰과 동일하게 무음 처리한다. */
    previous: RemoteSnapshot | undefined
    /** `stepFootstepAccumulator`가 다음 호출로 이어서 쓰는 잔여 누적
     * 거리(m, 보폭 미달분). */
    accumM: number
    /** 누적 발소리 총 발생 횟수(단조 증가) — `getFootstepCount`가 그대로
     * 반환한다. */
    totalCount: number
  }
}

/**
 * RQ-72 2/2(GA-83) — 세션의 새 스냅샷 한 개를 발소리 누적 상태에 먹인다.
 * `addSnapshot` 호출마다(서버 스냅샷 수신) 정확히 한 번 호출된다 —
 * 렌더 프레임(`getPosition`/`getGrounded` 등)과는 완전히 무관한 경로다.
 *
 * 판정 순서(전문은 `RemoteEntityInterpolator.getFootstepCount` docblock):
 * 1. 직전 스냅샷이 없으면(첫 호출) 무음 — 최초 스폰과 동일 취급.
 * 2. 직전 hp(생략 시 `PLAYER.MAX_HP`)가 정확히 0이고 이번 hp(생략 시
 *    `PLAYER.MAX_HP`)가 정확히 `PLAYER.MAX_HP`면 리스폰 — `discontinuous`로
 *    `stepFootstepAccumulator`에 넘겨 누적을 0으로 리셋한다.
 * 3. 그 외 — 두 스냅샷의 수평 거리(`Math.hypot`)와 grounded·mode(둘 다
 *    생략 시 기본값)를 `stepFootstepAccumulator`(`@shared/sim/footsteps`,
 *    순수 판정 로직 자체는 `sim-footsteps.test.ts`가 검증)에 먹여 누적을
 *    전진시킨다. `strideM`은 `AUDIO.FOOTSTEP_STRIDE_M`(ADR-0010 — 값 복제
 *    금지).
 */
function advanceFootstepAccumulator(state: RemoteBuffer['footstep'], snapshot: RemoteSnapshot): void {
  const previous = state.previous
  state.previous = snapshot

  if (!previous) return // 첫 addSnapshot — 최초 스폰과 동일 취급, 무음.

  const previousHp = previous.hp ?? PLAYER.MAX_HP
  const currentHp = snapshot.hp ?? PLAYER.MAX_HP
  const discontinuous = previousHp === 0 && currentHp === PLAYER.MAX_HP

  const result = stepFootstepAccumulator(
    state.accumM,
    {
      wasGrounded: previous.grounded ?? true,
      isGrounded: snapshot.grounded ?? true,
      mode: snapshot.mode ?? 'run',
      horizontalDeltaM: Math.hypot(snapshot.x - previous.x, snapshot.z - previous.z),
      discontinuous,
    },
    AUDIO.FOOTSTEP_STRIDE_M,
  )

  state.accumM = result.accumM
  state.totalCount += result.footstepCount
}

/**
 * 세션별 버퍼 프루닝 윈도우 배수(리뷰 major 대응, `_workspace/review/
 * feat-RQ-63-interpolation.md` "보간 버퍼가 무한 성장한다" — 상설 세션
 * (RQ-04)에서 `addSnapshot`이 프루닝 없이 계속 `push`만 하면 세션당 버퍼가
 * 무한히 자라 메모리·조회 비용(§ 아래 `computePosition`) 모두 세션
 * 길이에 비례해 나빠진다).
 *
 * 정상 동작은 `delayMs` 하나 남짓의 lookback만 있으면 충분하다(상시
 * 스냅샷 2~4개, ADR-0003 지연 버퍼). 10배 여유를 둔 이유는 통상적인
 * 지터·전송 간격 편차(GA-38)에서도 절대 과잉 프루닝으로 정상 보간
 * (GA-37)이 깨지지 않게 하기 위해서다 — 이 여유값은 리뷰 대응 Red
 * (`tests/unit/rq-63-interpolation.test.ts` "리뷰 major 대응" describe,
 * "10×delayMs 관대한 상한" 근거)와 동일한 배수다.
 */
const PRUNE_WINDOW_MULTIPLIER = 10

/**
 * 세션 버퍼에서 최신 수신 시각 기준 `delayMs * PRUNE_WINDOW_MULTIPLIER`보다
 * 오래된 스냅샷을 버린다. `addSnapshot` 호출 직후에만 실행한다 — 스냅샷
 * 수신(⚠️ **약 20Hz** — `GameRoom`이 `patchRate`를 설정하지 않아 Colyseus
 * 기본값 `1e3/20`이 쓰인다. 서버 **틱**은 30Hz지만 상태 패치는 그보다
 * 성기다. 원장 **24bu** 참고)마다 한 번이면 충분하고, `useFrame`(60fps × 원격 최대 9명)
 * 경로에는 없다. `snapshots`는 `receivedAt` 오름차순이라 맨 앞부터 지우면
 * 되고, 항상 최소 1개는 남긴다 — `computePosition`의 "스냅샷 1개뿐" 고정
 * 정책이 빈 배열을 절대 보지 않아야 한다.
 */
function pruneBuffer(buffer: RemoteBuffer, delayMs: number): void {
  const { snapshots } = buffer
  const newest = snapshots[snapshots.length - 1]
  if (!newest) return

  const cutoff = newest.receivedAt - delayMs * PRUNE_WINDOW_MULTIPLIER
  while (snapshots.length > 1 && snapshots[0]!.receivedAt < cutoff) {
    snapshots.shift()
  }
}

/**
 * 보간할 두 스냅샷이 없을 때의 "고정(freeze)" 정책(외삽 금지, ADR-0003) 및
 * 구간 선형 보간을 계산해 `out`에 쓴다. `getPosition`·`copyPositionInto`가
 * 이 함수 하나를 공유한다 — 계산 로직 중복을 피한다.
 */
function computePosition(buffer: RemoteBuffer, targetTime: number, out: InterpolationPosition): void {
  const { snapshots } = buffer

  if (snapshots.length === 1) {
    const only = snapshots[0]!
    out.x = only.x
    out.y = only.y
    out.z = only.z
    return
  }

  const oldest = snapshots[0]!
  const newest = snapshots[snapshots.length - 1]!

  if (targetTime <= oldest.receivedAt) {
    // 가장 오래된 스냅샷보다도 이전(접속 직후 등) — 외삽하지 않고 고정.
    out.x = oldest.x
    out.y = oldest.y
    out.z = oldest.z
    return
  }
  if (targetTime >= newest.receivedAt) {
    // 최신 스냅샷보다 앞섬(스냅샷 기아 등) — 외삽하지 않고 고정.
    out.x = newest.x
    out.y = newest.y
    out.z = newest.z
    return
  }

  // targetTime이 (oldest, newest) 구간 내부임이 위에서 보장된다 — 그 값을
  // 실제로 감싸는 인접 스냅샷 쌍을 찾아 선형 보간한다.
  //
  // 최신 끝에서 역방향으로 스캔한다(리뷰 major 대응 — 원래는 최고참부터
  // 정방향 스캔이라 매 조회가 O(n)이었다). ADR-0003 지연 버퍼(delayMs)는
  // 정의상 "한 스냅샷 간격 남짓"만큼만 과거를 보므로, targetTime은 거의
  // 항상 버퍼 최신 끝 근처에 있다 — 정상 상황(스냅샷 기아·지터가 아닌 한)
  // 첫 반복(i = length-2)에서 바로 찾아 O(1)에 수렴한다. `pruneBuffer`가
  // n을 이미 유계로 만들었으므로(위 §) 최악의 경우도 무한정 커지지 않는다.
  for (let i = snapshots.length - 2; i >= 0; i -= 1) {
    const from = snapshots[i]!
    const to = snapshots[i + 1]!
    if (targetTime < from.receivedAt) continue

    const span = to.receivedAt - from.receivedAt
    const t = span > 0 ? (targetTime - from.receivedAt) / span : 0
    out.x = from.x + (to.x - from.x) * t
    out.y = from.y + (to.y - from.y) * t
    out.z = from.z + (to.z - from.z) * t
    return
  }

  // 위 경계 검사로 targetTime이 (oldest, newest) 안임이 보장되므로 도달
  // 불가 — TS 문맥 안전을 위한 방어적 폴백일 뿐이다.
  out.x = newest.x
  out.y = newest.y
  out.z = newest.z
}

/**
 * RQ-92 v2.4(원장 24az, GA-75) — `computePosition`과 같은 경계 탐색을
 * 쓰지만 선형 보간이 아니라 **step(계단) 함수**로 자세를 조회한다(위
 * `getMode` docblock 참고). 위치·자세가 같은 스냅샷 배열을 공유하되 서로
 * 다른 순수 함수로 소비되므로, 자세가 위치의 가중 평균 계산에 물리적으로
 * 섞일 자리가 없다.
 */
function computeMode(buffer: RemoteBuffer, targetTime: number): MoveInput['mode'] {
  const { snapshots } = buffer

  if (snapshots.length === 1) {
    return snapshots[0]!.mode ?? 'run'
  }

  const oldest = snapshots[0]!
  const newest = snapshots[snapshots.length - 1]!

  if (targetTime <= oldest.receivedAt) {
    return oldest.mode ?? 'run'
  }
  if (targetTime >= newest.receivedAt) {
    return newest.mode ?? 'run'
  }

  // targetTime이 (oldest, newest) 구간 내부임이 위에서 보장된다 —
  // `computePosition`과 동일한 최신 끝 역방향 스캔(리뷰 major 대응, 위
  // 함수 코멘트 참고)으로 그 값을 실제로 감싸는 인접 스냅샷 쌍을 찾는다.
  for (let i = snapshots.length - 2; i >= 0; i -= 1) {
    const from = snapshots[i]!
    if (targetTime < from.receivedAt) continue
    // step 함수 — from과 to 사이를 가중 평균하지 않고 from을 그대로
    // 반환한다("그 순간까지 알려진 최신 자세"는 아직 to가 도착하기 전인
    // from의 값이다, GA-75).
    return from.mode ?? 'run'
  }

  // 위 경계 검사로 targetTime이 (oldest, newest) 안임이 보장되므로 도달
  // 불가 — TS 문맥 안전을 위한 방어적 폴백일 뿐이다.
  return newest.mode ?? 'run'
}

/**
 * RQ-72 2/2(GA-83) — `computeMode`와 완전히 동일한 계단 함수 조회 패턴을
 * `grounded` 필드에 적용한다(가중 평균 없음, 경계 정책 동일). 별도 함수로
 * 둔 이유도 `computeMode`와 같다 — 위치용 가중 평균 경로에 접지 여부가
 * 물리적으로 섞일 자리를 없앤다.
 */
function computeGrounded(buffer: RemoteBuffer, targetTime: number): boolean {
  const { snapshots } = buffer

  if (snapshots.length === 1) {
    return snapshots[0]!.grounded ?? true
  }

  const oldest = snapshots[0]!
  const newest = snapshots[snapshots.length - 1]!

  if (targetTime <= oldest.receivedAt) {
    return oldest.grounded ?? true
  }
  if (targetTime >= newest.receivedAt) {
    return newest.grounded ?? true
  }

  for (let i = snapshots.length - 2; i >= 0; i -= 1) {
    const from = snapshots[i]!
    if (targetTime < from.receivedAt) continue
    return from.grounded ?? true
  }

  // 위 경계 검사로 targetTime이 (oldest, newest) 안임이 보장되므로 도달
  // 불가 — TS 문맥 안전을 위한 방어적 폴백일 뿐이다.
  return newest.grounded ?? true
}

export function createRemoteEntityInterpolator(
  selfSessionId: string,
  delayMs: number,
): RemoteEntityInterpolator {
  const buffers = new Map<string, RemoteBuffer>()

  return {
    addSnapshot(sessionId, snapshot) {
      if (sessionId === selfSessionId) return // GA-39: 자기 자신은 예측(RQ-62) 경로

      let buffer = buffers.get(sessionId)
      if (!buffer) {
        buffer = { snapshots: [], footstep: { previous: undefined, accumM: 0, totalCount: 0 } }
        buffers.set(sessionId, buffer)
      }
      buffer.snapshots.push(snapshot)
      pruneBuffer(buffer, delayMs)

      advanceFootstepAccumulator(buffer.footstep, snapshot)
    },

    getPosition(sessionId, renderTime) {
      if (sessionId === selfSessionId) return undefined // GA-39
      const buffer = buffers.get(sessionId)
      if (!buffer || buffer.snapshots.length === 0) return undefined

      const out: InterpolationPosition = { x: 0, y: 0, z: 0 }
      computePosition(buffer, renderTime - delayMs, out)
      return out
    },

    copyPositionInto(sessionId, renderTime, out) {
      if (sessionId === selfSessionId) return false
      const buffer = buffers.get(sessionId)
      if (!buffer || buffer.snapshots.length === 0) return false

      computePosition(buffer, renderTime - delayMs, out)
      return true
    },

    getMode(sessionId, renderTime) {
      if (sessionId === selfSessionId) return undefined // GA-39
      const buffer = buffers.get(sessionId)
      if (!buffer || buffer.snapshots.length === 0) return undefined

      return computeMode(buffer, renderTime - delayMs)
    },

    getGrounded(sessionId, renderTime) {
      if (sessionId === selfSessionId) return undefined // GA-39
      const buffer = buffers.get(sessionId)
      if (!buffer || buffer.snapshots.length === 0) return undefined

      return computeGrounded(buffer, renderTime - delayMs)
    },

    getFootstepCount(sessionId) {
      if (sessionId === selfSessionId) return undefined // GA-39
      const buffer = buffers.get(sessionId)
      if (!buffer) return undefined

      return buffer.footstep.totalCount
    },
  }
}
