import { describe, expect, it } from 'vitest'
import { remoteMeshHeightM } from '@client/scene/remoteMeshHeight'
import { CROUCH_HITBOX, DEFAULT_HITBOX } from '@shared/config/combat-tuning'

/**
 * RQ-92 v2.4 — 원격 플레이어 메시 높이(원장 24az, GA-72) 단위 테스트
 * (ADR-0008: 순수 함수, 결정론).
 *
 * 매핑된 골든 케이스: **GA-72**(`harness/evals/golden/track-a-product
 * .jsonl`). given: "원격 플레이어가 mode='crouch'로 지면에 있다". when:
 * "그 플레이어의 메시를 렌더". then: "메시 높이가 1.350m다(선 자세
 * 1.800). 서버 히트 볼륨 [0, 1.35]와 일치해 보이는 몸과 맞는 몸이 같다".
 *
 * **렌더 계층 면제 경계(team-lead 지시 ①, test-writer가 정한다)**:
 * `PlayerMeshes.tsx`(R3F 컴포넌트)는 ADR-0008 §6 면제 대상이라 이 파일이
 * 직접 다루지 않는다 — `hitboxForMode`가 이미 세운 선례(값 선택은 순수
 * 함수, DOM/렌더 배선은 면제)를 그대로 따른다. 다만 "메시 높이 = 어느
 * 자세의 히트박스 head top인가"라는 **선택 로직 자체**는 렌더 없이도
 * 순수 함수로 뽑아낼 수 있고, 이 로직이 테스트 밖(예: `PlayerMeshes.tsx`
 * 안에 인라인)에 남으면 "머리 반경을 빼먹었다"·"bodyTopM을 잘못 썼다"류의
 * 결함을 아무 것도 잡지 못한다(GA-72가 공허해진다) — 그래서 이 계산만
 * 별도 순수 함수로 분리해 이 파일이 고정한다.
 *
 * ⚠️ **RQ-73(원장 24bz) 이후 프로덕션 호출자가 없다.** 이 문단은 한때
 * 「`PlayerMeshes.tsx`는 이 함수를 호출해 `BOX_HEIGHT` 상수를 대체하기만
 * 하면 된다」로 끝났는데, RQ-73이 단일 박스를 **6파츠**로 바꾸면서 렌더
 * 경로가 `computePlayerModelLayout`(`playerModelLayout.ts`)로 옮겨갔고
 * `BOX_HEIGHT`도 없어졌다. **이 파일이 여전히 GA-72의 verify인 이유**:
 * 같은 파생("헤드 중심+헤드 반경")을 두 경로가 각각 계산하므로, 이 파일이
 * 값을 고정하고 `rq-73-player-model.test.ts`가 **두 경로의 동치**를
 * 단언한다 — 그 동치 단언이 둘을 묶어 두는 그물이다.
 *
 * **배치 위치**: `src/client/scene/remoteMeshHeight.ts`(그린필드,
 * test-writer 지정) — `harness/workflow/fe.md`의 "DOM 결합부와 순수
 * 함수를 파일로 분리한다" 규칙을 따른다(`aimMath.ts`·`chatInputGate.ts`·
 * `nameplateTarget.ts`와 동일한 위치·성격). `@shared`에 두지 않은 이유:
 * "메시 높이"는 서버가 전혀 계산·소비하지 않는 순수 렌더링 개념이다
 * (서버는 히트박스 판정 범위만 알면 되고 "몇 미터짜리 상자를 그릴지"는
 * 모른다) — `hitboxForMode`(서버·클라 공유, `@shared/sim/combat`)와 달리
 * 이 함수는 클라 전용이라 `src/client`에 두는 것이 ADR-0008 환경 중립
 * 원칙과 더 맞다.
 *
 * **계약(coder에게 — 이 모듈은 아직 없다, 이 테스트가 계약을 정의한다)**:
 * ```ts
 * // src/client/scene/remoteMeshHeight.ts (신규)
 * import { hitboxForMode } from '@shared/sim/combat'
 * import { CROUCH_HITBOX, DEFAULT_HITBOX } from '@shared/config/combat-tuning'
 * import type { MoveInput } from '@shared/sim/movement'
 *
 * export function remoteMeshHeightM(mode: MoveInput['mode']): number {
 *   const hitbox = hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, mode)
 *   return hitbox.headCenterM + hitbox.headRadiusM
 * }
 * ```
 * 값을 리터럴로 새로 박지 않는다(ADR-0010) — `hitboxForMode`가 이미
 * RQ-92의 정본 히트박스 선택 로직이므로 그대로 재사용하고, "머리 볼륨
 * 상단"(head top)이라는 파생 공식만 이 함수가 담당한다. 이 공식은
 * `nameplateAnchorHeightM()`(`nameplateTarget.ts`)이 이미 쓰는 것과
 * 동일한 파생("헤드 중심+헤드 반경")이다 — 우연이 아니라 둘 다 "히트박스
 * 상단"이라는 같은 개념의 다른 소비처다.
 *
 * **`BOX_HEIGHT`(당시 `PlayerMeshes.tsx`의 리터럴 1.8)와의 관계**: 선
 * 자세 값(`remoteMeshHeightM('run')`)은 그 `BOX_HEIGHT`와 **수치가
 * 우연히 같았다**(1.8) — 이 파일의 첫 번째 테스트가 그 사실을 독립
 * 재계산으로 고정한다. 그 함수로 `BOX_HEIGHT`를 대체하면서 선 자세
 * 렌더는 시각적으로 바뀌지 않고 앉은 자세만 새로 1.35로 낮아졌다.
 * ⚠️ **RQ-73 이후 `BOX_HEIGHT`는 없다** — 같은 1.8이 6파츠 레이아웃의
 * 머리 볼륨 상단으로 재현되고, `rq-73-player-model.test.ts`가 그 동치를
 * 단언한다. 아래 첫 번째 테스트가 고정하는 **값 자체는 불변**이다.
 */

