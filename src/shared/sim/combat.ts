/**
 * RQ-12(서버 hitscan)·RQ-13(헤드샷 배율)·RQ-14(HP/사망)·RQ-90(탄퍼짐 구조)·
 * ADR-0005(rate-limit) — 순수 판정 로직 (ADR-0008: 순수 함수, 결정론,
 * `src/shared` 환경 중립).
 *
 * 그린필드 계약은 `tests/unit/sim-combat.test.ts` 상단 docblock(test-writer
 * 지정, RQ-20 `movement.ts` 선례와 동일한 권한)이 정본이다 — 이 파일은 그
 * 계약을 그대로 구현한다.
 *
 * **히트박스 형상(가정 A)**: 바디는 캡슐이 아니라 평평한 원통(반구 캡 없음)
 * — 헤드(구체)와의 부위 애매함을 피하기 위한 test-writer 가정. 이 파일은
 * 그 형상을 그대로 구현한다: 바디는 y축을 중심축으로 하는 무한 원통을
 * `[bodyBottomM, bodyTopM]` 높이 구간으로 자른 것, 헤드는 `headCenterM`
 * 높이의 구체.
 *
 * **레이 뒤쪽 배제(가정 B)**: 2차식의 두 근 중 t<0(레이 원점보다 뒤쪽)인
 * 근은 채택하지 않는다 — `FORWARD_EPS` 여유로 부동소수점 경계 근처의 오탐을
 * 흡수한다.
 */

import type { SeededRng } from '@shared/sim/rng'
import { WEAPON } from '@shared/constants'
import type { MoveInput, WallAABB } from '@shared/sim/movement'
import type { SpreadTuning } from '@shared/config/combat-tuning'

export type HitRegion = 'head' | 'body'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Ray {
  origin: Vec3
  direction: Vec3
}

/** 캐릭터 "발" 위치(월드 좌표) — 히트박스 치수는 전부 이 y좌표를 기준으로 한
 * 상대 높이다. */
export interface TargetPose {
  position: Vec3
}

export interface HitboxConfig {
  /** 바디 원통(캡슐 아님 — 가정 A) 반지름 */
  bodyRadiusM: number
  /** 바디 원통 하단 높이(발 기준) */
  bodyBottomM: number
  /** 바디 원통 상단 높이(발 기준) — 헤드 구체 시작 높이 */
  bodyTopM: number
  /** 헤드 구체 반지름 */
  headRadiusM: number
  /** 헤드 구체 중심 높이(발 기준) */
  headCenterM: number
}

export interface HitscanResult {
  hit: boolean
  region?: HitRegion
  distance?: number
  point?: Vec3
}

/**
 * `footPosition`의 y에 `eyeHeightM`만큼 더한 지점(x·z는 불변) — 서버
 * hitscan 레이 원점과 클라이언트 1인칭 카메라 높이가 공유해야 하는 유일한
 * 계산(RQ-15~16 라운드 REV — `_workspace/RQ-15-16/01_test-writer_red.md`
 * §12, 22b 교차 리뷰에서 발견된 계산 중복 지점을 단일 진실 공급원으로
 * 통합). `eyeHeightM`을 함수 내부에서 `DEFAULT_HITBOX.eyeHeightM`으로 직접
 * 읽지 않고 인자로 받는 이유: `combat-tuning.ts`가 "의존 방향은
 * config→sim"이라고 명시했으므로, 이 함수가 그 값을 직접 참조하면 방향이
 * 뒤집힌다 — 호출자(서버·클라 둘 다 이미 `DEFAULT_HITBOX`를 임포트한다)가
 * 값을 넘긴다.
 */
export function eyeOrigin(footPosition: Vec3, eyeHeightM: number): Vec3 {
  return { x: footPosition.x, y: footPosition.y + eyeHeightM, z: footPosition.z }
}

/**
 * RQ-92 v2.2 — 자세(`mode`)에 따라 눈높이·히트박스를 즉시 전환한다.
 * `mode==='crouch'`면 `crouch`를, 그 외(run·walk)는 `standing`을 값 그대로
 * 반환한다 — 순수 함수라 이전 호출을 기억하지 않으므로 "즉시 전환·보간
 * 없음"(GA-67)이 계약 자체로 성립한다.
 *
 * `standing`·`crouch` 값을 함수 내부에서 직접 import하지 않고 호출자가 둘
 * 다 인자로 넘긴다 — `eyeOrigin`·`effectiveSpreadConeRadius`와 동일한 정신
 * (`combat-tuning.ts`가 명시한 "의존 방향은 config→sim" 유지).
 *
 * `grounded`는 받지 않는다 — RQ-92 원문이 "앉은 채 점프해도 crouch-jump
 * 특례를 두지 않는다"고 명시했으므로 공중 여부는 이 판정에 관여하지 않는다
 * (판정 근거 제한 — `effectiveSpreadConeRadius`의 타입 잠금 테스트와 동일한
 * 정신, 이 함수 쪽은 후속 하드닝 라운드에서 같은 기법으로 고정한다).
 */
