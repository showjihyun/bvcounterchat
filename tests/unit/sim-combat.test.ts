import { describe, expect, it } from 'vitest'
import {
  applyDamage,
  applySpread,
  canFire,
  damageForRegion,
  effectiveSpreadConeRadius,
  eyeOrigin,
  findClosestHit,
  raycastHitbox,
  type HitboxConfig,
  type HitCandidate,
  type Ray,
  type TargetPose,
  type Vec3,
} from '@shared/sim/combat'
import { createRng } from '@shared/sim/rng'
import { DEFAULT_HITBOX, DEFAULT_SPREAD, type SpreadTuning } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'

/**
 * RQ-12(서버 hitscan)·RQ-13(헤드샷 배율)·RQ-14(HP/사망)·RQ-90(탄퍼짐 구조)·
 * ADR-0005(rate-limit) — 순수 판정 로직 단위 테스트 (ADR-0008: 순수 함수,
 * 결정론, `src/shared` 환경 중립. `harness/workflow/tdd.md` "탄도·데미지
 * 계산 = 단위" 레이어 지정).
 *
 * **레벨 분리(ADR-0008/ADR-0011)**: GA-05~08의 "1차 정본" 검증은
 * `tests/integration/rq-1{2,2,3,4}-*.test.ts`(골든 JSONL의 `verify` 필드가
 * 그 경로들을 직접 지정한다 — 실 Colyseus 룸 경계, 서버 권위 RQ-61 관측).
 * 이 파일은 그 통합 시나리오가 내부적으로 의존하는 **순수 산술**(레이 ×
 * 히트박스 교차, 부위별 데미지, HP 감산·사망 판정, 탄퍼짐 콘 구조,
 * 발사 속도 제한 판정)을 결정론적으로 미리 잠근다 — 통합 테스트가 실 WS
 * 타이밍에 걸려 흔들려도, 이 판정들의 정확성 자체는 이 파일이 별도로
 * 보장한다.
 *
 * **그린필드 계약(test-writer 지정, RQ-20 `movement.ts`·RQ-62
 * `prediction.ts` 선례와 동일한 권한)**: `src/shared/sim/combat.ts`와
 * `src/shared/config/combat-tuning.ts`는 원장 17e 계약에 없는 신규
 * 모듈이다. 아래 계약대로 `coder`가 구현하면 이 파일이 Green이 된다.
 *
 * ```ts
 * // src/shared/sim/combat.ts (신규)
 * export type HitRegion = 'head' | 'body'
 * export interface Vec3 { x: number; y: number; z: number }
 * export interface Ray { origin: Vec3; direction: Vec3 }
 * export interface TargetPose { position: Vec3 } // 캐릭터 "발" 위치(월드 좌표)
 * export interface HitboxConfig {
 *   bodyRadiusM: number   // 바디 원통(캡슐 아님 — 아래 "가정 A" 참고) 반지름
 *   bodyBottomM: number   // 바디 원통 하단 높이(발 기준)
 *   bodyTopM: number      // 바디 원통 상단 높이(발 기준) — 헤드 구체 시작 높이
 *   headRadiusM: number   // 헤드 구체 반지름
 *   headCenterM: number   // 헤드 구체 중심 높이(발 기준)
 * }
 * export interface HitscanResult {
 *   hit: boolean
 *   region?: HitRegion   // hit=true일 때만 존재
 *   distance?: number    // 레이 원점 ~ 명중 지점 거리(m), hit=true일 때만
 *   point?: Vec3         // 명중 지점 월드 좌표, hit=true일 때만
 * }
 * export function raycastHitbox(ray: Ray, target: TargetPose, hitbox: HitboxConfig): HitscanResult
 *
 * export interface HitCandidate { id: string; pose: TargetPose }
 * export interface ClosestHit { id: string; result: HitscanResult }
 * // 레이 경로상 여러 후보가 동시에 명중 가능해도 가장 가까운(관통 없음) 하나만 반환.
 * export function findClosestHit(ray: Ray, candidates: HitCandidate[], hitbox: HitboxConfig): ClosestHit | undefined
 *
 * // region만으로 데미지를 유도한다 — WEAPON.DAMAGE_BODY(25)·
 * // WEAPON.HEADSHOT_MULTIPLIER(2)에서 계산하며 50을 하드코딩하지 않는다(RQ-13).
 * export function damageForRegion(region: HitRegion): number
 *
 * export interface DamageOutcome { hp: number; died: boolean }
 * // hp는 0 미만으로 내려가지 않는다(클램프) — died는 클램프 전 원값 기준(hp<=0)으로 판정.
 * export function applyDamage(currentHp: number, damage: number): DamageOutcome
 *
 * // direction은 이미 정규화된 단위 벡터라고 가정한다(정규화 방어는
 * // raycastHitbox의 책임 — 이 함수는 최종 조준 방향을 만드는 산술 단계일 뿐).
 * // coneRadiusRad=0이면 rng를 소비하든 안 하든 direction을 값 그대로 반환한다
 * // (정조준, 결정론). coneRadiusRad>0이면 반환 벡터는 여전히 단위 벡터이고,
 * // direction과 이루는 각이 coneRadiusRad를 넘지 않는다(콘 내부 분포).
 * export function applySpread(direction: Vec3, rng: SeededRng, coneRadiusRad: number): Vec3
 *
 * // nowMs·lastFireAtMs는 호출자(서버 틱 루프)가 제공한다 — 이 함수 자신은
 * // Date.now() 등을 호출하지 않는다(ADR-0008). lastFireAtMs가 없으면(첫
 * // 발사) 항상 허용. 간격이 minIntervalMs "미만"이면 거부, 그 이상(경계
 * // 포함)이면 허용 — ADR-0005 원문 "간격이 150ms 미만이면 무시한다"의 직역.
 * export function canFire(lastFireAtMs: number | undefined, nowMs: number, minIntervalMs: number): boolean
 * ```
 *
 * ```ts
 * // src/shared/config/combat-tuning.ts (신규) — RQ-90/ADR-0005: "히트박스
 * // 세부 치수·콘 반경은 코드가 아닌 설정 파일 값"이라는 요구를 만족하는
 * // 실제 위치. combat.ts의 타입을 가져와 기본값만 제공한다(로직은 여기 없음).
 * import type { HitboxConfig } from '@shared/sim/combat'
 * export interface SpreadTuning { coneRadiusRad: number }
 * export const DEFAULT_HITBOX: HitboxConfig
 * export const DEFAULT_SPREAD: SpreadTuning // coneRadiusRad: 0 (기본 정조준)
 * ```
 *
 * **가정 A(바디 형상 — 캡슐이 아니라 평평한 원통)**: ADR-0005는 "헤드(작은
 * 볼륨)+바디(나머지 전신)" 2단 구성만 정하고 각 볼륨의 정확한 기하 형상은
 * "히트박스 세부 치수는... 확정할 수 없다"며 열어뒀다(캐릭터 모델 자산
 * 부재). 진짜 캡슐(원통+반구 캡)로 하면 캡 부분이 헤드 구체와 기하학적으로
 * 겹쳐 "어느 부위에 맞았나"가 형상 세부에 따라 갈리는 애매함이 생긴다 —
 * 이 애매함을 피하려고 바디를 **평평한 원통**(위·아래가 평평, 반구 캡
 * 없음)으로 가정한다. 헤드 구체 하단이 바디 원통 상단과 정확히 맞닿게
 * (`headCenterM - headRadiusM === bodyTopM`) 배치하면 결측 없이 이어진다.
 * 이 가정은 "구현 방식"이 아니라 이 파일이 검증할 **관측 가능한 계약의 형상
 * 정의** 자체다 — coder가 이 형상으로 구현하지 않으면 이 테스트들의 좌표가
 * 안 맞는다(다른 형상을 쓰려면 team-lead 재확인 필요).
 *
 * **가정 B(레이는 전방만 판정)**: 레이 원점 뒤쪽(방향의 반대편)에 기하학적으로
 * "선분 연장상" 겹치는 대상이 있어도 명중으로 잡지 않는다 — 아래 "레이
 * 뒤쪽" 테스트가 이 성질을 직접 고정한다(2차식의 두 근 중 t<0인 근을
 * 채택하는 결함을 막는다).
 *
 * **결정론·환경 중립**: `src/shared/sim/`이라 ADR-0008/ADR-0010 lint
 * 대상 — `Math.random()`·`Date.now()` 직접 호출 금지. 탄퍼짐은 주입된
 * `SeededRng`(`@shared/sim/rng`)만 쓴다.
 *
 * **REV(RQ-15~16 라운드, 계약 확장) — `eyeOrigin` 추가**: 22b(클라
 * 조준·사격) 평가 세션이 변이 검증으로 실증한 교차 리뷰 발견 —
 * 서버(`GameRoom.handleFire`)와 클라(`PlayerControls.tsx`, `feat/
 * client-aim-fire` 브랜치)가 각각 **따로** `footPosition.y +
 * DEFAULT_HITBOX.eyeHeightM`을 인라인 계산해 사격 레이 원점/1인칭 카메라
 * 높이를 구한다 — 같은 상수를 참조하니 값 복제는 아니지만, 계산 **지점이
 * 둘**이라 한쪽만 다른 식으로 바뀌어도(예: 헤드밥·앉기 높이 보정 추가)
 * 아무 게이트에 걸리지 않고 "화면에 보이는 것 = 서버가 판정하는 것"이
 * 조용히 어긋난다. `eyeOrigin(footPosition, eyeHeightM)`을 단일 진실
 * 공급원으로 추가해 양쪽이 같은 함수를 부르게 하는 것이 목적이다.
 *
 * **파라미터화 근거(값을 감추지 않는 이유)**: `eyeHeightM`을 함수 내부에서
 * `DEFAULT_HITBOX.eyeHeightM`으로 직접 읽지 않고 인자로 받는다 —
 * `combat-tuning.ts`가 이미 "의존 방향은 config→sim이다(판정 엔진이
 * 특정 기본값을 몰라도 되게 하기 위함)"라고 명시했으므로, `combat.ts`가
 * `combat-tuning.ts`를 임포트하면 이 방향이 뒤집힌다. 호출자(서버·클라
 * 둘 다 이미 `DEFAULT_HITBOX`를 임포트하고 있다)가 `eyeHeightM` 값을
 * 넘기는 것이 기존 의존 방향을 지키는 유일한 선택이다.
 *
 * ```ts
 * // src/shared/sim/combat.ts (확장)
 * // footPosition의 y에 eyeHeightM만큼 더한 지점(x·z는 불변) — 서버
 * // hitscan 레이 원점과 클라 1인칭 카메라 높이가 공유해야 하는 유일한
 * // 계산.
 * export function eyeOrigin(footPosition: Vec3, eyeHeightM: number): Vec3
 * ```
 *
 * **범위 한계(명시)**: 이 계약은 **순수 함수 자체**만 고정한다.
 * `GameRoom.handleFire`(서버, 이 워크트리 안)가 실제로 이 함수를 호출
 * 하도록 배선하는지는 이 라운드의 관측 가능한 결과(HP·킬 등)를 바꾸지
 * 않으므로(인라인 계산과 값이 동일) 통합 테스트로 강제할 수 없다 —
 * coder가 배선하는 것을 assumption으로만 남긴다. `PlayerControls.tsx`
 * (클라, `feat/client-aim-fire` 브랜치 — **이 워크트리에는 없다**,
 * 별도 git worktree라 파일 자체를 읽을 수 없었다)의 배선은 이 세션이
 * 검증할 수 없다 — R3F 렌더 코드는 애초에 단위/통합 테스트 대상이
 * 아니고(ADR-0008 §6), 그 브랜치가 이 브랜치와 합쳐질 때 리뷰가 확인해야
 * 한다. `_workspace/RQ-15-16/01_test-writer_red.md` §12에 이 한계를
 * 상세히 남겼다.
 *
 * ---
 * **REV(RQ-90 v1.8, 2026-08-04) — 정확도 저하 3단계(그린필드 확장, test-writer
 * 지정, `combat.ts`/`combat-tuning.ts`(확장) 태그와 동일 권한)**:
 * `requirements.md` v1.8이 탄퍼짐 콘 반경의 실제값(기본 0.5°)과 이동·공중
 * 시 정확도 저하 배율(이동 ×2, 공중 ×4, 단조 증가)을 확정했다.
 *
 * **REV2(RQ-90 v1.9, 2026-08-04) — "정지" 판정에 수평 입력 추가(coder
 * 실측 발견 → 오케스트레이터 재개정, 원장 25a-10)**: v1.8이 판정 근거를
 * `mode`·`grounded` **둘뿐**이라고 적었는데, `MoveInput.mode`는 이동
 * **속도 설정**(`run`/`walk`/`crouch`)이지 "지금 움직이는 중"이 아니고
 * `MoveInput`에 idle 값이 없어(`IDLE_MOVE_INPUT.mode === 'run'`) **"정지"
 * 단계가 도달 불가능**했다 — move를 안 보냈거나 `dirX=dirZ=0`으로 멈춘
 * 사수가 전부 "이동"(×2)으로 분류되는 구현 결함을 낳았다(coder가 Green
 * 작업 중 발견, 통합 4파일 회귀로 실증). v1.9는 판정 근거에 **수평 이동
 * 입력**(`dirX`·`dirZ`)을 추가한다 — "정지"는 `dirX===0 && dirZ===0`인
 * 상태로 판정한다. 시점 회전·클라이언트 자기신고 상태는 여전히 판정에
 * 쓰지 않는다(RQ-43·RQ-21이 겪은 함정과 같은 계열을 피한다) — 판정 근거는
 * `dirX`·`dirZ`·`mode`·`grounded` **넷**으로 늘었을 뿐, 그 성격(서버가
 * 독립 관측 가능한 값만)은 그대로다.
 *
 * ```ts
 * // src/shared/config/combat-tuning.ts (확장)
 * export interface SpreadTuning {
 *   coneRadiusRad: number      // 기본(정지·앉기) 콘 반경 — 0.5°에서 유도(라디안). 리터럴 금지(ADR-0010).
 *   movingMultiplier: number   // 이동(걷기·달리기) 배율 — 2
 *   airborneMultiplier: number // 공중(비접지) 배율 — 4. movingMultiplier 이상이어야 한다(단조).
 * }
 * export const DEFAULT_SPREAD: SpreadTuning
 * // = { coneRadiusRad: (0.5*Math.PI)/180, movingMultiplier: 2, airborneMultiplier: 4 }
 *
 * // src/shared/sim/combat.ts (확장, v1.9로 시그니처 확장)
 * // dirX·dirZ·mode·grounded "만"으로 실효 콘 반경을 구한다 — 시그니처에
 * // 그 외 파라미터가 없다는 것 자체가 "판정 근거 제한"의 타입 수준
 * // 보증이다(아래 "판정 근거 제한(타입 잠금)" 테스트가 6번째 인자 추가를
 * // 컴파일 타임에 거부하는지 직접 고정한다).
 * //
 * // 판정표(v1.9 확정):
 * //   정지·앉기 | grounded && (dirX===0 && dirZ===0 || mode==='crouch') | ×1
 * //   이동      | grounded && (dirX!==0 || dirZ!==0) && mode!=='crouch' | ×2
 * //   공중      | !grounded                                            | ×4
 * export function effectiveSpreadConeRadius(
 *   tuning: SpreadTuning,
 *   dirX: number,
 *   dirZ: number,
 *   mode: 'run' | 'walk' | 'crouch', // @shared/sim/movement의 MoveInput['mode']와 동일 유니언
 *   grounded: boolean,
 * ): number
 * ```
 *
 * **우선순위(확정 — team-lead 회신, 원장 25a-10 REV, v1.9 판정표에도 그대로
 * 유지)**: `grounded===false`면 `dirX`·`dirZ`·`mode`와 무관하게 공중
 * 배율(×4)을 쓴다 — v1.9가 저하 단계를 "정지·앉기 / 이동 / 공중(**비접지**)"
 * 로 나누고 공중을 직접 "비접지"로 정의했으므로, 접지 여부가 가장 먼저
 * 갈린다. 접지 상태에서는 **`mode==='crouch'`이거나 수평 입력이 없으면**
 * (`dirX===0 && dirZ===0`) 기본 배율(×1, "정지·앉기" tier)이고, 그 외
 * (walk·run **이면서 실제로 움직이는 중**)는 이동 배율(×2)이다 — 이 OR
 * 조건이 v1.9의 핵심 추가다: **"앉은 채 이동"(crouch-walk)도 여전히
 * ×1이다**(`mode==='crouch'`가 단독으로 정지 tier를 트리거하므로 수평
 * 입력 유무와 무관), 그리고 **"서 있지만 입력이 없음"(예: mode='run'인데
 * 가만히 있음)도 이제 ×1이다**(v1.8에서는 도달 불가능했던 바로 그 상태).
 * 단조 증가(정지 ≤ 이동 ≤ 공중) 요구도 공중이 최상위임을 전제한다.
 *
 * **판정 근거 제한 확인 범위(하네스 비대화 방지, 팀리드 지시)**: 위 시그니처
 * 잠금(타입 테스트)이 `effectiveSpreadConeRadius` 자체의 판정 근거를
 * 고정한다. `sanitizeFireInput`/`sanitizeMoveInput`(`GameRoom.ts`, 기존
 * 구현·이 라운드가 건드리지 않는다)이 이미 dirX/dirY/dirZ/rttMs·
 * dirX/dirZ/mode/jump 외 필드를 읽지 않아 시점 회전·자기신고 필드 자체가
 * 두 payload 계약 어디에도 없다 — 통합 레벨 재확인 테스트는 이 라운드에서
 * 생략한다(중복 검증, 사용자 지시 "하네스를 과도하게 키우지 말라"). v1.9가
 * 추가한 `dirX`·`dirZ`도 **새 payload 필드가 아니다** — `sanitizeMoveInput`이
 * 이미 `MoveInput.dirX`/`dirZ`를 읽고 있었다(RQ-20, 이 라운드 이전부터).
 * 달라진 것은 그 값을 탄퍼짐 판정에도 **재사용**하는 것뿐이다.
 * ---
 */

