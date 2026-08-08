import { describe, expect, it } from 'vitest'
import {
  applyDamage,
  applySpread,
  canFire,
  damageForRegion,
  effectiveSpreadConeRadius,
  eyeOrigin,
  findClosestHit,
  hitboxForMode,
  raycastHitbox,
  type HitboxConfig,
  type HitCandidate,
  type Ray,
  type TargetPose,
  type Vec3,
} from '@shared/sim/combat'
import { createRng } from '@shared/sim/rng'
import { CROUCH_HITBOX, DEFAULT_HITBOX, DEFAULT_SPREAD, type SpreadTuning } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'
import type { WallAABB } from '@shared/sim/movement'

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
 * **시그니처 최종 확정(team-lead, 위치 인자 5개로 환원)**: 한때 클라
 * 입력(`dirX`·`dirZ`·`mode`)을 `SpreadBasis` 객체 하나로 묶는 arity-3
 * 형태가 검토됐으나(초과 프로퍼티 검사가 arity 잠금보다 정확한 잠금이라는
 * 근거), 격리 tsc 실측으로 **번복**됐다 — 초과 프로퍼티 검사는 fresh
 * 객체 리터럴에만 걸리고, `handleFire`가 실제로 다루는 형태인 `MoveInput`
 * **변수**(넓은 타입)를 그대로 넘기면 구조적 호환으로 통과해버려(`declare
 * const mi: MoveInput; objForm(mi, true)` → 에러 없음) "클라 객체를
 * 통째로 넘기기"를 막지 못했다. 위치 인자는 호출부마다 `dirX`·`dirZ`·
 * `mode`로의 분해를 강제해 그 경로를 구조적으로 차단한다 — 그래서
 * 5-위치인자가 최종이다.
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
 *
 * **REV3(RQ-92 v2.2, 2026-08-07) — 앉은 자세 눈높이·히트박스(그린필드
 * 확장, test-writer 지정, 위 REV·REV2 태그와 동일 권한)**: `requirements.md`
 * v2.2가 앉기(`mode==='crouch'`) 상태의 눈높이·히트박스 5개 값(눈높이
 * 1.222 · 바디 상단 1.050 · 헤드 중심 1.200, 헤드 반경 0.15·바디 반경 0.3은
 * 불변)을 확정했다 — 자세 판정은 서버가 관측하는 `mode`로만 하고(RQ-61,
 * 클라 자기신고 금지), 전환은 같은 호출 안에서 즉시 반영되며 전환 보간·
 * 자세 진행도 상태를 두지 않는다. 앉은 채 점프해도 점프 높이는 1.0m
 * 그대로이고 crouch-jump 특례를 두지 않는다.
 *
 * **값 유도(ADR-0010, 리터럴 금지) — CS 관례, 두 비율을 각각 적용(사용자
 * 결정)**: 눈높이는 `DEFAULT_HITBOX.eyeHeightM × 46/64`, 전신(발~정수리
 * 높이, `headCenterM+headRadiusM`)은 `× 54/72`에서 유도한다(두 비율이 다른
 * 것은 CS 자체가 그렇기 때문 — 하나로 뭉뚱그리지 않는다). 헤드 반경은
 * 스케일하지 않는다 — 그래서 `headCenterM`·`bodyTopM`은 스케일된 전신
 * 높이에서 **역산**한다(`headCenterM = 전신높이 - headRadiusM`,
 * `bodyTopM = headCenterM - headRadiusM` — 가정 A "겹침 없이 맞닿는다"를
 * 자동으로 보존). 아래 테스트들은 이 두 원시 비율(46/64·54/72)에서
 * **독립적으로 재계산**해 `CROUCH_HITBOX`와 대조한다(`DEFAULT_SPREAD
 * .coneRadiusRad`를 `(0.5*Math.PI)/180`과 대조하는 위 REV2 오라클과 동일한
 * 정신 — "리터럴 금지"는 프로덕션 값 복제를 막는 것이지 이 오라클 계산
 * 자체를 막지 않는다) — 앉은 값 5개(1.222·1.050·1.200·0.15·0.3)를 이
 * 파일에 매직넘버로 직접 박지 않는다.
 *
 * ```ts
 * // src/shared/config/combat-tuning.ts (확장)
 * // CROUCH_HITBOX — DEFAULT_HITBOX(선 자세)에서 유도한 앉은 자세 히트박스.
 * // headRadiusM·bodyRadiusM·bodyBottomM은 DEFAULT_HITBOX와 완전히 동일
 * // (불변). eyeHeightM·headCenterM·bodyTopM은 위 "값 유도" 절의 두 비율에서
 * // 계산한다.
 * export const CROUCH_HITBOX: HitboxConfig & { eyeHeightM: number }
 *
 * // src/shared/sim/combat.ts (확장) — 자세(mode)→히트박스 판정. eyeOrigin·
 * // effectiveSpreadConeRadius와 동일한 정신: standing/crouch 값을 함수
 * // 내부에서 직접 import하지 않고 호출자가 둘 다 인자로 넘긴다(config→sim
 * // 의존 방향 유지, combat-tuning.ts가 이미 명시한 방향). grounded는
 * // 받지 않는다 — RQ-92 원문이 "앉은 채 점프해도 crouch-jump 특례를 두지
 * // 않는다"고 명시했으므로 공중 여부는 이 판정에 관여하지 않는다(판정
 * // 근거 제한 — 아래 타입 잠금 테스트가 컴파일 타임에 고정한다).
 * export function hitboxForMode(
 *   standing: HitboxConfig & { eyeHeightM: number },
 *   crouch: HitboxConfig & { eyeHeightM: number },
 *   mode: 'run' | 'walk' | 'crouch', // @shared/sim/movement의 MoveInput['mode']와 동일 유니언
 * ): HitboxConfig & { eyeHeightM: number }
 * // mode==='crouch'면 crouch를, 그 외(run·walk)는 standing을 값 그대로
 * // 반환한다 — 순수 함수라 이전 호출을 기억하지 않으므로 "즉시 전환·
 * // 보간 없음"(GA-67)이 계약 자체로 성립한다.
 * ```
 *
 * **레벨 분리(ADR-0008/ADR-0011)**: GA-64~68의 1차 정본 검증은
 * `tests/integration/rq-92-crouch-stance.test.ts`(실 `GameRoom.handleFire`
 * 배선 — 사수 자신의 `mode`가 자신의 레이 원점에, 각 대상 자신의 `mode`가
 * 그 대상의 히트박스에 반영되는지 실 Colyseus 룸 경계에서 관측) — 골든
 * JSONL의 `verify` 필드가 그 경로를 지정한다. **그 파일이 요구하는 신규
 * 배선 계약(coder에게)**: `GameRoom`은 지금까지 사수 자신의 `pendingInputs`
 * (`mode`)만 읽었는데(탄퍼짐 판정), 이제 **각 피격 후보 자신의**
 * `pendingInputs.get(candidateId)?.mode`(없으면 `IDLE_MOVE_INPUT`, 기존
 * 폴백과 동일 관례)도 읽어 그 후보의 히트박스를 `hitboxForMode`로 개별
 * 해석해야 한다 — `findClosestHit`의 3번째 인자(`hitbox`)가 지금은 모든
 * 후보에 균일하게 적용되므로, 서로 다른 자세가 섞인 후보 집합을 다루려면
 * 호출부(`GameRoom`)가 자세별로 후보를 묶어 `findClosestHit`을 자세 그룹당
 * 한 번씩(예: 선 자세 그룹·앉은 자세 그룹) 호출한 뒤 전체에서 가장 가까운
 * 결과를 취하는 식으로 처리해야 한다(정확한 구현 방식은 coder 재량 —
 * `raycastHitbox`/`findClosestHit`의 기존 시그니처는 이 라운드가 바꾸지
 * 않는다, 아래 "블라스트 반경" 절 참고). 이 파일(단위)은 그 통합 시나리오가
 * 의존하는 순수 산술(`hitboxForMode`·`CROUCH_HITBOX`의 형상·경계)을
 * 결정론적으로 미리 잠근다.
 *
 * **블라스트 반경 결정(coder에게) — `raycastHitbox`/`findClosestHit`
 * 시그니처는 이 라운드가 바꾸지 않는다**: `DEFAULT_HITBOX.eyeHeightM`을
 * 참조하는 기존 통합 테스트 28개·`findClosestHit`/`raycastHitbox`를 직접
 * 호출하는 기존 단위 테스트 전부가 이 두 함수의 현재 시그니처(균일
 * `hitbox` 인자)에 의존한다 — 이 라운드는 새 순수 함수(`hitboxForMode`)와
 * 새 설정값(`CROUCH_HITBOX`)만 추가하고 기존 함수 시그니처는 그대로 둔다.
 * **실측(test-writer, 이 라운드) — 위 28개 파일 중 실제로 앉은 사수/대상을
 * 시뮬레이션하는 파일은 0건이다**(전수 확인 — `'crouch'`를 쓰는 9파일 중
 * hitscan과 겹치는 4파일을 직접 대조했다: (1) `tests/integration/rq-90
 * -spread-degradation.test.ts` — `'crouch'`는 `PendingInputSnapshot` 타입
 * 선언에만 등장, 실제 `setShooterState` 호출은 전부 `mode:'run'`/`'walk'`.
 * (2) `tests/integration/rq-43-afk-kick.test.ts` — `'crouch'`는 코멘트에만
 * 등장, 실제 `fire`는 `dirY:1`(항상 빗나가는 방향)이라 명중 판정 자체가
 * 관심사가 아니다. (3) `tests/unit/rq-40-chat-input-gate.test.ts` —
 * `'crouch'`는 `MoveInput` 리터럴 값이지만 그 파일 자체 docblock이 "mode
 * 필드 값에 결합하는 것은 과잉 사양"이라 명시해 게이팅 로직이 `mode`
 * 무관임을 규정했었다(그 문장은 이후 RQ-40 v2.3으로 뒤집혔다 — 그 파일
 * 참고, 이 라운드 시점에는 아직 유효했다). (4) 이 파일 자신의
 * `effectiveSpreadConeRadius` `'crouch'` 테스트는 탄퍼짐 콘 tier만
 * 검사해 히트박스·눈높이와 무관) — 따라서 이 라운드는 기존 테스트
 * 파일을 **한 곳도 수정하지 않는다**.
 * **정정(PR #68 리뷰 major, 원장 24ax)**: 위 문장은 이 시점(F1/F2
 * 검출력 보강) 기준으로는 사실이었으나 그 뒤 **거짓이 됐다** —
 * `tests/unit/rq-40-chat-input-gate.test.ts`는 RQ-40 v2.3 대응으로
 * 수정했다(docblock + `it` 2건 순증, **기존 단언 무변경** — 커밋
 * `d66fe22`·`8acf46a`). 바로 위 (3)이 "그 문장은 이후 RQ-40 v2.3으로
 * 뒤집혔다"고 이미 적어 두고도 이 결론 문장은 갱신하지 않았던 것이
 * 리뷰에서 지적됐다 — 원래 문장은 지우지 않고 정정을 붙인다(다음
 * 사람이 왜 뒤집혔는지 볼 수 있어야 한다).
 *
 * **GA-66(차폐) 한계 — 명시적 가정**: `WallAABB`(`@shared/sim/movement`)는
 * "무한 높이 기둥"이다(`minY`/`maxY` 없음 — 그 파일 자체 docblock이 "의도"
 * 라고 명시). GA-66의 given("높이 1.5m의 정적 지오메트리")·then("앉은 헤드
 * 상단 1.350m < 지오메트리 상단 1.5m")이 서술하는 **유한 높이 차폐**는 이
 * 코드베이스의 벽 모델이 표현할 수 없다 — occlusion 판정(`intersectWallXZ`)
 * 이 y를 전혀 보지 않는다(XZ 슬랩만, `dir.y`·`o.y` 어디에도 등장하지 않는다
 * — `combat.ts` 참고). 아래 GA-66 테스트·통합 파일 둘 다 "앉은 자세로
 * 해석된 대상 위치에도 기존 차폐 규칙이 정상 적용되는가"만 검증한다 —
 * "서 있었다면 노출됐을 것"이라는 높이 차등 자체는 현재 원시 타입으로
 * 검증할 수 없다(team-lead 보고 대상).
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

  it("u1(1차 nextFloat)→cosTheta·u2(2차 nextFloat)→phi 매핑 자체를 고정한다 — applySpread를 호출하지 않는 독립 오라클(리뷰 22z: 위 균등분포 검정은 u1↔u2를 바꿔도 통과하므로 이 매핑을 잠그지 못한다)", () => {
    // 22z 공백: 위 "균등분포" 검정은 solidFrac=(1-cosTheta)/(1-cosConeEdge)가
    // u1과 같다는 사실만 확인한다 — u1·u2는 둘 다 SeededRng에서 독립적으로
    // 뽑은 [0,1) 균등 표본이라, applySpread 내부에서 이 둘의 **역할을
    // 통째로 바꿔도**(cosTheta를 u2로, phi를 u1로 계산) solidFrac의 한계
    // 분포는 여전히 균등이다 — 위 검정은 그 변이를 검출하지 못한다(리뷰어가
    // 실측 지적, `AIRBORNE_INJECT_Y_M=2`류 변이 주입과 같은 방법론).
    //
    // 이 테스트는 `applySpread`를 호출하지 않는 별도 계산으로 AIM=(0,0,1)
    // 고정 시 기대 벡터를 손으로 유도해 고정한다: `applySpread`의 기저
    // 구성(`helper = |dir.x|<0.9 ? (1,0,0) : (0,1,0)`, `u=normalize(cross
    // (helper,dir))`, `v=cross(dir,u)`)에 dir=AIM=(0,0,1)을 대입하면
    // helper=(1,0,0)이고 u=cross((1,0,0),(0,0,1))=(0,-1,0)(이미 단위벡터),
    // v=cross((0,0,1),(0,-1,0))=(1,0,0) — 대수로 유도되는 상수이지
    // `applySpread`를 실행해서 얻은 값이 아니다. 이 기저를
    //   result = u*localX + v*localY + dir*cosTheta
    //          = (0,-1,0)*localX + (1,0,0)*localY + (0,0,1)*cosTheta
    //          = (localY, -localX, cosTheta)
    // 에 대입하고, `localX=sinTheta*cos(phi)`·`localY=sinTheta*sin(phi)`를
    // 펼치면:
    //   result = (sinTheta*sin(phi), -sinTheta*cos(phi), cosTheta)
    // 이 닫힌 형태가 이 테스트의 오라클이다 — **u1이 cosTheta 쪽에, u2가
    // phi 쪽에 매핑된다고 고정**한 뒤 그 결과를 아래 표에 리터럴로 박아
    // 둔다(실행 시점에 이 공식을 다시 계산하지 않는다 — 그러면
    // `applySpread`와 똑같은 코드를 중복해 "독립 오라클"이라는 목적 자체가
    // 무너진다). 표의 수치는 실제 프로덕션 상수(`SeededRng.nextFloat`의
    // mulberry32류 알고리즘, `@shared/sim/rng`)로 u1·u2를 뽑아 위 공식에
    // 대입해 계산했다(스크래치 스크립트, 커밋 안 함 —
    // `_workspace/RQ-90-spread/01_test-writer_red.md` §17.5에 유도 과정·
    // u1↔u2 반전 시 달라지는 값까지 전문 기록, |Δ|=0.045~0.398로 5개 시드
    // 전부에서 변이가 검출된다).
    const coneRadiusRad = 0.3
    const golden: ReadonlyArray<{ seed: number; expected: Vec3 }> = [
      { seed: 1, expected: { x: 0.004039417748635903, y: -0.2349764253043673, z: 0.9719926762354916 } },
      { seed: 7, expected: { x: 0.012270698614852932, y: -0.029911659948602974, z: 0.9994772246302677 } },
      { seed: 42, expected: { x: 0.07347057548935987, y: 0.21811946121080833, z: 0.9731525960394747 } },
      { seed: 12345, expected: { x: 0.2741724804161466, y: 0.1021317168494663, z: 0.9562418958589077 } },
      { seed: 999999, expected: { x: 0.009066148483765147, y: 0.056467601583452896, z: 0.9983632680157473 } },
    ]
    for (const { seed, expected } of golden) {
      const actual = applySpread(AIM, createRng(seed), coneRadiusRad)
      expect(actual.x).toBeCloseTo(expected.x, 9)
      expect(actual.y).toBeCloseTo(expected.y, 9)
      expect(actual.z).toBeCloseTo(expected.z, 9)
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

// -----------------------------------------------------------------------
// RQ-92 v2.2 — 앉은 자세 눈높이·히트박스(CROUCH_HITBOX·hitboxForMode).
// 파일 상단 REV3 계약 참고. GA-64~68(harness/evals/golden/track-a-product
// .jsonl) — 1차 정본은 tests/integration/rq-92-crouch-stance.test.ts이고,
// 이 describe들은 그 통합 시나리오가 의존하는 순수 산술을 미리 잠근다.
// -----------------------------------------------------------------------

describe('RQ-92 v2.2 CROUCH_HITBOX — DEFAULT_HITBOX(선 자세)에서 유도(ADR-0010, 리터럴 금지)', () => {
  it('eyeHeightM = DEFAULT_HITBOX.eyeHeightM × 46/64(CS 눈높이 비율, requirements.md v2.2 사용자 결정)', () => {
    const expected = DEFAULT_HITBOX.eyeHeightM * (46 / 64)
    expect(CROUCH_HITBOX.eyeHeightM).toBeCloseTo(expected, 9)
    expect(CROUCH_HITBOX.eyeHeightM).toBeCloseTo(1.222, 3) // 앵커 — v2.2 표기값(1.222)과 일치 확인
  })

  it('headCenterM·bodyTopM은 전신(발~정수리) 스케일 54/72(requirements.md v2.2)에서 역산된다 — 헤드 반경은 스케일하지 않는다', () => {
    const totalHeightStanding = DEFAULT_HITBOX.headCenterM + DEFAULT_HITBOX.headRadiusM // 정수리 높이(1.80)
    const totalHeightCrouch = totalHeightStanding * (54 / 72)
    const expectedHeadCenterM = totalHeightCrouch - DEFAULT_HITBOX.headRadiusM
    const expectedBodyTopM = expectedHeadCenterM - DEFAULT_HITBOX.headRadiusM

    expect(CROUCH_HITBOX.headCenterM).toBeCloseTo(expectedHeadCenterM, 9)
    expect(CROUCH_HITBOX.bodyTopM).toBeCloseTo(expectedBodyTopM, 9)
    expect(CROUCH_HITBOX.headCenterM).toBeCloseTo(1.2, 3) // 앵커 — v2.2 표기값
    expect(CROUCH_HITBOX.bodyTopM).toBeCloseTo(1.05, 3) // 앵커 — v2.2 표기값
  })

  it('헤드 반경·바디 반경·바디 하단은 선 자세와 완전히 동일하다(불변, requirements.md v2.2)', () => {
    expect(CROUCH_HITBOX.headRadiusM).toBe(DEFAULT_HITBOX.headRadiusM)
    expect(CROUCH_HITBOX.bodyRadiusM).toBe(DEFAULT_HITBOX.bodyRadiusM)
    expect(CROUCH_HITBOX.bodyBottomM).toBe(DEFAULT_HITBOX.bodyBottomM)
  })

  it('GA-65: 앉은 자세에서도 가정 A(머리 볼륨이 몸통 상단과 겹치지 않고 맞닿는다)가 유지된다 — headCenterM - headRadiusM === bodyTopM', () => {
    expect(CROUCH_HITBOX.headCenterM - CROUCH_HITBOX.headRadiusM).toBeCloseTo(CROUCH_HITBOX.bodyTopM, 9)
  })

  it('GA-65: 헤드 볼륨은 [1.050, 1.350], 바디 볼륨은 [0, 1.050]이다', () => {
    expect(CROUCH_HITBOX.headCenterM - CROUCH_HITBOX.headRadiusM).toBeCloseTo(1.05, 3)
    expect(CROUCH_HITBOX.headCenterM + CROUCH_HITBOX.headRadiusM).toBeCloseTo(1.35, 3)
    expect(CROUCH_HITBOX.bodyBottomM).toBe(0)
    expect(CROUCH_HITBOX.bodyTopM).toBeCloseTo(1.05, 3)
  })
})

describe('RQ-92 v2.2 hitboxForMode — mode에 따라 즉시 전환(전환 보간·진행도 상태 없음, GA-67)', () => {
  it("GA-68: mode==='run'이면 선 자세(DEFAULT_HITBOX)를 값 그대로 반환한다 — 자세 도입이 선 자세 값을 건드리지 않는다는 회귀 가드", () => {
    expect(hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, 'run')).toEqual(DEFAULT_HITBOX)
  })

  it("mode==='walk'도 선 자세를 반환한다 — 앉기(crouch)만 자세 전환을 유발한다", () => {
    expect(hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, 'walk')).toEqual(DEFAULT_HITBOX)
  })

  it("mode==='crouch'면 앉은 자세(CROUCH_HITBOX)를 값 그대로 반환한다", () => {
    expect(hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, 'crouch')).toEqual(CROUCH_HITBOX)
  })

  it('GA-67: crouch → run 전환은 다음 호출에서 즉시 반영된다 — 순수 함수라 직전 호출의 결과를 기억하지 않으므로 보간·진행도 상태 자체가 존재할 수 없다는 것을 구조로 고정한다', () => {
    expect(hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, 'crouch')).toEqual(CROUCH_HITBOX)
    expect(hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, 'run')).toEqual(DEFAULT_HITBOX) // 직전 호출과 완전히 무관 — 즉시 선 자세로
  })

  // 판정 근거 제한(타입 잠금, `effectiveSpreadConeRadius`의 "@ts-expect-error"
  // 테스트와 동일 정신 — standing·crouch·mode 세 파라미터만 받고, grounded
  // 등 4번째 인자를 추가하면 컴파일 타임에 거부되어야 한다: crouch-jump
  // 특례를 두지 않는다는 RQ-92 원문의 타입 수준 보증)는 **여기서는 쓸 수
  // 없다** — `hitboxForMode`가 아직 존재하지 않아 임포트가 실패하고
  // (TS2305, 위), 실패한 임포트는 TS가 `any`로 취급해 초과 인자를 줘도
  // 컴파일 에러가 나지 않는다(`@ts-expect-error`가 "사용되지 않음"으로
  // 오히려 tsc를 실패시킨다 — 실측: `tsc --noEmit`이 "error TS2578: Unused
  // '@ts-expect-error' directive"를 낸다). `effectiveSpreadConeRadius`의 타입
  // 잠금 테스트가 성립하는 이유는 그 함수가 v1.9 **이전부터 이미 존재**
  // 해서(다른 인자 개수로) 임포트가 항상 성공하기 때문이다 — 신설 함수는
  // 이 기법을 Red 단계에 쓸 수 없다. coder가 Green으로 구현한 뒤 이
  // 타입 잠금 테스트를 별도로 추가해야 한다(하드닝 후속 작업 — 보고서에
  // 명시).

  it('참조 동일성 — hitboxForMode는 입력으로 받은 두 객체 중 하나를 그대로(새로 만들지 않고) 반환한다(원장 24az PR #69 리뷰 minor 6(b))', () => {
    // `nameplateTarget.ts`의 자세 그룹 판정이
    // `hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, mode) === CROUCH_HITBOX`
    // 형태로 **참조 동일성**에 의존한다. 이 함수가 훗날 `{ ...crouch }`처럼
    // 복사본을 반환하도록 바뀌면 그 판정은 항상 선 자세 쪽으로만 떨어진다
    // (간접적으로는 GA-74 케이스가 죽어 잡히지만, 그 계약 자체에 대한
    // 직접 단언은 이 파일에 없었다).
    // ⚠️ 반드시 `toBe`(참조 동일성)여야 한다 — `toEqual`(값 동일성)은
    // 복사본도 통과시켜 이 계약을 전혀 지키지 않는다.
    expect(hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, 'crouch')).toBe(CROUCH_HITBOX)
    expect(hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, 'run')).toBe(DEFAULT_HITBOX)
  })
})