export function hitboxForMode(
  standing: HitboxConfig & { eyeHeightM: number },
  crouch: HitboxConfig & { eyeHeightM: number },
  mode: MoveInput['mode'],
): HitboxConfig & { eyeHeightM: number } {
  return mode === 'crouch' ? crouch : standing
}

/** 레이 뒤쪽(t<0) 오탐을 배제하는 여유(가정 B). */
const FORWARD_EPS = 1e-9
/** 레이 방향이 y축에 사실상 평행한지 판정하는 임계 — 방향이 정규화된
 * 단위 벡터라 dx²+dz²는 [0,1] 범위다(`intersectBodyCylinder`). 이
 * 함수 자신의 `raycastHitbox`(정규화 가드, 위)도 같은 값을 쓴다.
 * **export하는 이유(N7, 리뷰 대응)**: `GameRoom.handleFire`가
 * `applySpread`(정규화된 단위 벡터를 전제)를 `raycastHitbox`보다 먼저
 * 소비하므로, 자기 나름의 정규화 퇴화 가드를 별도로 둬야 한다 — 그
 * 임계가 여기 값과 갈리면 "정규화는 통과했는데 raycastHitbox는 거부"
 * (또는 그 반대)가 생겨 두 층위의 판정이 어긋난다. 리터럴 복제
 * (ADR-0010) 대신 이 상수를 그대로 재사용하게 한다. */
export const DEGENERATE_RADIAL_EPS = 1e-12

function magnitude(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function normalize(v: Vec3): Vec3 {
  const m = magnitude(v)
  return { x: v.x / m, y: v.y / m, z: v.z / m }
}

function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s }
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

/**
 * 바디 원통(높이 구간으로 자른 무한 원통, x²+z²=r²)과 레이의 교차. 레이가
 * y축에 사실상 평행(방향의 수평 성분이 거의 0)하면 원통 측면을 "가로질러
 * 진입"하는 경우가 없으므로 판정하지 않는다(레이 원점이 이미 반지름 안에
 * 있어도 이 함수는 측면 진입만 다룬다 — 상단·하단 캡은 이 프로젝트의
 * 바디 히트박스에 없다, 위 파일 코멘트 "가정 A").
 */
function intersectBodyCylinder(o: Vec3, dir: Vec3, hitbox: HitboxConfig): number | undefined {
  const a = dir.x * dir.x + dir.z * dir.z
  if (a < DEGENERATE_RADIAL_EPS) return undefined

  const b = 2 * (o.x * dir.x + o.z * dir.z)
  const c = o.x * o.x + o.z * o.z - hitbox.bodyRadiusM * hitbox.bodyRadiusM
  const disc = b * b - 4 * a * c
  if (disc < 0) return undefined

  const sqrtDisc = Math.sqrt(disc)
  const t1 = (-b - sqrtDisc) / (2 * a)
  const t2 = (-b + sqrtDisc) / (2 * a)

  for (const t of [t1, t2]) {
    if (t < -FORWARD_EPS) continue
    const height = o.y + t * dir.y
    if (height >= hitbox.bodyBottomM && height <= hitbox.bodyTopM) {
      return Math.max(t, 0)
    }
  }
  return undefined
}

/** 헤드 구체(중심 (0, headCenterM, 0), 반지름 headRadiusM)와 레이의 교차.
 * 방향이 정규화된 단위 벡터라 2차식의 a항이 항상 1이다. */
function intersectHeadSphere(o: Vec3, dir: Vec3, hitbox: HitboxConfig): number | undefined {
  const oc: Vec3 = { x: o.x, y: o.y - hitbox.headCenterM, z: o.z }
  const b = 2 * dot(oc, dir)
  const c = dot(oc, oc) - hitbox.headRadiusM * hitbox.headRadiusM
  const disc = b * b - 4 * c
  if (disc < 0) return undefined

  const sqrtDisc = Math.sqrt(disc)
  const t1 = (-b - sqrtDisc) / 2
  const t2 = (-b + sqrtDisc) / 2

  if (t1 >= -FORWARD_EPS) return Math.max(t1, 0)
  if (t2 >= -FORWARD_EPS) return Math.max(t2, 0)
  return undefined
}

