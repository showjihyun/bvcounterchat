import type { HitboxConfig } from '@shared/sim/combat'

/**
 * RQ-90/ADR-0005 튜닝값 — 히트박스 세부 치수·탄퍼짐 콘 반경. 캐릭터 모델
 * 에셋이 아직 없어 코드가 아닌 이 설정 파일의 값으로 잠정 확정한다
 * (ADR-0005 "잔존 미해결 사항" — 값 발명이 아니라 위임된 튜닝 슬롯).
 * `combat.ts`의 판정 로직과 이 값을 참조하는 테스트들은 상수를 직접 읽으므로,
 * 캐릭터 모델이 정해져 이 값만 바뀌어도 재작업이 필요 없다.
 */

export interface SpreadTuning {
  /** 기본(정지·앉기) 콘 반경(라디안) — `BASE_CONE_RADIUS_DEG`에서 유도한다
   * (ADR-0010, 리터럴 금지). */
  coneRadiusRad: number
  /** 이동(걷기·달리기) 정확도 저하 배율(RQ-90 v1.8) — `coneRadiusRad`에
   * 곱한다. */
  movingMultiplier: number
  /** 공중(비접지) 정확도 저하 배율(RQ-90 v1.8) — `movingMultiplier` 이상이어야
   * 한다(단조, `effectiveSpreadConeRadius`의 3단계 우선순위는
   * `@shared/sim/combat` 참고). */
  airborneMultiplier: number
}

/**
 * `eyeHeightM`은 `HitboxConfig`(§`combat.ts`) 계약에는 없는 부가 필드다 —
 * `raycastHitbox` 자신은 참조하지 않고, 사수 자신의 레이 원점(눈높이 오프셋)을
 * 계산하는 호출자(`GameRoom`, 통합 테스트의 `aimAt` 헬퍼)만 쓴다.
 * `HitboxConfig & { eyeHeightM: number }`로 명시해 `raycastHitbox`가 요구하는
 * 5개 필드는 그대로 타입 검사되면서, `.eyeHeightM` 접근도 `number`로(옵셔널이
 * 아니게) 타입이 잡힌다.
 *
 * **복원 완료(RQ-15~16 라운드, item E)**: 이전에는 `eyeHeightM`을 머리
 * 볼륨 상단(`headCenterM + headRadiusM` = 1.80) 위로 인위적으로 띄워
 * 뒀다 — RQ-31(스폰 지점 로테이션)이 아직 없어 모든 플레이어가 원점에
 * 겹쳐 스폰했기 때문이다(`GameRoom.spawnMoveState`, 옛 구현). 눈높이가
 * 머리 볼륨 안이나 그 아래 있으면, 겹쳐 스폰한 상태에서 위쪽을 조준한
 * 사격이 상대의 머리(자기 자신이 서 있는 바로 그 자리)를 스스로 "관통"하며
 * 명중으로 오판정됐다.
 *
 * **복원 조건 이행(리뷰 minor, `_workspace/review/feat-RQ-12-14-combat-core.md`
 * → `_workspace/RQ-15-16/01_test-writer_red.md` §6이 GA-06 무관을 수식으로
 * 재확인)**: RQ-31(선택 규칙)이 `@shared/sim/spawn`의 순환 로테이션으로
 * 도입돼 플레이어들이 서로 다른 좌표에서 시작하므로, 겹쳐 스폰 회피
 * 목적이 사라졌다 — 평균 키(1.8m 이하)를 넘지 않는 현실값(1.7m)으로
 * 되돌렸다. GA-06(`rq-12-client-hit-claim-rejected.test.ts`)은 A·B의
 * XZ 좌표가 다르기만 하면 `eyeHeightM` 값과 무관하게 성립한다(수식적
 * 근거는 위 Red 보고서 §6) — 실측으로도 계속 Green(coder 실행 확인,
 * `_workspace/RQ-15-16/02_coder_green.md` 참고).
 */
export const DEFAULT_HITBOX: HitboxConfig & { eyeHeightM: number } = {
  bodyRadiusM: 0.3,
  bodyBottomM: 0,
  bodyTopM: 1.5,
  headRadiusM: 0.15,
  headCenterM: 1.65, // 머리 볼륨 [1.50, 1.80] — 바디 상단과 겹침 없이 맞닿는다(가정 A)
  eyeHeightM: 1.7, // 현실적인 평균 눈높이(RQ-31 비겹침 스폰 도입으로 복원, item E)
}

/** 정지·앉기(기본) 콘 반경 원시값(도) — `requirements.md` v1.8 확정값.
 * 라디안 변환은 아래 `DEFAULT_SPREAD`에서 유도한다(ADR-0010, 리터럴 금지 —
 * 프로덕션 코드가 변환된 라디안 값을 직접 복제하지 않는다). */
const BASE_CONE_RADIUS_DEG = 0.5

/** 탄퍼짐 콘 반경·저하 배율(RQ-90 v1.8) — `requirements.md` v1.8이 실제
 * 수치를 확정했다(원장 22a가 밸런싱 단계로 미뤘던 것을 이 라운드가
 * 닫는다). 저하 3단계(정지·앉기 ×1 · 이동 ×2 · 공중 ×4, 단조 증가)의
 * 판정 로직은 `@shared/sim/combat`의 `effectiveSpreadConeRadius`. */
export const DEFAULT_SPREAD: SpreadTuning = {
  coneRadiusRad: (BASE_CONE_RADIUS_DEG * Math.PI) / 180,
  movingMultiplier: 2,
  airborneMultiplier: 4,
}