describe("RQ-92 v2.4/GA-72 — remoteMeshHeightM: 자세에 따른 원격 메시 높이", () => {
  it("mode='run'이면 DEFAULT_HITBOX(선 자세)의 머리 볼륨 상단이다 — 1.8(RQ-73 이전 PlayerMeshes.tsx의 BOX_HEIGHT와 같던 수치)과 일치한다(독립 재계산으로 대조, ADR-0010)", () => {
    const expected = DEFAULT_HITBOX.headCenterM + DEFAULT_HITBOX.headRadiusM
    expect(remoteMeshHeightM('run')).toBeCloseTo(expected, 12)
    expect(remoteMeshHeightM('run')).toBeCloseTo(1.8, 3) // 앵커 — RQ-73 이전 BOX_HEIGHT와 같던 수치
  })

  it("mode='walk'도 선 자세와 같다 — 앉기(crouch)만 메시 높이를 바꾼다", () => {
    expect(remoteMeshHeightM('walk')).toBeCloseTo(remoteMeshHeightM('run'), 12)
  })

  it("GA-72: mode='crouch'면 CROUCH_HITBOX(앉은 자세)의 머리 볼륨 상단이다 — 1.350m(선 자세 1.800m보다 낮다)", () => {
    const expected = CROUCH_HITBOX.headCenterM + CROUCH_HITBOX.headRadiusM
    expect(remoteMeshHeightM('crouch')).toBeCloseTo(expected, 12)
    expect(remoteMeshHeightM('crouch')).toBeCloseTo(1.35, 3) // 앵커 — GA-72 골든 표기값
    expect(remoteMeshHeightM('crouch')).toBeLessThan(remoteMeshHeightM('run'))
  })

  it('GA-72: 서버 히트 볼륨 상단과 정확히 일치한다 — "보이는 몸과 맞는 몸이 같다"를 직접 대조', () => {
    // GA-72 then 절 그대로: 메시 높이가 서버가 실제로 판정하는 히트 볼륨의
    // 상단과 같아야 "쏠 수 있는 곳까지만 보인다"가 성립한다.
    expect(remoteMeshHeightM('run')).toBeCloseTo(DEFAULT_HITBOX.headCenterM + DEFAULT_HITBOX.headRadiusM, 12)
    expect(remoteMeshHeightM('crouch')).toBeCloseTo(CROUCH_HITBOX.headCenterM + CROUCH_HITBOX.headRadiusM, 12)
  })
})
