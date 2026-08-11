import type { HitboxConfig } from '@shared/sim/combat'
import { GAIT_TUNING, PLAYER_MODEL } from '@client/config/player-model-tuning'

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

function copyBoxWithZOffset(source: PartBox, dz: number, out: PartBox): void {
  out.center.x = source.center.x
  out.center.y = source.center.y
  out.center.z = source.center.z + dz
  out.halfExtents.x = source.halfExtents.x
  out.halfExtents.y = source.halfExtents.y
  out.halfExtents.z = source.halfExtents.z
}

/**
 * RQ-73(평가 F2, 원장 24bz 재호출) — 걸음 스윙(팔·다리의 로컬 Z 평행이동)을
 * 적용한 배치를 `out`에 써넣는다. **"배치·위상 계산" 층이다(ADR-0015 결정
 * 5, 면제 없음)** — RQ-73 "히트박스 내포" 조항은 자세·애니메이션 예외를
 * 두지 않으므로, 스윙을 포함한 좌표도 값으로 단언 가능해야 한다.
 * `tests/unit/rq-73-player-model.test.ts`가 여러 위상 표본(0·0.25·0.5·0.75
 * — `sin`이 0·+1·0·-1이 되는 지점, 즉 진폭이 최대로 걸리는 지점을 포함)에서
 * `computePlayerModelLayout`과 같은 코너 내포 판정을 재사용해 단언한다.
 *
 * **할당 없음 — `out` 파라미터에 써넣는다(`copyPositionInto` 선례와 동일한
 * 정신).** `useFrame`(렌더 배선, `PlayerMeshes.tsx`)이 모듈 스코프 스크래치
 * 버퍼 하나를 재사용해 넘긴다 — 원격 플레이어 수만큼, 매 프레임 새 객체
 * 그래프를 만들면 프레임 예산(ADR-0001)을 어긴다. 테스트는 프레임 예산
 * 제약이 없으므로 매번 새 `out`(`computePlayerModelLayout`의 결과 등)을
 * 만들어 호출해도 무방하다.
 *
 * 머리·몸통은 스윙하지 않는다(그대로 복사) — 사람의 걸음에서 흔들리는 것은
 * 팔다리뿐이다. 같은 쪽 팔은 다리와 **반대** 위상(교차 보행)으로 움직인다.
 *
 * ⚠️ **이 함수가 `PlayerMeshes.tsx`가 실제로 스윙을 계산하는 유일한
 * 자리다** — 진폭 상수(`GAIT_TUNING`)를 두 곳에 복제하면(테스트용 순수
 * 함수 하나, 렌더 배선에 또 하나) 값이 갈릴 수 있다(ADR-0010). 렌더
 * 배선은 이 함수를 호출만 한다.
 */
export function applyGaitSwingInto(layout: PlayerModelLayout, gaitPhase01: number, out: PlayerModelLayout): void {
  out.head.center.x = layout.head.center.x
  out.head.center.y = layout.head.center.y
  out.head.center.z = layout.head.center.z
  out.head.radius = layout.head.radius

  copyBoxWithZOffset(layout.torso, 0, out.torso)

  const swing = Math.sin(gaitPhase01 * Math.PI * 2)
  const legSwingZ = GAIT_TUNING.LEG_SWING_AMPLITUDE_M * swing
  const armSwingZ = GAIT_TUNING.ARM_SWING_AMPLITUDE_M * swing

  copyBoxWithZOffset(layout.armLeft, -armSwingZ, out.armLeft)
  copyBoxWithZOffset(layout.armRight, armSwingZ, out.armRight)
  copyBoxWithZOffset(layout.legLeft, legSwingZ, out.legLeft)
  copyBoxWithZOffset(layout.legRight, -legSwingZ, out.legRight)
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
