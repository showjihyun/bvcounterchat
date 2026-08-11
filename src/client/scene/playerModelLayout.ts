import type { HitboxConfig } from '@shared/sim/combat'
import { PLAYER_MODEL } from '@client/config/player-model-tuning'

/**
 * RQ-73/ADR-0015 결정 5 — 6파츠(머리·몸통·팔2·다리2) 배치를 **순수 함수**로
 * 유도한다("배치·위상 계산" 층 — 면제 없음, `tests/unit/rq-73-player-model
 * .test.ts`가 GA-90~92·95 값으로 단언한다). `PlayerMeshes.tsx`(R3F 배선)는
 * 이 함수의 결과로 `THREE.Mesh`를 만들거나 갱신하기만 한다 —
 * `remoteMeshHeightM`/`hitboxForMode` 선례("값 선택은 순수 함수, 렌더 배선은
 * 면제")를 그대로 따른다.
 *
 * **히트박스가 정본이다(ADR-0015 결정 2)** — 이 함수는 `HitboxConfig`(선
 * 자세 `DEFAULT_HITBOX` 또는 앉은 자세 `CROUCH_HITBOX`, 호출자가
 * `hitboxForMode`로 고른다)만 인자로 받고, 리터럴 미터 값을 새로 발명하지
 * 않는다 — 모든 파츠 치수는 `hitbox.bodyRadiusM`·`bodyTopM`·`bodyBottomM`에
 * 대한 **비율**(`@client/config/player-model-tuning`, 코더 재량의 시각
 * 선택값)로 유도한다.
 *
 * **머리는 히트 구체와 정확히 같다(반경 = `headRadiusM`, 중심 =
 * `(0, headCenterM, 0)`)** — 그 이상 키우면 히트박스를 넘고, 그보다 작게
 * 그릴 이유가 없다(ADR-0015 결정 2 "모델이 히트박스를 따르며 그 역이
 * 아니다"의 가장 직접적인 적용).
 *
 * **몸통·팔·다리는 원통 구간(`y ∈ [bodyBottomM, bodyTopM]`) 안에서만
 * 움직인다** — 다리는 `[bodyBottomM, hip]`, 몸통·팔은 `[hip, bodyTopM]`
 * (`hip = bodyBottomM + bodyHeightM × HIP_HEIGHT_RATIO`)로 높이를 나눠 겹치지
 * 않고 이어 붙인다. 수평(XZ) 코너 거리가 `bodyRadiusM`을 넘지 않도록 튜닝
 * 비율을 골랐다(여유 검산은 `player-model-tuning.ts` 파일 docblock 표).
 *
 * **앞뒤 대칭(ADR-0015 결정 3)** — 모든 파츠의 중심 `z`가 정확히 0이고
 * 깊이(half-depth)가 앞뒤로 대칭이다. 좌우(팔·다리 쌍)만 `x` 부호로 갈리고,
 * `z` 방향으로 구분되는 특징(얼굴·가슴/등)은 두지 않는다.
 */

export interface Vec3Like {
  x: number
  y: number
  z: number
}

/** 축 정렬 상자(half-extents 표기 — 중심에서 각 축으로의 절반 크기). */
export interface PartBox {
  kind: 'box'
  center: Vec3Like
  halfExtents: Vec3Like
}

/** 구체(중심·반지름). */
export interface PartSphere {
  kind: 'sphere'
  center: Vec3Like
  radius: number
}

export interface PlayerModelLayout {
  head: PartSphere
  torso: PartBox
  armLeft: PartBox
  armRight: PartBox
  legLeft: PartBox
  legRight: PartBox
}

/**
 * 주어진 히트박스(선 자세 또는 앉은 자세)에서 6파츠 배치를 계산한다.
 * **순수 함수 — 이전 호출을 기억하지 않는다**(GA-91 "자세 전환은 같은 틱
 * 즉시, 보간 금지"가 이 무상태성에서 그대로 따라 나온다: 매 틱 이 함수를
 * 다시 부르면 되고, 중간 배치를 만들어 낼 내부 상태 자체가 없다).
 */