describe('GA-64 — eyeOrigin + hitboxForMode(crouch) 합성: 앉은 사수의 레이 원점은 발 + 1.222m다(선 자세 1.700이 아니다)', () => {
  it('GA-64: 앉은 사수의 eyeOrigin.y는 CROUCH_HITBOX.eyeHeightM이고 선 자세 값과 다르다', () => {
    const foot: Vec3 = { x: 5, y: 0, z: -3 }
    const hitbox = hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, 'crouch')
    const origin = eyeOrigin(foot, hitbox.eyeHeightM)

    expect(origin).toEqual({ x: 5, y: CROUCH_HITBOX.eyeHeightM, z: -3 })
    expect(origin.y).not.toBeCloseTo(DEFAULT_HITBOX.eyeHeightM, 2)
  })

  it('GA-64: 발이 원점이 아니어도(예: 스폰 좌표) y만 CROUCH_HITBOX.eyeHeightM만큼 더해진다', () => {
    const foot: Vec3 = { x: 0, y: 0, z: 10 }
    const hitbox = hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, 'crouch')
    expect(eyeOrigin(foot, hitbox.eyeHeightM)).toEqual({ x: 0, y: CROUCH_HITBOX.eyeHeightM, z: 10 })
  })
})

describe('GA-65 — 앉은 대상의 raycastHitbox 판정: 헤드 [1.050,1.350]·바디 [0,1.050], 자세가 바뀌면 같은 높이의 판정도 바뀐다', () => {
  it('GA-65: 앉은 헤드 중심(1.200m) 관통 레이는 헤드에 명중한다', () => {
    const ray: Ray = { origin: { x: 0, y: CROUCH_HITBOX.headCenterM, z: -10 }, direction: { x: 0, y: 0, z: 1 } }
    const result = raycastHitbox(ray, ORIGIN_TARGET, CROUCH_HITBOX)
    expect(result.hit).toBe(true)
    expect(result.region).toBe('head')
  })

  it('GA-65: 앉은 바디 중앙(0.525m) 관통 레이는 바디에 명중한다', () => {
    const bodyMidM = (CROUCH_HITBOX.bodyBottomM + CROUCH_HITBOX.bodyTopM) / 2
    const ray: Ray = { origin: { x: 0, y: bodyMidM, z: -10 }, direction: { x: 0, y: 0, z: 1 } }
    const result = raycastHitbox(ray, ORIGIN_TARGET, CROUCH_HITBOX)
    expect(result.hit).toBe(true)
    expect(result.region).toBe('body')
  })

  it('GA-65: 앉은 헤드 볼륨 상단(1.350m)을 넘는 높이는 명중하지 않는다 — 선 자세였다면 여전히 몸통 범위([0,1.5]) 안이었을 높이라는 것을 대조로 직접 확인한다', () => {
    const aboveCrouchHeadTop = CROUCH_HITBOX.headCenterM + CROUCH_HITBOX.headRadiusM + 0.01 // ≈1.360
    const ray: Ray = { origin: { x: 0, y: aboveCrouchHeadTop, z: -10 }, direction: { x: 0, y: 0, z: 1 } }

    const crouchResult = raycastHitbox(ray, ORIGIN_TARGET, CROUCH_HITBOX)
    expect(crouchResult.hit).toBe(false)

    const standingResult = raycastHitbox(ray, ORIGIN_TARGET, DEFAULT_HITBOX)
    expect(standingResult.hit).toBe(true)
    expect(standingResult.region).toBe('body') // 자세가 다르면 같은 높이의 판정도 달라진다
  })
})