export function raycastHitbox(ray: Ray, target: TargetPose, hitbox: HitboxConfig): HitscanResult {
  const dirMagnitude = magnitude(ray.direction)
  if (!Number.isFinite(dirMagnitude) || dirMagnitude < DEGENERATE_RADIAL_EPS) {
    return { hit: false }
  }
  const dir = scale(ray.direction, 1 / dirMagnitude)

  const o: Vec3 = {
    x: ray.origin.x - target.position.x,
    y: ray.origin.y - target.position.y,
    z: ray.origin.z - target.position.z,
  }

  const bodyT = intersectBodyCylinder(o, dir, hitbox)
  const headT = intersectHeadSphere(o, dir, hitbox)

  // 겹치는 구간(가정 A 코멘트 참고)에서는 실제로 더 가까운(작은 t) 표면을
  // 채택한다 — 배열 순서가 아니라 거리로 승자를 정한다.
  let region: HitRegion | undefined
  let t: number | undefined
  if (bodyT !== undefined && (headT === undefined || bodyT <= headT)) {
    region = 'body'
    t = bodyT
  } else if (headT !== undefined) {
    region = 'head'
    t = headT
  }

  if (region === undefined || t === undefined) {
    return { hit: false }
  }

  return {
    hit: true,
    region,
    distance: t,
    point: {
      x: ray.origin.x + dir.x * t,
      y: ray.origin.y + dir.y * t,
      z: ray.origin.z + dir.z * t,
    },
  }
}

export interface HitCandidate {
  id: string
  pose: TargetPose
}

export interface ClosestHit {
  id: string
  result: HitscanResult
}

/** 레이 방향의 성분이 이 값보다 작으면 해당 축의 벽 슬랩과 "평행"으로
 * 취급한다(`intersectWallXZ`) — 레이 뒤쪽 배제(가정 B)와 같은 성격의
 * 여유값이라 `FORWARD_EPS`와 동일한 크기를 쓴다. */
const WALL_AXIS_PARALLEL_EPS = 1e-9

/**
 * 벽(`WallAABB`, 무한 높이 기둥 — `@shared/sim/walls` "2D(XZ) 전용" 문서와
 * 동일 가정, `minY`/`maxY` 없음)과 레이의 XZ 평면 교차 진입 거리(표준
 * 슬랩(slab) 알고리즘) — `o`·`dir`은 **월드 좌표계**(대상 포즈로 평행이동하지
 * 않은 원본, `raycastHitbox`의 `o`와 다르다 — 벽은 절대 좌표로 정의돼
 * 있으므로) 기준이다. `dir`은 이미 정규화된 단위 벡터여야 결과 거리가
 * `raycastHitbox`가 반환하는 명중 거리와 같은 단위(월드 미터)로 비교
 * 가능하다(호출자 `computeWallEntryDistances`가 정규화를 보장한다).
 *
 * 레이가 두 슬랩(X·Z) 모두를 지나는 구간(`[tMin, tMax]`)이 없으면(즉
 * `tMax < tMin`) 교차하지 않는다. 그 구간이 전부 레이 뒤쪽(`tMax`가
 * 음수)이면 벽은 사수 뒤에 있으므로 차폐 대상이 아니다(가정 B와 동일
 * 정신). 레이 원점이 이미 슬랩 내부라면(`tMin<0<=tMax`) 진입 거리를 0으로
 * 취급한다 — 이 라운드의 GA-58 계약이 직접 요구하는 경계는 아니지만,
 * 음수 거리를 그대로 흘려보내 "더 가까운 벽"비교를 오염시키지 않기 위한
 * 최소 방어다.
 */
