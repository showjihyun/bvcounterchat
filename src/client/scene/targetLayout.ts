import type { WallAABB } from '@shared/sim/movement'

/**
 * RQ-34 사격 연습용 과녁 배치(원장 24cw) — 네 벽(EAST/WEST/NORTH/SOUTH) 각각의
 * **안쪽면**(원점을 향하는 면) 중심에 놓일 좌표와, 그 면에 맞춰 과녁을 돌릴
 * Y축 회전(라디안)을 계산하는 순수 함수.
 *
 * **왜 별도 모듈인가**: 렌더 컴포넌트는 ADR-0008 §6 면제라 단위 테스트가 없다.
 * 이 판단(어느 면이 "안쪽"인지, 중심 좌표가 어디인지)이 틀리면 과녁이 바깥면에
 * 뜨거나 벽 밖 허공에 놓이는데, 그 결함은 화면을 봐야만 드러난다
 * (`decalLayout.ts`·`mapGeometry.ts`와 같은 분리 이유 — ADR-0011 클라 모듈
 * test-after).
 *
 * **좌표를 복제하지 않는다**(ADR-0010) — 이 파일에 벽 좌표 리터럴이 없다. 인자로
 * 받은 `WallAABB`(정본은 `@shared/sim/walls`)를 환산할 뿐이므로, 맵이 바뀌면
 * 과녁 위치도 따라 바뀐다.
 *
 * ⚠️ **판정 참여 없음**(RQ-34) — 이 함수의 결과는 렌더 배치에만 쓰인다. 명중
 * 판정은 여전히 벽 AABB(`@shared/sim/walls`)만 본다. 두께·충돌이 없으므로 이
 * 함수는 "면"(2D 좌표 + 회전) 하나만 낸다.
 *
 * **쿼터니언이 아니라 Y축 회전인 이유**: `decalLayout.ts`(RQ-70·71)는 임의
 * 방향의 법선(레이캐스트 결과)을 다루므로 쿼터니언이 필요하지만, 이 네 벽은
 * 전부 축 정렬(AABB)이라 안쪽면 법선이 항상 X축 또는 Z축이다 — Y축 회전 하나로
 * 충분하고, 그쪽의 일반해 쿼터니언 산술을 끌어올 이유가 없다.
 */

/** three.js `<group position>` + `rotation={[0, rotationY, 0]}`에 그대로
 * 펼쳐 넣는 형태. */
export interface TargetPlacement {
  /** 과녁 중심(월드 좌표) — 벽 안쪽면에서 `offsetM`만큼 방 안쪽으로 띄운 값.
   * y는 호출부가 넘긴 `eyeHeightM` 그대로다(RQ-34 "중심이 눈높이"). */
  center: [number, number, number]
  /** three.js `rotation` prop(Euler)에 그대로 넣는 Y축 회전(라디안). 과녁
   * 지오메트리(`ringGeometry`/`circleGeometry`)의 기본 평면(XY, 법선 +Z)을
   * 벽 안쪽면 법선과 맞춘다 — `decalOrientationInto`의 "+Z 기준"과 같은
   * 관례(`decalLayout.ts` docblock 참고, `HitDecals.tsx`의 `circleGeometry`도
   * 같은 기본 평면을 쓴다). */
  rotationY: number
}

/**
 * `wall`의 안쪽면(원점에 더 가까운 경계) 중심에 과녁을 놓는다.
 *
 * **"안쪽"의 판정 기준**: 벽은 두께 1m(한 축)·폭 10m(다른 축)의 얇은 판이다
 * (`@shared/sim/walls`). 두께 축에서 원점(0)에 더 가까운 경계값이 안쪽면이고,
 * 폭 축에서는 두 경계의 중점이 과녁의 그 축 좌표다. 두께 축은 `maxX-minX`와
 * `maxZ-minZ` 중 더 작은 쪽으로 판별한다(EAST/WEST는 X, NORTH/SOUTH는 Z) —
 * 어느 벽인지 이름으로 분기하지 않고 AABB 형태에서 그대로 유도한다.
 *
 * `eyeHeightM`은 리터럴로 복제하지 않고 호출부가 넘긴다(정본은
 * `DEFAULT_HITBOX.eyeHeightM`, `@shared/config/combat-tuning` — ADR-0010).
 * `offsetM`도 마찬가지로 호출부가 넘긴다(정본은 `TARGET.offsetM`,
 * `@client/config/design-tokens`) — 이 모듈 자체는 디자인 토큰을 모른다.
 */
export function targetPlacement(wall: WallAABB, eyeHeightM: number, offsetM: number): TargetPlacement {
  const thicknessOnX = wall.maxX - wall.minX < wall.maxZ - wall.minZ
  if (thicknessOnX) {
    // EAST/WEST — 두께가 X축, 폭이 Z축.
    const innerX = Math.abs(wall.minX) < Math.abs(wall.maxX) ? wall.minX : wall.maxX
    const towardOrigin = innerX > 0 ? -1 : 1
    const z = (wall.minZ + wall.maxZ) / 2
    return {
      center: [innerX + towardOrigin * offsetM, eyeHeightM, z],
      rotationY: towardOrigin > 0 ? Math.PI / 2 : -Math.PI / 2,
    }
  }
  // NORTH/SOUTH — 두께가 Z축, 폭이 X축.
  const innerZ = Math.abs(wall.minZ) < Math.abs(wall.maxZ) ? wall.minZ : wall.maxZ
  const towardOrigin = innerZ > 0 ? -1 : 1
  const x = (wall.minX + wall.maxX) / 2
  return {
    center: [x, eyeHeightM, innerZ + towardOrigin * offsetM],
    rotationY: towardOrigin > 0 ? 0 : Math.PI,
  }
}