describe('GA-66 — 앉은 자세 + 사수·대상 사이 정적 지오메트리(RQ-12 v1.7 차폐)', () => {
  /**
   * **한계(파일 상단 REV3 "GA-66 한계" 절 참고)**: `WallAABB`는 무한 높이
   * 기둥이라 GA-66이 서술하는 "1.5m 높이 지오메트리" 자체는 표현할 수
   * 없다 — 아래 두 테스트는 "앉은 자세로 해석된 대상 위치에도 기존 차폐
   * 규칙이 정상 적용되는가"만 검증한다(높이 차등 자체는 검증 대상 밖).
   */
  it('GA-66: 사수·대상 사이를 가로막는 벽이 있으면, 앉은 대상의 실제 머리(1.200m)를 정확히 겨냥해도 명중 후보에서 제외된다(차폐)', () => {
    const target: TargetPose = { position: { x: 0, y: 0, z: 10 } }
    const wall: WallAABB = { minX: -1, maxX: 1, minZ: 4, maxZ: 6 } // 사수(z=0)·대상(z=10) 사이를 가로지른다
    const ray: Ray = { origin: { x: 0, y: CROUCH_HITBOX.headCenterM, z: 0 }, direction: { x: 0, y: 0, z: 1 } }
    const candidates: HitCandidate[] = [{ id: 'target', pose: target }]

    const closest = findClosestHit(ray, candidates, CROUCH_HITBOX, [wall])
    expect(closest).toBeUndefined()
  })

  it('양성 대조군 — 같은 배치에서 벽이 없으면(walls=[]) 정상 명중한다(위 미스가 진짜 차폐 때문임을 확인)', () => {
    const target: TargetPose = { position: { x: 0, y: 0, z: 10 } }
    const ray: Ray = { origin: { x: 0, y: CROUCH_HITBOX.headCenterM, z: 0 }, direction: { x: 0, y: 0, z: 1 } }
    const candidates: HitCandidate[] = [{ id: 'target', pose: target }]

    const closest = findClosestHit(ray, candidates, CROUCH_HITBOX, [])
    expect(closest?.result.hit).toBe(true)
    expect(closest?.result.region).toBe('head')
  })
})