export function computePlayerModelLayout(hitbox: HitboxConfig): PlayerModelLayout {
  const bodyHeightM = hitbox.bodyTopM - hitbox.bodyBottomM
  const hipHeightM = hitbox.bodyBottomM + bodyHeightM * PLAYER_MODEL.HIP_HEIGHT_RATIO

  const torsoHalfWidthM = hitbox.bodyRadiusM * PLAYER_MODEL.TORSO_HALF_WIDTH_RATIO
  const torsoHalfDepthM = hitbox.bodyRadiusM * PLAYER_MODEL.TORSO_HALF_DEPTH_RATIO
  const torsoHalfHeightM = (hitbox.bodyTopM - hipHeightM) / 2
  const torsoCenterYM = hipHeightM + torsoHalfHeightM

  const armHalfWidthM = hitbox.bodyRadiusM * PLAYER_MODEL.ARM_HALF_WIDTH_RATIO
  const armHalfDepthM = hitbox.bodyRadiusM * PLAYER_MODEL.ARM_HALF_DEPTH_RATIO
  const armOffsetXM = torsoHalfWidthM + armHalfWidthM // 몸통 바로 옆 — 팔을 벌리지 않는다(ADR-0015 결정 2 수용)

  const legHalfWidthM = hitbox.bodyRadiusM * PLAYER_MODEL.LEG_HALF_WIDTH_RATIO
  const legHalfDepthM = hitbox.bodyRadiusM * PLAYER_MODEL.LEG_HALF_DEPTH_RATIO
  const legHalfHeightM = (hipHeightM - hitbox.bodyBottomM) / 2
  const legCenterYM = hitbox.bodyBottomM + legHalfHeightM
  const legOffsetXM = torsoHalfWidthM * PLAYER_MODEL.LEG_OFFSET_RATIO

  return {
    head: {
      kind: 'sphere',
      center: { x: 0, y: hitbox.headCenterM, z: 0 },
      radius: hitbox.headRadiusM,
    },
    torso: {
      kind: 'box',
      center: { x: 0, y: torsoCenterYM, z: 0 },
      halfExtents: { x: torsoHalfWidthM, y: torsoHalfHeightM, z: torsoHalfDepthM },
    },
    armLeft: {
      kind: 'box',
      center: { x: -armOffsetXM, y: torsoCenterYM, z: 0 },
      halfExtents: { x: armHalfWidthM, y: torsoHalfHeightM, z: armHalfDepthM },
    },
    armRight: {
      kind: 'box',
      center: { x: armOffsetXM, y: torsoCenterYM, z: 0 },
      halfExtents: { x: armHalfWidthM, y: torsoHalfHeightM, z: armHalfDepthM },
    },
    legLeft: {
      kind: 'box',
      center: { x: -legOffsetXM, y: legCenterYM, z: 0 },
      halfExtents: { x: legHalfWidthM, y: legHalfHeightM, z: legHalfDepthM },
    },
    legRight: {
      kind: 'box',
      center: { x: legOffsetXM, y: legCenterYM, z: 0 },
      halfExtents: { x: legHalfWidthM, y: legHalfHeightM, z: legHalfDepthM },
    },
  }
}

/**
 * RQ-73(원장 24bz 이월 m5, GA-95) — 이 세션이 자기 자신인지에 따라 모델을
 * 그려야 하는지(visible)를 고른다. `PlayerMeshes.tsx`의 기존 인라인 판정
 * (`mesh.visible = sessionId !== state.selfSessionId`)을 그대로 뽑아낸
 * 것뿐이다 — "자기 자신은 렌더하지 않는다"(RQ-73 원문)가 배선 코드 안에
 * 묻히면 GA-95가 검증할 대상이 없어진다.
 */
export function isRemoteMeshVisible(sessionId: string, selfSessionId: string | null): boolean {
  return sessionId !== selfSessionId
}
