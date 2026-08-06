import { SCENE } from '@client/config/design-tokens'
import { PRODUCTION_GEOMETRY } from '@shared/sim/geometry'
import { boxRenderBox, wallRenderBox } from '@client/scene/mapGeometry'
import { ladderRailBoxes, ladderRungBoxes } from '@client/scene/ladderGeometry'

/**
 * 맵 정적 지오메트리 렌더(원장 24f — RQ-30 벽 · RQ-32 박스·사다리).
 *
 * **왜 이제서야 생기는가**: 벽·박스·사다리는 `@shared/sim/{walls,boxes,ladders}`에
 * **판정 전용**으로만 있었고 클라이언트에 렌더 메시가 **0건**이었다. 즉 서버는
 * 충돌·차폐를 전부 판정하는데 화면에는 바닥과 플레이어만 있어 **보이지 않는 벽에
 * 부딪히는** 상태였다. 원장 24a의 `DESIGN.md` 라운드가 이 사실을 발견해 기록했고
 * (§2.1), 사용자가 실제로 "장애물이 하나도 안 보인다"를 보고했다.
 *
 * 덤으로 **이동이 보이게 된다** — 그 전까지 세계는 균일한 평면 하나뿐이라
 * 앞으로 걸어도 화면이 변하지 않았다. 시각적 기준점이 없으면 움직임은 없는 것과
 * 같다(사용자의 "WASD로 안 움직인다" 보고의 상당 부분이 여기서 온다).
 *
 * ## 정본과의 관계
 *
 * 좌표는 `PRODUCTION_GEOMETRY` **한 곳에서만** 온다 — 서버 판정(`GameRoom`)과
 * 클라 예측(`prediction.ts`)이 쓰는 바로 그 값이다(ADR-0010). 따라서 이 컴포넌트가
 * 그리는 것과 부딪히는 것은 **구조적으로 같은 물체**이고, 맵이 바뀌면 렌더가 따라
 * 바뀐다. 좌표 리터럴을 여기 옮겨 적었다면 그 순간부터 "보이는 벽과 막는 벽이
 * 다른" 결함이 가능해진다.
 *
 * ## 프레임 예산(ADR-0001)
 *
 * 이 컴포넌트는 **정적**이다 — `useFrame`이 없고 매 프레임 도는 코드가 없다.
 * 지오메트리가 고정이라 React가 최초 1회 마운트한 뒤 three.js 씬 그래프에
 * 남아 있을 뿐이다. `PRODUCTION_GEOMETRY`는 모듈 상수라 리렌더 시에도 배열이
 * 새로 만들어지지 않는다.
 *
 * ⚠️ 오브젝트 수는 벽 4 + 박스 15 + **사다리마다 레일 2 + 가로대 여러 개**다
 * (원장 24t에서 사다리가 통짜에서 뼈대가 되며 늘었다). 가로대 수는 볼륨 높이와
 * `SCENE.ladderRungSpacingM`에서 유도되므로 **여기 총합을 적지 않는다** — 적으면
 * 튜닝값이 바뀔 때 조용히 거짓이 된다. 수십 개 수준이라 드로우콜이 문제되는
 * 규모가 아니어서 인스턴싱을 쓰지 않는다(`PlayerMeshes`와 같은 판단).
 * 그 전제가 깨지는 지점은 `fe.md`의 인스턴싱 규칙이 적용될 자리다.
 *
 * 렌더 계층 면제 대상(ADR-0008 §6) — 이 파일 자체는 테스트 없음. 치수 환산
 * 산술만 `@client/scene/mapGeometry`로 분리해 단위 테스트한다.
 */
export function MapMeshes() {
  return (
    <group name="map-static-geometry">
      {PRODUCTION_GEOMETRY.walls.map((wall, index) => {
        const { center, size } = wallRenderBox(wall, SCENE.wallRenderHeightM)
        return (
          // key로 index를 쓰는 것이 안전한 자리다 — 배열이 모듈 상수라
          // 순서가 바뀌거나 항목이 삽입·삭제되지 않는다.
          <mesh key={`wall-${index}`} position={center}>
            <boxGeometry args={size} />
            <meshStandardMaterial color={SCENE.wall} />
          </mesh>
        )
      })}
      {PRODUCTION_GEOMETRY.boxes.map((box, index) => {
        const { center, size } = boxRenderBox(box)
        return (
          <mesh key={`box-${index}`} position={center}>
            <boxGeometry args={size} />
            <meshStandardMaterial color={SCENE.box} />
          </mesh>
        )
      })}
      {/* 사다리는 볼륨 통짜가 아니라 **등반면 뼈대**로 그린다(원장 24t) —
          통짜로 그리면 사다리로 안 읽히고, 올라탄 동안에는 메시 내부라
          `FrontSide` 컬링으로 화면에서 사라진다. 상세는 ladderGeometry.ts. */}
      {PRODUCTION_GEOMETRY.ladders.map((ladder, ladderIndex) => {
        const config = {
          railThicknessM: SCENE.ladderRailThicknessM,
          rungThicknessM: SCENE.ladderRungThicknessM,
          rungSpacingM: SCENE.ladderRungSpacingM,
        }
        const parts = [...ladderRailBoxes(ladder, config), ...ladderRungBoxes(ladder, config)]
        return parts.map(({ center, size }, partIndex) => (
          <mesh key={`ladder-${ladderIndex}-${partIndex}`} position={center}>
            <boxGeometry args={size} />
            <meshStandardMaterial color={SCENE.ladder} />
          </mesh>
        ))
      })}
    </group>
  )
}
