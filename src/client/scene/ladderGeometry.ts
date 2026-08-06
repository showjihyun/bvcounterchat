/**
 * 사다리를 **사다리처럼 보이게** 하는 렌더 치수 산술(원장 24t).
 *
 * ## 왜 통짜 박스로는 안 되는가
 *
 * 원장 24f가 사다리를 볼륨 그대로 불투명 상자(1×3×4m)로 그렸고, 사용자
 * 플레이테스트에서 세 가지가 한꺼번에 드러났다:
 *
 * 1. **사다리로 안 읽힌다** — 가로대도 레일도 없는 민짜 기둥이라 장애물로 보인다.
 * 2. **올라타면 사라진다** — 볼륨 안이 곧 메시 내부이고 three.js 기본
 *    `FrontSide`가 뒷면을 컬링하므로 등반 중에는 화면에서 없어진다.
 * 3. **막힌 것처럼 보이는데 통과한다** — 들어가서 오르는 볼륨인데 고체로 그렸다.
 *
 * ## 무엇을 그리는가
 *
 * **등반면에 세로 레일 2개 + 가로대 여러 개**. 등반면은 `normalX`/`normalZ`가
 * 가리키는 쪽이다 — RQ-21이 "이동 입력을 이 법선에 내적한 값이 양수면 상승"으로
 * 방향을 정의하므로, **오르려고 밀어붙이는 그 면**에 사다리가 있어야 조작과
 * 표현이 일치한다.
 *
 * 뼈대만 그리면 **속이 뚫려** 위 세 문제가 동시에 사라진다 — 안에서도 레일과
 * 가로대가 보이고(내부가 아니라 옆), 통과 가능해 보이며, 형태가 사다리다.
 *
 * ## 판정과의 관계 — 이 변경은 괴리를 **줄인다**
 *
 * 서버 hitscan의 차폐 목록은 `PRODUCTION_WALLS`뿐이라 **사다리는 원래 총알을
 * 막지 않는다**(원장 24i "가짜 엄폐"). 통짜 박스는 시야만 막아 그 괴리를 눈에
 * 보이게 만들었는데, 뼈대로 바꾸면 **표현이 판정에 맞춰진다.** 24i의 사다리
 * 몫이 여기서 닫히고 박스 15개가 남는다.
 *
 * ## 좌표를 복제하지 않는다(ADR-0010)
 *
 * 이 파일에 맵 좌표 리터럴은 없다. 인자로 받은 정본 `LadderVolume`을 환산할
 * 뿐이라 맵이 바뀌면 렌더도 따라 바뀐다. 굵기·간격 같은 **렌더 선택값**은
 * 호출자가 `LadderRenderConfig`로 주입한다 — 이 모듈이 값을 정하지 않는다.
 */

import type { LadderVolume } from '@shared/sim/movement'
import type { RenderBox } from '@client/scene/mapGeometry'

/** 사다리 뼈대의 굵기·간격. 정본은 `@client/config/design-tokens`의 `SCENE`이다. */
export interface LadderRenderConfig {
  /** 세로 레일 한 변의 굵기(m). */
  railThicknessM: number
  /** 가로대 한 변의 굵기(m). */
  rungThicknessM: number
  /** 가로대 사이 수직 간격(m). */
  rungSpacingM: number
}

/** 볼륨의 **긴 축**(폭)과 **짧은 축**(두께)을 법선으로부터 가른다.
 *
 * 법선이 X를 가리키면 사다리는 YZ 평면에 서므로 폭은 Z축이고, 법선이 Z를
 * 가리키면 폭은 X축이다. `Math.abs`로 비교하는 이유는 법선이 음수 방향일 수
 * 있기 때문이다(`normalX: -1`이면 서쪽 면이 등반면). */
function isNormalAlongX(ladder: LadderVolume): boolean {
  return Math.abs(ladder.normalX) >= Math.abs(ladder.normalZ)
}

/** 등반면이 놓인 좌표(법선 축 위의 값). 법선이 양수면 `max` 쪽 면이다. */
function facePosition(ladder: LadderVolume): number {
  if (isNormalAlongX(ladder)) {
    return ladder.normalX >= 0 ? ladder.maxX : ladder.minX
  }
  return ladder.normalZ >= 0 ? ladder.maxZ : ladder.minZ
}

/** 법선 축 위에서 면 안쪽으로 파고드는 부호 — 뼈대를 볼륨 **안쪽**에 붙인다.
 * 밖으로 튀어나오면 등반 볼륨 밖이라 "보이는 곳과 오르는 곳"이 어긋난다. */
