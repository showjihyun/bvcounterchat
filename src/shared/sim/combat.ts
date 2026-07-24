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

/** 레이 뒤쪽(t<0) 오탐을 배제하는 여유(가정 B). */
const FORWARD_EPS = 1e-9
/** 레이 방향이 y축에 사실상 평행한지 판정하는 임계 — 방향이 정규화된
 * 단위 벡터라 dx²+dz²는 [0,1] 범위다. */
const DEGENERATE_RADIAL_EPS = 1e-12

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

/** 관통 없음(가정 F) — 레이 경로상 여러 후보가 명중 가능해도 가장 가까운
 * 하나만 반환한다. */
export function findClosestHit(ray: Ray, candidates: HitCandidate[], hitbox: HitboxConfig): ClosestHit | undefined {
  let closest: ClosestHit | undefined
  for (const candidate of candidates) {
    const result = raycastHitbox(ray, candidate.pose, hitbox)
    if (!result.hit || result.distance === undefined) continue
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

/** hp는 0 미만으로 내려가지 않는다(클램프) — died는 클램프 전 원값 기준
 * (hp<=0)으로 판정. */
export function applyDamage(currentHp: number, damage: number): DamageOutcome {
  const rawHp = currentHp - damage
  return { hp: Math.max(0, rawHp), died: rawHp <= 0 }
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

/** nowMs·lastFireAtMs는 호출자(서버)가 조달한다 — 이 함수 자신은
 * Date.now() 등을 호출하지 않는다(ADR-0008). lastFireAtMs가 없으면(첫
 * 발사) 항상 허용. 간격이 minIntervalMs 미만이면 거부, 그 이상(경계 포함)
 * 이면 허용 — ADR-0005 "간격이 150ms 미만이면 무시한다"의 직역. */
export function canFire(lastFireAtMs: number | undefined, nowMs: number, minIntervalMs: number): boolean {
  if (lastFireAtMs === undefined) return true
  return nowMs - lastFireAtMs >= minIntervalMs
}