function intersectWallXZ(o: Vec3, dir: Vec3, wall: WallAABB): number | undefined {
  let tMin = -Infinity
  let tMax = Infinity

  // 결함 수정 2/2 — 평행 축 경계: 레이가 x축 방향으로는 벽에 평행
  // (dir.x가 사실상 0)하면서 o.x가 벽의 슬랩 경계 **위**(===minX 또는
  // ===maxX)에 있으면, 그 레이는 벽면(껍데기)을 따라 그대로 스치듯
  // 지나갈 뿐 벽의 내부(고체, x∈(minX,maxX))로는 한 번도 들어가지 않는다
  // — "벽면과 나란한 방향" 결함 재현 케이스가 바로 이 배치다(밀착 사수가
  // 벽을 따라 옆으로 쏘는 흔한 조작). 예전 비교(`o.x < wall.minX`,
  // 즉 경계값을 "내부"로 포함)는 이 경계 접촉을 x축이 슬랩을 전혀
  // 제약하지 않는 것으로 취급했고, 그 결과 z축(비평행) 슬랩만으로 유효한
  // 전방 구간이 나와 진입 거리 0이 흘러나갔다(위 tMax<=0 수정과 같은
  // 뿌리: 경계 접촉을 "내부 진입"으로 오판). 경계값을 **제외**(`<=`/`>=`)
  // 하도록 바꾸면 이 접촉 전용 레이는 그 축에서 슬랩 밖으로 판정돼
  // `undefined`(교차 없음, 차폐 아님)를 반환한다 — 벽 두께 안쪽으로
  // 엄격히 들어간 배치(예: o.x=15.5, 벽 15~16)는 `<=`/`>=` 어느 쪽으로도
  // 여전히 "내부"라 기존 GA-58 세 케이스(사이·뒤·경계, 전부 원점 x=0이
  // 벽의 x구간 안쪽 깊숙이 있다)는 영향받지 않는다.
  if (Math.abs(dir.x) < WALL_AXIS_PARALLEL_EPS) {
    if (o.x <= wall.minX || o.x >= wall.maxX) return undefined
  } else {
    const t1 = (wall.minX - o.x) / dir.x
    const t2 = (wall.maxX - o.x) / dir.x
    tMin = Math.max(tMin, Math.min(t1, t2))
    tMax = Math.min(tMax, Math.max(t1, t2))
  }

  if (Math.abs(dir.z) < WALL_AXIS_PARALLEL_EPS) {
    if (o.z <= wall.minZ || o.z >= wall.maxZ) return undefined
  } else {
    const t1 = (wall.minZ - o.z) / dir.z
    const t2 = (wall.maxZ - o.z) / dir.z
    tMin = Math.max(tMin, Math.min(t1, t2))
    tMax = Math.min(tMax, Math.max(t1, t2))
  }

  // 결함 수정(PR #48 리뷰 blocker, `sim-combat-occlusion.test.ts` "결함
  // 재현" 블록): 레이 원점이 슬랩 경계 위에 있고 방향이 벽에서 멀어지면
  // 부동소수점 나눗셈이 tMax를 -0(반대편 두께 배치에서는 +0)으로 낸다.
  // 이전 가드 `tMax < -FORWARD_EPS`는 "0은 -epsilon보다 작지 않다"는
  // 이유로 이 경우를 배제하지 못해 진입 거리 0을 흘려보냈다(거리 0은
  // 모든 후보보다 가까우므로 전 후보가 오탐 차폐됐다). `tMax <= 0`은
  // 부호에 무관하게 "슬랩 구간이 전방(t>0)으로 조금도 뻗지 않는다"를
  // 직접 묻는다 — 그 경우 원점 자체는 경계 접촉일 뿐 진행 방향은 이미
  // 슬랩 밖이므로 실제로 막는 것이 없다. 정상 진입(레이가 슬랩으로
  // 들어가는 경로)은 tMin<=0이어도 tMax가 진행 방향으로 뚜렷한 양수이므로
  // 이 조건에 걸리지 않는다 — 기존 GA-58 세 벽(사이·뒤·경계)과 밀착
  // 사수의 "벽 쪽" 양성 대조군 모두 tMax가 0에서 먼 양수라 영향받지
  // 않는다(검증 수치: `_workspace/RQ-12-occlusion/05_coder_flush.md`).
  if (tMax < tMin || tMax <= 0) return undefined
  return Math.max(tMin, 0)
}

/** `ray`가 지나는 `walls` 각각의 XZ 슬랩 진입 거리(교차하지 않는 벽은
 * 제외)를 계산한다 — 벽 목록은 후보(candidate)와 무관하므로 `findClosestHit`
 * 호출당 한 번만 계산해 재사용한다(틱 예산, RQ-60 — 후보 수만큼 반복
 * 계산하지 않는다). `ray.direction`이 정규화되지 않았거나 퇴화(크기
 * ~0)했으면 `raycastHitbox` 쪽도 어차피 명중 없음(`hit:false`)으로 처리되어
 * 이 결과가 소비되지 않으므로 빈 배열로 안전하게 반환한다. */
