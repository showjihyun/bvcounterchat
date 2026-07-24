import type { HitboxConfig } from '@shared/sim/combat'

/**
 * RQ-90/ADR-0005 튜닝값 — 히트박스 세부 치수·탄퍼짐 콘 반경. 캐릭터 모델
 * 에셋이 아직 없어 코드가 아닌 이 설정 파일의 값으로 잠정 확정한다
 * (ADR-0005 "잔존 미해결 사항" — 값 발명이 아니라 위임된 튜닝 슬롯).
 * `combat.ts`의 판정 로직과 이 값을 참조하는 테스트들은 상수를 직접 읽으므로,
 * 캐릭터 모델이 정해져 이 값만 바뀌어도 재작업이 필요 없다.
 */

export interface SpreadTuning {
  coneRadiusRad: number
}

/**
 * `eyeHeightM`은 `HitboxConfig`(§`combat.ts`) 계약에는 없는 부가 필드다 —
 * `raycastHitbox` 자신은 참조하지 않고, 사수 자신의 레이 원점(눈높이 오프셋)을
 * 계산하는 호출자(`GameRoom`, 통합 테스트의 `aimAt` 헬퍼)만 쓴다.
 * `HitboxConfig & { eyeHeightM: number }`로 명시해 `raycastHitbox`가 요구하는
 * 5개 필드는 그대로 타입 검사되면서, `.eyeHeightM` 접근도 `number`로(옵셔널이
 * 아니게) 타입이 잡힌다.
 *
 * 머리 볼륨 상단(`headCenterM + headRadiusM` = 1.80) 위로 여유를 두고
 * `eyeHeightM`을 잡은 이유: RQ-31(스폰 지점 로테이션)이 아직 없어 모든
 * 플레이어가 원점에 겹쳐 스폰한다(`GameRoom.spawnMoveState`). 눈높이가 머리
 * 볼륨 안이나 그 아래 있으면, 겹쳐 스폰한 상태에서 위쪽을 조준한 사격이
 * 상대의 머리(자기 자신이 서 있는 바로 그 자리)를 스스로 "관통"하며 명중으로
 * 오판정된다 — 눈높이를 머리 볼륨 위로 두면 이 겹쳐 스폰 시나리오에서도
 * 위쪽 조준은 항상 깨끗하게 빗나간다.
 */
export const DEFAULT_HITBOX: HitboxConfig & { eyeHeightM: number } = {
  bodyRadiusM: 0.3,
  bodyBottomM: 0,
  bodyTopM: 1.5,
  headRadiusM: 0.15,
  headCenterM: 1.65, // 머리 볼륨 [1.50, 1.80] — 바디 상단과 겹침 없이 맞닿는다(가정 A)
  eyeHeightM: 1.9, // 머리 볼륨 상단(1.80) 위 0.1m 여유
}

/** 탄퍼짐 콘 반경(RQ-90) — 실제 수치는 밸런싱 단계 결정(원장 22a, 이번 RQ
 * 범위 밖). 구조만 먼저 고정하며 기본값은 정조준(반경 0). */
export const DEFAULT_SPREAD: SpreadTuning = {
  coneRadiusRad: 0,
}