// -----------------------------------------------------------------------
// RQ-92 검출력 보강(F2, evaluator FAIL blocker) — `DEFAULT_HITBOX`(선
// 자세)의 GA-68 값 5개 중
// `bodyTopM`(1.500)·`headCenterM`(1.650)·`headRadiusM`(0.15)는 위 GA-68
// 매핑 테스트("hitboxForMode(...).toEqual(DEFAULT_HITBOX)" 류)가 전부
// `DEFAULT_HITBOX`를 **심볼로만** 참조해, 그 상수 자체가 훼손돼도 기대값이
// 함께 움직여 공허해진다(변이 M7: `DEFAULT_HITBOX.bodyTopM` 1.5→1.4가
// 0건을 죽이고 생존 — evaluator 실측). `eyeHeightM`(M9)·`bodyRadiusM`
// (`tests/unit/24af-*-body-radius-*.test.ts`)은 이미 다른 곳에서 리터럴로
// 고정돼 있다고 evaluator가 확인했다 — 이 블록은 나머지 3개만 채운다.
// **독립 재계산이 아니라 리터럴 직접 대조인 이유**: `DEFAULT_HITBOX`는
// `CROUCH_HITBOX`처럼 다른 값에서 유도된 파생값이 아니라 이 코드베이스에서
// 가장 원시적인 값 자체(`combat-tuning.ts`에 리터럴로 적혀 있다, `requirements
// .md`가 그 원본) — 이보다 더 독립적인 유도 경로가 없으므로 스펙 문서의
// 숫자를 직접 리터럴로 대조하는 것이 맞는 형태다(ADR-0010은 "구현이 이미
// 계산한 값을 그대로 복사"를 공허하다고 금지하는 것이지, 스펙 원본 숫자를
// 그대로 단언하는 것을 금지하지 않는다 — `DEFAULT_SPREAD.coneRadiusRad`를
// `(0.5*Math.PI)/180`과 대조하는 위 REV2 오라클과 동일한 정신).
// -----------------------------------------------------------------------

describe('RQ-92 검출력 보강(F2) — GA-68 선 자세 값 리터럴 고정(DEFAULT_HITBOX 상수 자체의 훼손을 잡는다)', () => {
  it('GA-68 리터럴 고정: DEFAULT_HITBOX.bodyTopM은 1.500이다', () => {
    expect(DEFAULT_HITBOX.bodyTopM).toBe(1.5)
  })

  it('GA-68 리터럴 고정: DEFAULT_HITBOX.headCenterM은 1.650이다', () => {
    expect(DEFAULT_HITBOX.headCenterM).toBe(1.65)
  })

  it('GA-68 리터럴 고정: DEFAULT_HITBOX.headRadiusM은 0.15다', () => {
    expect(DEFAULT_HITBOX.headRadiusM).toBe(0.15)
  })
})
