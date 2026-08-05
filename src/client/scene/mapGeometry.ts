/**
 * 맵 정적 지오메트리(벽·박스·사다리)를 **렌더용 박스 치수로 환산**하는 순수
 * 산술(원장 24f). `@shared/sim/{walls,boxes,ladders}`의 AABB는 **판정 좌표**
 * (min/max)이고 three.js `boxGeometry`는 **중심 + 크기**를 받으므로 그 사이를
 * 옮기는 함수가 필요하다.
 *
 * **왜 별도 모듈인가**: 이 환산이 틀리면 벽이 절반만 서거나 바닥에 파묻히는데,
 * 렌더 계층은 테스트 면제(ADR-0008 §6)라 그 오류를 잡을 그물이 없다. 산술만
 * 떼어내면 단위 테스트로 고정된다 — `@client/input/{aimMath,fireControl}`과
 * 같은 분리 패턴이다(ADR-0011 클라 모듈 test-after).
 *
 * **좌표를 복제하지 않는다**(ADR-0010) — 이 파일에 맵 좌표 리터럴은 없다.
 * 인자로 받은 정본 AABB를 환산할 뿐이므로, 맵이 바뀌면 렌더도 따라 바뀐다.
 * 판정과 표현이 갈라지는 것이 이 계층의 유일한 치명적 실패 양상이다 —
 * **보이지 않는 벽에 부딪히거나, 보이는데 통과하는 벽**이 그것이다.
 */

// 세 타입의 정의처는 `@shared/sim/movement`다 — `walls.ts`·`boxes.ts`·
// `ladders.ts`는 그 타입의 **값**(맵 좌표 정본)만 갖는다.
import type { BoxAABB, LadderVolume, WallAABB } from '@shared/sim/movement'

/** three.js `<mesh position>` + `<boxGeometry args>`에 그대로 펼쳐 넣는 형태. */
export interface RenderBox {
  /** 박스 중심(월드 좌표). */
  center: [number, number, number]
  /** 각 축 변의 길이. */
  size: [number, number, number]
}

/** min/max 6면 → 중심·크기. 나머지 세 함수가 전부 이걸 거친다. */
function aabbToRenderBox(
  minX: number, maxX: number,
  minY: number, maxY: number,
  minZ: number, maxZ: number,
): RenderBox {
  return {
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  }
}

/**
 * 벽 — **판정은 무한 높이 기둥**이라 `WallAABB`에 Y 필드가 없다(`walls.ts`,
 * ADR-0013). 렌더는 유한해야 하므로 높이를 **인자로 받는다** — 이 모듈이
 * 값을 정하지 않는다(정본은 `@client/config/design-tokens`의 `SCENE`).
 *
 * ⚠️ **판정과 표현이 여기서 의도적으로 갈라진다**: 그려진 높이보다 위로는
 * 갈 수 없지만(판정상 무한) 화면에는 그 위가 뚫려 보인다. 현재 맵에서
 * 도달 가능한 최고 지점은 사다리 꼭대기(4m)이고 벽 렌더 높이가 그와 같으므로
 * **눈으로 확인 가능한 범위에서는 어긋나지 않는다** — 이 전제가 깨지는 변경
 * (더 높은 사다리·박스)이 오면 벽 높이도 함께 올려야 한다.
 */
export function wallRenderBox(wall: WallAABB, heightM: number): RenderBox {
  return aabbToRenderBox(wall.minX, wall.maxX, 0, heightM, wall.minZ, wall.maxZ)
}

/**
 * 박스 — 바닥(y=0)에서 `topY`까지. `topY`는 **윗면 높이**이지 두께가 아니다
 * (`boxes.ts` — 플레이어가 그 높이에 착지한다). 그대로 크기로 쓰면 박스가
 * 바닥을 뚫고 내려가 윗면이 두 배 높이에 서므로, 착지면과 보이는 면이 어긋난다.
 */
export function boxRenderBox(box: BoxAABB): RenderBox {
  return aabbToRenderBox(box.minX, box.maxX, 0, box.topY, box.minZ, box.maxZ)
}

/** 사다리 — 볼륨이 이미 `minY`/`maxY`를 갖는다(RQ-21 등반 판정 범위). */
export function ladderRenderBox(ladder: LadderVolume): RenderBox {
  return aabbToRenderBox(ladder.minX, ladder.maxX, ladder.minY, ladder.maxY, ladder.minZ, ladder.maxZ)
}