function inwardSign(ladder: LadderVolume): number {
  const normal = isNormalAlongX(ladder) ? ladder.normalX : ladder.normalZ
  return normal >= 0 ? -1 : 1
}

/**
 * 가로대 개수 — 볼륨 높이 안에 **두께째로** 들어가는 만큼만 센다.
 *
 * 첫 가로대는 바닥에 **얹히고**(중심이 `minY + 두께/2`), 마지막 가로대는
 * 윗면을 넘지 않는다. 두께를 빼고 세지 않으면 첫 가로대가 바닥을 뚫고
 * 마지막이 볼륨 위로 튀어나온다 — 등반 볼륨 밖에 뜬 가로대는 "여기까지
 * 오를 수 있다"는 신호를 거짓으로 만든다.
 *
 * 개수를 상수로 박지 않는 이유는 사다리 높이가 바뀌면 밀도가 따라가야 하기
 * 때문이다 — 4m 사다리와 8m 사다리에 같은 개수를 두면 후자는 성기다.
 */
export function ladderRungCount(ladder: LadderVolume, config: LadderRenderConfig): number {
  if (config.rungSpacingM <= 0) return 0
  const usable = ladder.maxY - ladder.minY - config.rungThicknessM
  if (usable < 0) return 0
  return Math.floor(usable / config.rungSpacingM) + 1
}

/**
 * 세로 레일 2개. 등반면의 좌우 가장자리에 서고 볼륨의 수직 범위 전체를 덮는다.
 *
 * @returns 항상 길이 2. 폭 방향으로 마주 보는 한 쌍이다.
 */
export function ladderRailBoxes(ladder: LadderVolume, config: LadderRenderConfig): RenderBox[] {
  const alongX = isNormalAlongX(ladder)
  const face = facePosition(ladder)
  const depth = config.railThicknessM
  // 면에서 안쪽으로 반 두께만큼 들어간 위치가 레일 중심이다.
  const faceCenter = face + inwardSign(ladder) * (depth / 2)
  const centerY = (ladder.minY + ladder.maxY) / 2
  const height = ladder.maxY - ladder.minY

  const widthMin = alongX ? ladder.minZ : ladder.minX
  const widthMax = alongX ? ladder.maxZ : ladder.maxX
  const inset = config.railThicknessM / 2

  return [widthMin + inset, widthMax - inset].map((widthPos): RenderBox => {
    const size: [number, number, number] = alongX
      ? [depth, height, config.railThicknessM]
      : [config.railThicknessM, height, depth]
    const center: [number, number, number] = alongX
      ? [faceCenter, centerY, widthPos]
      : [widthPos, centerY, faceCenter]
    return { center, size }
  })
}

/**
 * 가로대. 등반면을 가로질러 폭 전체를 잇고, 바닥에서 꼭대기까지
 * `rungSpacingM` 간격으로 쌓인다.
 *
 * 마지막 가로대가 `maxY`를 **넘지 않는다** — 넘으면 등반 볼륨 밖에 떠 있는
 * 가로대가 되어 "여기까지 오를 수 있다"는 신호가 거짓이 된다.
 */
export function ladderRungBoxes(ladder: LadderVolume, config: LadderRenderConfig): RenderBox[] {
  const alongX = isNormalAlongX(ladder)
  const face = facePosition(ladder)
  const depth = config.rungThicknessM
  const faceCenter = face + inwardSign(ladder) * (depth / 2)

  const widthMin = alongX ? ladder.minZ : ladder.minX
  const widthMax = alongX ? ladder.maxZ : ladder.maxX
  const width = widthMax - widthMin
  const widthCenter = (widthMin + widthMax) / 2

  const count = ladderRungCount(ladder, config)
  const boxes: RenderBox[] = []
  for (let index = 0; index < count; index += 1) {
    // 바닥에 얹히는 첫 가로대부터 — 중심이 아니라 **아랫면**이 `minY`에 닿는다.
    const y = ladder.minY + config.rungThicknessM / 2 + index * config.rungSpacingM
    const size: [number, number, number] = alongX
      ? [depth, config.rungThicknessM, width]
      : [width, config.rungThicknessM, depth]
    const center: [number, number, number] = alongX
      ? [faceCenter, y, widthCenter]
      : [widthCenter, y, faceCenter]
    boxes.push({ center, size })
  }
  return boxes
}
