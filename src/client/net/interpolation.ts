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

export interface InterpolationPosition {
  x: number
  y: number
  z: number
}

export interface RemoteSnapshot extends InterpolationPosition {
  /** 이 스냅샷을 수신한 시각(ms, 임의의 단조 증가 시각 축) — 값으로 주입. */
  receivedAt: number
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
}

interface RemoteBuffer {
  /** `receivedAt` 오름차순 — `addSnapshot` 계약의 순서 가정을 그대로 따른다. */
  snapshots: RemoteSnapshot[]
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
  // 실제로 감싸는 인접 스냅샷 쌍을 찾아 선형 보간한다(첫 쌍에 고정되지 않음).
  for (let i = 0; i < snapshots.length - 1; i += 1) {
    const from = snapshots[i]!
    const to = snapshots[i + 1]!
    if (targetTime > to.receivedAt) continue

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
        buffer = { snapshots: [] }
        buffers.set(sessionId, buffer)
      }
      buffer.snapshots.push(snapshot)
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
  }
}