function computeWallEntryDistances(ray: Ray, walls: readonly WallAABB[]): number[] {
  if (walls.length === 0) return []
  const dirMagnitude = magnitude(ray.direction)
  if (!Number.isFinite(dirMagnitude) || dirMagnitude < DEGENERATE_RADIAL_EPS) return []
  const dir = scale(ray.direction, 1 / dirMagnitude)

  const entries: number[] = []
  for (const wall of walls) {
    const t = intersectWallXZ(ray.origin, dir, wall)
    if (t !== undefined) entries.push(t)
  }
  return entries
}

/** `wallEntryDistances` 중 하나라도 `hitDistance`보다 **엄격히** 가까우면
 * (같은 거리는 차폐 아님 — 경계 결정, 위 `sim-combat-occlusion.test.ts`
 * 계약 4) 차폐된 것으로 본다. */
function isOccludedByWall(hitDistance: number, wallEntryDistances: readonly number[]): boolean {
  return wallEntryDistances.some((t) => t < hitDistance)
}

/** 관통 없음(가정 F) — 레이 경로상 여러 후보가 명중 가능해도 가장 가까운
 * 하나만 반환한다. `walls`(RQ-12 v1.7 — 맵 정적 지오메트리에 의한 hitscan
 * 차폐, 기본값 `[]`로 기존 3-인자 호출부와 완전히 동일하게 동작해 회귀가
 * 없다): 후보의 명중 거리보다 엄격히 더 가까운 거리에서 레이와 교차하는
 * 벽이 하나라도 있으면 그 후보는 명중 후보에서 제외된다(관통·도탄·파편은
 * v1.7 원문이 규정하지 않으므로 만들지 않는다 — 제외될 뿐 벽 표면에 별도
 * 명중 지점을 만들지 않는다). */
export function findClosestHit(
  ray: Ray,
  candidates: HitCandidate[],
  hitbox: HitboxConfig,
  walls: readonly WallAABB[] = [],
): ClosestHit | undefined {
  const wallEntryDistances = computeWallEntryDistances(ray, walls)

  let closest: ClosestHit | undefined
  for (const candidate of candidates) {
    const result = raycastHitbox(ray, candidate.pose, hitbox)
    if (!result.hit || result.distance === undefined) continue
    if (isOccludedByWall(result.distance, wallEntryDistances)) continue
    if (!closest || result.distance < (closest.result.distance as number)) {
      closest = { id: candidate.id, result }
    }
  }
  return closest
}

/** region만으로 데미지를 유도한다 — WEAPON.DAMAGE_BODY·
 * WEAPON.HEADSHOT_MULTIPLIER에서 계산하며 50을 하드코딩하지 않는다(RQ-13). */
export function damageForRegion(region: HitRegion): number {
  return region === 'head' ? WEAPON.DAMAGE_BODY * WEAPON.HEADSHOT_MULTIPLIER : WEAPON.DAMAGE_BODY
}

export interface DamageOutcome {
  hp: number
  died: boolean
}

/**
 * hp는 0 미만으로 내려가지 않는다(클램프). `died`는 "생존 → 사망"
 * **전이**에서만 성립한다(REV — 리뷰 major 재현,
 * `_workspace/review/feat-RQ-12-14-combat-core.md`) — `currentHp`(=이번
 * 피해 적용 전 hp)가 이미 0 이하였다면, 클램프 전 원값이 다시 0 이하로
 * 나와도 `died`는 false다. RQ-15(리스폰) 미구현으로 시신이 사라지지
 * 않는 상태에서 같은 대상을 재사격해도 킬이 중복 기록되지 않게 하는
 * 최소 조건이다 — `currentHp`를 이미 인자로 받고 있어 시그니처 변경이
 * 필요 없다.
 */
export function applyDamage(currentHp: number, damage: number): DamageOutcome {
  const rawHp = currentHp - damage
  return { hp: Math.max(0, rawHp), died: currentHp > 0 && rawHp <= 0 }
}