function magnitude(v: Vec3): number {
  return Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2)
}

function normalize(v: Vec3): Vec3 {
  const m = magnitude(v)
  return { x: v.x / m, y: v.y / m, z: v.z / m }
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/** 두 벡터(정규화 여부 무관) 사이의 각(라디안). */
function angleBetween(a: Vec3, b: Vec3): number {
  const na = normalize(a)
  const nb = normalize(b)
  const cos = Math.min(1, Math.max(-1, dot(na, nb)))
  return Math.acos(cos)
}

/**
 * 단위 테스트 전용 히트박스 — 손으로 검산 가능한 깔끔한 수치(반지름 1·2,
 * 헤드 반지름 0.5). `@shared/config/combat-tuning`의 `DEFAULT_HITBOX`(표준
 * 인체 비례, 통합 테스트가 쓰는 실제 기본값)와 별개로, 이 파일은 "함수가
 * 히트박스 값을 코드에 굳히지 않고 인자로 받아 그대로 쓰는가"를 증명하려고
 * 의도적으로 다른 값을 주입한다. 헤드 구체 하단(2.5-0.5=2.0)이 바디 원통
 * 상단(2.0)과 정확히 맞닿아 틈·겹침이 없다(가정 A).
 */
const TEST_HITBOX: HitboxConfig = {
  bodyRadiusM: 1,
  bodyBottomM: 0,
  bodyTopM: 2,
  headRadiusM: 0.5,
  headCenterM: 2.5,
}

/** 원점(0,0,0)에 발이 위치한 대상. 모든 기하 테스트가 공유하는 기준 대상. */
const ORIGIN_TARGET: TargetPose = { position: { x: 0, y: 0, z: 0 } }

describe('RQ-12 hitscan 판정 — 레이 × 2단 히트박스(헤드/바디) 교차 (raycastHitbox)', () => {
  it('바디 원통 범위 내 높이·중심축 관통 레이는 바디에 명중한다', () => {
    // 원점(-10)에서 +z로 쏘는 레이, 높이 y=1(바디 범위 [0,2] 안), x=0(중심축).
    // 원통 표면(x²+z²=1²)과의 교차는 z=-1(원점에서 가장 먼저 만나는 지점).
    const ray: Ray = { origin: { x: 0, y: 1, z: -10 }, direction: { x: 0, y: 0, z: 1 } }
    const result = raycastHitbox(ray, ORIGIN_TARGET, TEST_HITBOX)

    expect(result.hit).toBe(true)
    expect(result.region).toBe('body')
    expect(result.distance).toBeCloseTo(9, 6) // |z=-1 - z=-10| = 9
    expect(result.point?.x).toBeCloseTo(0, 6)
    expect(result.point?.y).toBeCloseTo(1, 6)
    expect(result.point?.z).toBeCloseTo(-1, 6)
  })

  it('헤드 구체 높이의 관통 레이는 헤드에 명중한다(RQ-13 배율의 판정 기반)', () => {
    // 높이 y=2.5(헤드 구체 중심 높이, 바디 원통 범위 [0,2] 밖) — 구체(반지름
    // 0.5) 표면과 z=±0.5에서 교차, 원점에서 먼저 만나는 z=-0.5를 채택.
    const ray: Ray = { origin: { x: 0, y: 2.5, z: -10 }, direction: { x: 0, y: 0, z: 1 } }
    const result = raycastHitbox(ray, ORIGIN_TARGET, TEST_HITBOX)

    expect(result.hit).toBe(true)
    expect(result.region).toBe('head')
    expect(result.distance).toBeCloseTo(9.5, 6) // |z=-0.5 - z=-10| = 9.5
  })

  it('바디·헤드 반경을 모두 벗어난 측면 레이는 명중하지 않는다', () => {
    // x=3 고정 — 바디 원통(반지름1)·헤드 구체(반지름0.5, 중심 x=0) 둘 다
    // x=3만큼 벗어나 있어 어떤 z에서도 표면에 닿지 않는다.
    const ray: Ray = { origin: { x: 3, y: 1, z: -10 }, direction: { x: 0, y: 0, z: 1 } }
    const result = raycastHitbox(ray, ORIGIN_TARGET, TEST_HITBOX)

    expect(result.hit).toBe(false)
    expect(result.region).toBeUndefined()
    expect(result.distance).toBeUndefined()
    expect(result.point).toBeUndefined()
  })

  it('머리 위로 지나가는 레이는 명중하지 않는다(과잉 조준 — 바디 범위·헤드 구체 둘 다 벗어남)', () => {
    // y=5 — 바디 원통 상단(2)도, 헤드 구체 상단(2.5+0.5=3)도 넘는 높이.
    const ray: Ray = { origin: { x: 0, y: 5, z: -10 }, direction: { x: 0, y: 0, z: 1 } }
    const result = raycastHitbox(ray, ORIGIN_TARGET, TEST_HITBOX)

    expect(result.hit).toBe(false)
  })

  it('정규화되지 않은 방향 벡터(크기 5)를 줘도 정규화된 것과 동일한 명중 결과를 낸다', () => {
    const ray: Ray = { origin: { x: 0, y: 1, z: -10 }, direction: { x: 0, y: 0, z: 5 } }
    const result = raycastHitbox(ray, ORIGIN_TARGET, TEST_HITBOX)

    expect(result.hit).toBe(true)
    expect(result.region).toBe('body')
    // distance는 방향 벡터의 크기(5)가 아니라 실제 m 단위 거리(9)여야 한다 —
    // 함수가 내부적으로 방향을 정규화해 파라미터화한다는 증거.
    expect(result.distance).toBeCloseTo(9, 6)
  })

  it('방향 벡터가 0(조작·손상된 입력)이면 명중 처리하지 않는다(RQ-61 방어적 처리)', () => {
    const ray: Ray = { origin: { x: 0, y: 1, z: -10 }, direction: { x: 0, y: 0, z: 0 } }
    const result = raycastHitbox(ray, ORIGIN_TARGET, TEST_HITBOX)

    expect(result.hit).toBe(false)
  })

  it('레이 뒤쪽(반대 방향 연장선)에만 겹치는 대상은 명중하지 않는다(가정 B — t<0 근 배제)', () => {
    // 원점 z=10에서 +z 방향으로 발사 — 대상(z=0 근방의 원통·구체)은 전부
    // z<10 쪽에 있어 레이가 나아가는 방향(z 증가)의 반대편이다. 원통
    // 방정식(x²+z²=1)의 해 z=±1은 존재하지만 그 지점에 도달하려면 t가
    // 음수여야 한다 — 물리적으로 이 레이는 그 대상에 닿지 않는다.
    const ray: Ray = { origin: { x: 0, y: 1, z: 10 }, direction: { x: 0, y: 0, z: 1 } }
    const result = raycastHitbox(ray, ORIGIN_TARGET, TEST_HITBOX)

    expect(result.hit).toBe(false)
  })
})

describe('eyeOrigin — 발 위치 + 눈높이로 사격 레이 원점을 계산(클라·서버 공유 계약, RQ-15~16 라운드 REV)', () => {
  it('발 위치에서 y만 eyeHeightM만큼 올라간 지점을 반환한다(x·z는 불변)', () => {
    const foot: Vec3 = { x: 3, y: 0, z: -5 }
    expect(eyeOrigin(foot, 1.7)).toEqual({ x: 3, y: 1.7, z: -5 })
  })

  it('발이 원점(y=0)이 아니어도(예: 공중) 눈높이는 그 y값에 더해진다', () => {
    const foot: Vec3 = { x: 0, y: 2.4, z: 0 }
    expect(eyeOrigin(foot, 1.7)).toEqual({ x: 0, y: 4.1, z: 0 })
  })

  it('eyeHeightM이 0이면 발 위치와 동일하다(퇴화 케이스)', () => {
    const foot: Vec3 = { x: 1, y: 0, z: 1 }
    expect(eyeOrigin(foot, 0)).toEqual(foot)
  })

  it('DEFAULT_HITBOX.eyeHeightM(실제 설정값)을 그대로 넘겨도 동일한 산술로 동작한다 — 서버 hitscan·클라 1인칭 카메라가 공유해야 하는 계산', () => {
    const foot: Vec3 = { x: 10, y: 0, z: -10 }
    const result = eyeOrigin(foot, DEFAULT_HITBOX.eyeHeightM)

    expect(result.x).toBe(foot.x)
    expect(result.y).toBe(DEFAULT_HITBOX.eyeHeightM)
    expect(result.z).toBe(foot.z)
  })

  it('반환값을 그대로 raycastHitbox의 ray.origin에 써도 기존 조준 계산과 동일한 명중 판정을 낸다(회귀 없음 확인)', () => {
    // 이 파일 최상단 "바디 원통 범위 내 높이·중심축 관통 레이는 바디에
    // 명중한다" 테스트와 동일한 시나리오를, origin의 y좌표만
    // eyeOrigin으로 계산해 재현한다 — 인라인 산술(y: footY + eyeHeightM)과
    // eyeOrigin(foot, eyeHeightM).y가 값으로 완전히 같다는 것을 실제
    // 판정 경로로도 확인한다.
    const foot: Vec3 = { x: 0, y: 1, z: -10 }
    const origin = eyeOrigin(foot, 0) // eyeHeightM=0이므로 origin === foot
    const ray: Ray = { origin, direction: { x: 0, y: 0, z: 1 } }
    const result = raycastHitbox(ray, ORIGIN_TARGET, TEST_HITBOX)

    expect(result.hit).toBe(true)
    expect(result.region).toBe('body')
  })
})

describe('RQ-12 findClosestHit — 여러 대상 중 레이가 가장 먼저 맞히는 대상 선택(관통 없음)', () => {
  const ray: Ray = { origin: { x: 0, y: 1, z: -10 }, direction: { x: 0, y: 0, z: 1 } }
  const near: HitCandidate = { id: 'near', pose: { position: { x: 0, y: 0, z: 0 } } }
  // far는 near와 같은 중심축(x=0,z=20)에 있어 같은 레이가 기하학적으로는
  // far도 관통할 수 있지만(원통 반지름 1, y=1 동일 높이), near가 훨씬
  // 가깝다 — "관통 없이 가장 가까운 하나만" 반환하는지가 이 그룹의 핵심.
  const far: HitCandidate = { id: 'far', pose: { position: { x: 0, y: 0, z: 20 } } }

  it('배열 순서가 [near, far]여도 near만 반환한다', () => {
    const result = findClosestHit(ray, [near, far], TEST_HITBOX)

    expect(result?.id).toBe('near')
    expect(result?.result.hit).toBe(true)
    expect(result?.result.region).toBe('body')
  })

  it('배열 순서를 뒤집어 [far, near]로 줘도(먼 대상이 먼저 나열) 여전히 near를 반환한다 — 배열 순서가 아니라 실제 거리로 비교한다', () => {
    const result = findClosestHit(ray, [far, near], TEST_HITBOX)

    expect(result?.id).toBe('near')
  })

  it('아무 후보도 레이 경로에 없으면 undefined를 반환한다', () => {
    const missRay: Ray = { origin: { x: 0, y: 5, z: -10 }, direction: { x: 0, y: 0, z: 1 } } // 과잉 조준(위 raycastHitbox 테스트와 동일 높이)
    const result = findClosestHit(missRay, [near], TEST_HITBOX)

    expect(result).toBeUndefined()
  })

  it('후보 목록이 비어 있으면 undefined를 반환한다', () => {
    expect(findClosestHit(ray, [], TEST_HITBOX)).toBeUndefined()
  })
})

describe('RQ-13 헤드샷 배율 — damageForRegion (GA-07의 판정 기반)', () => {
  it('바디 명중 데미지는 WEAPON.DAMAGE_BODY와 같다(25)', () => {
    expect(damageForRegion('body')).toBe(WEAPON.DAMAGE_BODY)
    expect(damageForRegion('body')).toBe(25)
  })

  it('헤드 명중 데미지는 바디 데미지의 정확히 WEAPON.HEADSHOT_MULTIPLIER배다(2배=50, GA-07 "정확히 2배")', () => {
    expect(damageForRegion('head')).toBe(WEAPON.DAMAGE_BODY * WEAPON.HEADSHOT_MULTIPLIER)
    expect(damageForRegion('head')).toBe(50)
  })
})

describe('RQ-14 HP 감산·사망 판정 — applyDamage', () => {
  it('일반 피해는 HP에서 그대로 차감되고 사망 처리되지 않는다', () => {
    expect(applyDamage(100, 25)).toEqual({ hp: 75, died: false })
  })

  it('HP가 정확히 0이 되면 사망 처리된다(RQ-14 "0 이하가 되면")', () => {
    expect(applyDamage(25, 25)).toEqual({ hp: 0, died: true })
  })

  it('과다 피해(오버킬)를 입어도 HP는 음수로 내려가지 않는다(0에서 클램프)', () => {
    expect(applyDamage(10, 25)).toEqual({ hp: 0, died: true })
  })

  it('GA-08: 바디샷 3회는 생존(HP 25 남음), 4번째 바디샷에서 사망한다', () => {
    const bodyDamage = damageForRegion('body')
    let hp: number = PLAYER.MAX_HP
    let died = false

    for (let i = 0; i < 3; i += 1) {
      const outcome = applyDamage(hp, bodyDamage)
      hp = outcome.hp
      died = outcome.died
    }
    expect(hp).toBe(25)
    expect(died).toBe(false)

    const fourth = applyDamage(hp, bodyDamage)
    expect(fourth.hp).toBe(0)
    expect(fourth.died).toBe(true)
  })

  it('GA-07: 헤드샷 1회는 HP 100에서 정확히 50을 남긴다(바디 25의 2배 데미지)', () => {
    const outcome = applyDamage(PLAYER.MAX_HP, damageForRegion('head'))

    expect(outcome.hp).toBe(50)
    expect(outcome.died).toBe(false)
  })

  /**
   * REV — 리뷰 major 재현(`_workspace/review/feat-RQ-12-14-combat-core.md`
   * "이미 사망(hp=0)한 대상에 대한 재사격이 킬을 중복 기록한다").
   *
   * `died`는 "생존 → 사망" **전이**에서만 성립해야 한다(RQ-14 "HP가 0
   * 이하가 되면... 킬을 기록해야 한다" — 죽음은 1회의 사건이지, hp<=0
   * 상태가 유지되는 매 순간 반복되는 사건이 아니다). `currentHp` 인자는
   * 이미 "이번 피해 적용 **전** hp"(=직전 hp) 그 자체이므로, 별도 인자
   * 추가 없이 `currentHp > 0`이었는지만 추가로 확인하면 된다 — 이미
   * hp<=0인 대상에게 데미지를 더 적용해도(현재 hp는 계속 0으로 클램프)
   * `died`는 다시 true가 되지 않아야 한다.
   *
   * 이 계약은 "어느 레이어가 '이미 죽음'을 걸러야 하는가"라는 리뷰의
   * 열린 질문에 대한 test-writer의 답이다 — `applyDamage`가 이미
   * `currentHp`(=직전 hp)를 인자로 받고 있으므로, 이 판단에 필요한
   * 정보를 이미 가진 이 함수가 책임지는 것이 계약 확장 없이 가능한
   * 최소 수정이다(구현 방식을 규정하지 않는다 — `GameRoom`이 별도로
   * "직전 hp>0" 가드를 두는 방식으로 고쳐도 이 단언 자체는 여전히
   * `applyDamage`의 관측 가능한 계약으로 성립해야 한다).
   */
  it(
    'RQ-14 리뷰 major 재현: 이미 HP가 0인(이미 사망한) 대상에 데미지를 추가로 적용해도 died는 다시 true가 되지 않는다 — 사망은 생존→사망 전이에서만 성립한다',
    () => {
      const bodyShotOnCorpse = applyDamage(0, damageForRegion('body'))
      expect(bodyShotOnCorpse.hp).toBe(0)
      expect(bodyShotOnCorpse.died).toBe(false)

      const headshotOnCorpse = applyDamage(0, damageForRegion('head'))
      expect(headshotOnCorpse.hp).toBe(0)
      expect(headshotOnCorpse.died).toBe(false)
    },
  )
})

describe('ADR-0005 발사 속도 제한(rate-limit) 판정 — canFire', () => {
  it('이전 발사 기록이 없으면(첫 발사) 항상 허용된다', () => {
    expect(canFire(undefined, 0, WEAPON.FIRE_INTERVAL_MS)).toBe(true)
    expect(canFire(undefined, 999_999, WEAPON.FIRE_INTERVAL_MS)).toBe(true)
  })

  it('간격이 FIRE_INTERVAL_MS(150ms) 미만이면 거부된다(연사 조작 차단)', () => {
    expect(canFire(1000, 1000 + WEAPON.FIRE_INTERVAL_MS - 1, WEAPON.FIRE_INTERVAL_MS)).toBe(false)
    expect(canFire(1000, 1000 + 1, WEAPON.FIRE_INTERVAL_MS)).toBe(false) // 1ms 간격(사실상 연타)
  })

  it('간격이 정확히 FIRE_INTERVAL_MS(150ms)이면 허용된다(경계 포함 — "미만이면 무시"의 직역)', () => {
    expect(canFire(1000, 1000 + WEAPON.FIRE_INTERVAL_MS, WEAPON.FIRE_INTERVAL_MS)).toBe(true)
  })

  it('간격이 FIRE_INTERVAL_MS를 크게 초과해도 허용된다', () => {
    expect(canFire(1000, 1000 + WEAPON.FIRE_INTERVAL_MS * 10, WEAPON.FIRE_INTERVAL_MS)).toBe(true)
  })
})

describe('RQ-90 탄퍼짐 구조(콘 반경 내 편차) — applySpread (구조만, 값 튜닝은 범위 밖)', () => {
  const AIM: Vec3 = { x: 0, y: 0, z: 1 } // 이미 정규화된 조준 방향

  it('콘 반경 0이면 방향이 정확히 그대로 유지된다(정조준, 결정론) — REV(v1.8): 리터럴 0을 직접 넘긴다. 이전 버전은 DEFAULT_SPREAD.coneRadiusRad를 넘겼는데, v1.8부터 그 기본값 자체가 0이 아니게 되어(아래 "RQ-90 v1.8" describe) 이 테스트가 검증하려던 성질(coneRadiusRad===0 ⇒ 정조준)과 "DEFAULT_SPREAD의 현재 값"이라는 별개 관심사가 섞여 있었다 — 분리한다. DEFAULT_SPREAD.coneRadiusRad의 실제값 검증은 아래 새 describe로 이동했다.', () => {
    // 서로 다른 시드를 줘도(rng를 소비하는지 여부와 무관하게) 결과가 흔들리지
    // 않아야 한다 — "반경 0 = 정조준"이라는 계약을 시드에 결합하지 않는다.
    for (const seed of [1, 2, 42]) {
      const result = applySpread(AIM, createRng(seed), 0)
      expect(result.x).toBeCloseTo(AIM.x, 9)
      expect(result.y).toBeCloseTo(AIM.y, 9)
      expect(result.z).toBeCloseTo(AIM.z, 9)
    }
  })

  it('콘 반경이 0보다 크면 편차 각도가 콘 반경을 넘지 않고, 결과는 여전히 단위 벡터다(균등분포의 정확한 형태는 범위 밖)', () => {
    const coneRadiusRad = 0.15
    for (const seed of [1, 2, 3, 4, 5, 42, 999]) {
      const result = applySpread(AIM, createRng(seed), coneRadiusRad)
      const angle = angleBetween(AIM, result)

      expect(angle).toBeLessThanOrEqual(coneRadiusRad + 1e-9)
      expect(magnitude(result)).toBeCloseTo(1, 6)
    }
  })

  it('같은 시드는 같은 탄퍼짐 결과를 낸다(RQ-90 결정론 — 서버가 재현 가능해야 한다)', () => {
    const a = applySpread(AIM, createRng(777), 0.2)
    const b = applySpread(AIM, createRng(777), 0.2)

    expect(b).toEqual(a)
  })

  it('시드가 다르면 탄퍼짐 결과도 달라진다(주입된 RNG가 실제로 결과에 영향을 준다는 구조 확인)', () => {
    const a = applySpread(AIM, createRng(1), 0.3)
    const b = applySpread(AIM, createRng(2), 0.3)

    expect(a).not.toEqual(b)
  })
})

describe('RQ-90 v1.8/v1.9 정확도 저하 3단계(정지·앉기 ×1 · 이동 ×2 · 공중 ×4) — effectiveSpreadConeRadius + DEFAULT_SPREAD 확정값 (파일 상단 REV 계약, v1.9: "정지" 판정에 수평 입력 추가)', () => {
  const AIM: Vec3 = { x: 0, y: 0, z: 1 }

  it('DEFAULT_SPREAD.coneRadiusRad는 0.5°와 같다(라디안 유도값과 비교 — 리터럴 금지 ADR-0010은 프로덕션 값 복제를 막는 것이지, 이 오라클 계산 자체를 막지 않는다)', () => {
    const expectedRad = (0.5 * Math.PI) / 180
    expect(DEFAULT_SPREAD.coneRadiusRad).toBeCloseTo(expectedRad, 12)
  })

  it('DEFAULT_SPREAD.movingMultiplier는 2, airborneMultiplier는 4다(v1.8 확정값)', () => {
    expect(DEFAULT_SPREAD.movingMultiplier).toBe(2)
    expect(DEFAULT_SPREAD.airborneMultiplier).toBe(4)
  })

  it('저하 배율은 단조 비감소다(정지 ≤ 이동 ≤ 공중) — DEFAULT_SPREAD 설정값 자체의 불변식(미래에 값이 뒤집히는 회귀를 막는다)', () => {
    expect(DEFAULT_SPREAD.movingMultiplier).toBeGreaterThanOrEqual(1)
    expect(DEFAULT_SPREAD.airborneMultiplier).toBeGreaterThanOrEqual(DEFAULT_SPREAD.movingMultiplier)
  })

  // 손으로 검산 가능한 임의 튜닝(TEST_HITBOX와 동일 정신 — DEFAULT_SPREAD의
  // 실제값과 별개로 "구조"만 확인한다).
  const TUNING: SpreadTuning = { coneRadiusRad: 0.1, movingMultiplier: 2, airborneMultiplier: 4 }

  it("mode==='crouch'면 수평 입력이 있어도(=앉은 채 이동, crouch-walk) 기본 콘(×1)이다 — '정지·앉기' tier의 OR 조건(v1.9)", () => {
    expect(effectiveSpreadConeRadius(TUNING, 0, 0, 'crouch', true)).toBeCloseTo(0.1, 12) // 앉아서 정지
    expect(effectiveSpreadConeRadius(TUNING, 1, 0, 'crouch', true)).toBeCloseTo(0.1, 12) // 앉아서 이동(+X) — 그래도 ×1
    expect(effectiveSpreadConeRadius(TUNING, 0, -1, 'crouch', true)).toBeCloseTo(0.1, 12) // 앉아서 이동(-Z) — 그래도 ×1
  })

  it("mode==='run'|'walk'이고 수평 입력이 전혀 없으면(dirX=dirZ=0) 기본 콘(×1)이다 — v1.9 신설: v1.8에서는 이 상태가 mode만으로는 표현 불가능해 '이동'으로 오분류됐다(coder 실측 발견, 통합 4파일 회귀의 근본 원인)", () => {
    expect(effectiveSpreadConeRadius(TUNING, 0, 0, 'run', true)).toBeCloseTo(0.1, 12)
    expect(effectiveSpreadConeRadius(TUNING, 0, 0, 'walk', true)).toBeCloseTo(0.1, 12)
  })

  it("mode==='walk'|'run'이고 수평 입력이 있으면(dirX≠0 또는 dirZ≠0) 이동 배율(×2)이다 — '이동(걷기·달리기)' tier — v1.8 원문이 walk·run 둘 다 명시, v1.9가 '실제로 움직이는 중'이라는 조건을 추가했다", () => {
    expect(effectiveSpreadConeRadius(TUNING, 1, 0, 'walk', true)).toBeCloseTo(0.2, 12) // dirX만 0이 아님
    expect(effectiveSpreadConeRadius(TUNING, 0, 1, 'run', true)).toBeCloseTo(0.2, 12) // dirZ만 0이 아님
    expect(effectiveSpreadConeRadius(TUNING, 0.7, 0.7, 'run', true)).toBeCloseTo(0.2, 12) // 대각선 입력
  })

  it('grounded=false면 dirX·dirZ·mode와 전부 무관하게 공중 배율(×4)이다 — 정지 조합·이동 조합 둘 다 접지 여부가 우선한다(파일 상단 REV "우선순위" 확정을 직접 고정, team-lead 회신)', () => {
    expect(effectiveSpreadConeRadius(TUNING, 0, 0, 'crouch', false)).toBeCloseTo(0.4, 12) // 정지 조합이었을 값
    expect(effectiveSpreadConeRadius(TUNING, 0, 0, 'run', false)).toBeCloseTo(0.4, 12) // v1.9 신설 정지 조합이었을 값
    expect(effectiveSpreadConeRadius(TUNING, 1, 0, 'walk', false)).toBeCloseTo(0.4, 12) // 이동 조합이었을 값
  })

  it('DEFAULT_SPREAD 실측값 기준으로도 세 tier가 단조 비감소다(정지 ≤ 이동 ≤ 공중)', () => {
    const stationary = effectiveSpreadConeRadius(DEFAULT_SPREAD, 0, 0, 'run', true) // v1.9: 정지는 idle로 표현
    const moving = effectiveSpreadConeRadius(DEFAULT_SPREAD, 1, 0, 'run', true)
    const airborne = effectiveSpreadConeRadius(DEFAULT_SPREAD, 1, 0, 'run', false)
    expect(stationary).toBeLessThanOrEqual(moving)
    expect(moving).toBeLessThanOrEqual(airborne)
  })

  it('같은 시드에서 콘 반경이 커지면(=저하가 심해지면) applySpread의 편차각은 감소하지 않는다(단조 — "저하"라는 말의 실제 물리적 근거를 순수 수식 수준에서 고정한다)', () => {
    for (const seed of [1, 5, 17, 100, 777]) {
      const thetaBase = angleBetween(AIM, applySpread(AIM, createRng(seed), 0.1))
      const thetaMoving = angleBetween(AIM, applySpread(AIM, createRng(seed), 0.2))
      const thetaAirborne = angleBetween(AIM, applySpread(AIM, createRng(seed), 0.4))
      expect(thetaMoving).toBeGreaterThanOrEqual(thetaBase - 1e-9)
      expect(thetaAirborne).toBeGreaterThanOrEqual(thetaMoving - 1e-9)
    }
  })

  it('콘 내부 균등분포(입체각 기준) — 결정론적 시드 2000개 표본의 입체각 비율이 4개 구간에 고르게 분산된다(랜덤 통계 검정이 아니다, ADR-0008 — 고정 시드·고정 표본수라 실행마다 항상 같은 결과를 낸다)', () => {
    // applySpread의 공식(cosTheta = 1 - u1*(1-cosConeEdge))에서, 입체각
    // 비율 (1-cosTheta)/(1-cosConeEdge)는 정의상 u1과 같다 — u1이
    // [0,1)에서 균등이면 이 비율도 균등해야 한다. 4개 구간(버킷)에 표본이
    // 고르게 흩어지는지로 이를 간접 확인한다(결정론적 시드 1..2000 고정 —
    // 매 실행 항상 같은 카운트).
    const coneRadiusRad = 0.3
    const cosConeEdge = Math.cos(coneRadiusRad)
    const SAMPLE = 2000
    const BUCKETS = 4
    const counts = new Array(BUCKETS).fill(0) as number[]
    for (let seed = 1; seed <= SAMPLE; seed++) {
      const theta = angleBetween(AIM, applySpread(AIM, createRng(seed), coneRadiusRad))
      const cosTheta = Math.cos(theta)
      const solidFrac = (1 - cosTheta) / (1 - cosConeEdge)
      const bucket = Math.min(BUCKETS - 1, Math.max(0, Math.floor(solidFrac * BUCKETS)))
      counts[bucket] = (counts[bucket] ?? 0) + 1
    }
    const expectedPerBucket = SAMPLE / BUCKETS
    for (const count of counts) {
      expect(count).toBeGreaterThan(expectedPerBucket * 0.5)
      expect(count).toBeLessThan(expectedPerBucket * 1.5)
    }
  })

  it('판정 근거 제한(타입 잠금) — effectiveSpreadConeRadius는 tuning·dirX·dirZ·mode·grounded 다섯 파라미터만 받는다(v1.9). 시점 회전·자기신고 같은 6번째 인자를 추가하면 컴파일 타임에 거부된다(이 줄 자체가 타입 에러 나지 않으면 아래 지시문이 "사용되지 않음" 에러로 tsc를 실패시킨다)', () => {
    // @ts-expect-error — RQ-90 v1.9 "판정 근거 제한": dirX·dirZ·mode·
    // grounded 외 값(예: 시점 회전 viewYaw)을 판정에 쓰지 않는다는 계약을
    // 초과 인자 거부로 고정한다.
    effectiveSpreadConeRadius(DEFAULT_SPREAD, 0, 0, 'run', true, { viewYaw: 1.2 })
    expect(true).toBe(true) // 도달 자체는 관심사가 아니다 — 위 타입 에러가 이 테스트의 본체다.
  })
})
