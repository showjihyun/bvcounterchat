/**
 * RQ-54 크로스헤어 확산 산술(원장 24e) — `DESIGN.md` §3.1의 "간격 = 기본 간격
 * × 콘 배율"을 구현한다.
 *
 * **이 모듈이 순수한 이유**: 렌더는 ADR-0008 §6으로 테스트가 면제되지만
 * **간격을 얼마로 할지는 산술**이고 그것은 테스트할 수 있다. 22b가
 * `aimMath`·`cameraLook`을 분리한 것과 같은 이유다 — 면제 영역을 최소로 남기고
 * 판단이 들어가는 부분은 밖으로 꺼낸다(ADR-0011 test-after, 클라 모듈).
 *
 * ⚠️ **배율을 복제하지 않는다**(ADR-0010). RQ-90의 3단계 배율(정지·앉기 ×1 /
 * 이동 ×2 / 공중 ×4)은 `DEFAULT_SPREAD`가 정본이고, 여기서는
 * `effectiveSpreadConeRadius`를 **그대로 호출해** 실효 콘 반경을 얻은 뒤 기본
 * 반경으로 나눠 배율을 **유도한다**. 배율 값이나 tier 판정 규칙(`crouch`는 이동
 * 중에도 ×1 등)을 이 파일에 옮겨 적으면 서버와 갈라진다.
 *
 * ⚠️ **크로스헤어는 예측 표시다**(RQ-62). 실제 편차는 서버가 시드로 정하고
 * 클라는 그 시드를 알 수 없다(RQ-90 / 원장 22v) — **간격은 "이만큼 퍼질 수
 * 있다"는 안내이지 탄착점이 아니다.** 서버가 보낸 판정과 어긋나면 서버가
 * 이긴다(`DESIGN.md` §0).
 */

import { effectiveSpreadConeRadius } from '@shared/sim/combat'
import { DEFAULT_SPREAD } from '@shared/config/combat-tuning'
import type { MoveInput } from '@shared/sim/movement'
import { CROSSHAIR } from '@client/config/design-tokens'

/** 현재 이동 상태의 **콘 배율** — `실효 콘 반경 / 기본 콘 반경`.
 *
 * 서버의 `effectiveSpreadConeRadius`를 그대로 부르므로 tier 판정 규칙이 한 곳에만
 * 있다. `DEFAULT_SPREAD.coneRadiusRad`가 0이면(탄퍼짐을 끈 설정) 나눗셈이 성립하지
 * 않으므로 **1을 돌려준다** — 콘이 없으면 확산도 없다는 뜻이고, 그 편이 `Infinity`나
 * `NaN`이 CSS로 흘러드는 것보다 낫다. */
export function crosshairSpreadMultiplier(
  input: Pick<MoveInput, 'dirX' | 'dirZ' | 'mode'>,
  grounded: boolean,
): number {
  const base = DEFAULT_SPREAD.coneRadiusRad
  if (base <= 0) return 1
  const effective = effectiveSpreadConeRadius(DEFAULT_SPREAD, input.dirX, input.dirZ, input.mode, grounded)
  return effective / base
}

/** 화면에 쓸 크로스헤어 간격(px) — `CROSSHAIR.gapPx × 배율`.
 *
 * `DESIGN.md` §3.1 표(정지·앉기 4px / 이동 8px / 공중 16px)가 이 식의 결과다 —
 * 그 표의 값을 상수로 옮겨 적지 않는다. */
export function crosshairGapPx(
  input: Pick<MoveInput, 'dirX' | 'dirZ' | 'mode'>,
  grounded: boolean,
): number {
  return CROSSHAIR.gapPx * crosshairSpreadMultiplier(input, grounded)
}