/**
 * `direction`(이미 정규화된 단위 벡터, 정규화 방어는 `raycastHitbox`의
 * 책임)을 중심축으로 하는 콘(반경 `coneRadiusRad`) 내부에 균등분포로
 * 편차를 준 단위 벡터를 반환한다(RQ-90, 결정론 — `rng`만 난수 출처).
 *
 * 콘 중심축을 기준으로 한 구면좌표(theta=축과의 각, phi=방위각)를 뽑아
 * 직교 기저(u, v, direction)로 합성한다 — `coneRadiusRad===0`이면 theta가
 * 항상 정확히 0이 되어(부동소수점 오차 없이) `direction`을 그대로 반환하는
 * 것과 동치다(정조준 기본값, rng는 소비하되 결과에 영향 없음).
 */
export function applySpread(direction: Vec3, rng: SeededRng, coneRadiusRad: number): Vec3 {
  const cosConeEdge = Math.cos(coneRadiusRad)
  const u1 = rng.nextFloat()
  const u2 = rng.nextFloat()
  // 콘 내부 균등(입체각 기준) 분포 — u1=0일 때 theta=0, u1→1일 때
  // theta→coneRadiusRad.
  const cosTheta = 1 - u1 * (1 - cosConeEdge)
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
  const phi = u2 * 2 * Math.PI

  const helper: Vec3 = Math.abs(direction.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
  const u = normalize(cross(helper, direction))
  const v = cross(direction, u)

  const localX = sinTheta * Math.cos(phi)
  const localY = sinTheta * Math.sin(phi)

  return add(add(scale(u, localX), scale(v, localY)), scale(direction, cosTheta))
}

/**
 * 사격 시점의 `dirX`·`dirZ`(수평 이동 입력)·`mode`·`grounded` **넷으로만**
 * 실효 탄퍼짐 콘 반경을 구한다(RQ-90 v1.9 정확도 저하 3단계). 시그니처에
 * 그 외 파라미터가 없다는 것 자체가 "판정 근거 제한"(시점 회전·클라
 * 자기신고 배제)의 타입 수준 보증이다 — 초과 인자를 넘기면 컴파일 타임에
 * 거부된다(`tests/unit/sim-combat.test.ts` "판정 근거 제한(타입 잠금)" 테스트).
 *
 * **v1.9(정지 판정에 수평 입력 추가)**: `mode`는 이동 *속도 설정*
 * (`run`/`walk`/`crouch`)이지 "지금 움직이는 중"이 아니고, `MoveInput`에
 * idle 값이 없어(`IDLE_MOVE_INPUT.mode==='run'`) `mode`만으로는 "정지"를
 * 표현할 수 없었다(v1.8 결함, coder가 Green 작업 중 통합 4파일 회귀로
 * 실측 발견 — 원장 25a-10 REV). "정지"는 이제 수평 이동 입력이 없는
 * 상태(`dirX===0 && dirZ===0`)로 판정한다.
 *
 * 우선순위(확정 — team-lead 회신, 원장 25a-10 REV, v1.9 판정표에도 유지):
 * `grounded===false`면 `dirX`·`dirZ`·`mode`와 무관하게 공중 배율을 쓴다 —
 * v1.9 원문이 저하 단계를 "정지·앉기 / 이동 / 공중(**비접지**)"로 나누고
 * 공중을 직접 "비접지"로 정의했으므로, 접지 여부가 가장 먼저 갈린다.
 * 접지 상태에서는 `mode==='crouch'`이거나 수평 입력이 없으면(OR 조건)
 * 기본 배율(×1, "정지·앉기" tier)이고, 그 외(walk·run이면서 실제로
 * 움직이는 중)는 이동 배율이다.
 */
export function effectiveSpreadConeRadius(
  tuning: SpreadTuning,
  dirX: number,
  dirZ: number,
  mode: MoveInput['mode'],
  grounded: boolean,
): number {
  if (!grounded) return tuning.coneRadiusRad * tuning.airborneMultiplier
  if (mode === 'crouch' || (dirX === 0 && dirZ === 0)) return tuning.coneRadiusRad
  return tuning.coneRadiusRad * tuning.movingMultiplier
}

/** nowMs·lastFireAtMs는 호출자(서버)가 조달한다 — 이 함수 자신은
 * Date.now() 등을 호출하지 않는다(ADR-0008). lastFireAtMs가 없으면(첫
 * 발사) 항상 허용. 간격이 minIntervalMs 미만이면 거부, 그 이상(경계 포함)
 * 이면 허용 — ADR-0005 "간격이 150ms 미만이면 무시한다"의 직역. */
export function canFire(lastFireAtMs: number | undefined, nowMs: number, minIntervalMs: number): boolean {
  if (lastFireAtMs === undefined) return true
  return nowMs - lastFireAtMs >= minIntervalMs
}
