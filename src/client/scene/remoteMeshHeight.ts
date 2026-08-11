import { hitboxForMode } from '@shared/sim/combat'
import { CROUCH_HITBOX, DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import type { MoveInput } from '@shared/sim/movement'

/**
 * RQ-92 v2.4(원장 24az, GA-72) — 원격 플레이어 메시(박스) 높이 선택.
 *
 * **렌더 계층 면제 경계**: `PlayerMeshes.tsx`(R3F)는 ADR-0008 §6 면제
 * 대상이라 이 파일이 대신하지 않는다 — `hitboxForMode` 선례(값 선택은
 * 순수 함수, 렌더 배선은 면제)를 그대로 따라 "메시 높이 = 어느 자세의
 * 히트박스 head top인가"라는 선택 로직만 이 순수 함수로 뽑았다.
 * ⚠️ **RQ-73(원장 24bz) 이후 프로덕션 호출자가 없다.** 이 문단은 한때
 * 「`PlayerMeshes.tsx`는 이 함수를 호출해 기존 `BOX_HEIGHT` 상수 자리를
 * 대체하기만 한다」로 끝났는데, RQ-73이 단일 박스를 **6파츠**로 바꾸면서
 * 렌더 경로가 `computePlayerModelLayout`(`playerModelLayout.ts`)로 옮겨갔다.
 * 실측: `remoteMeshHeightM`의 프로덕션 호출 **0건**(정의 자신뿐).
 * **함수를 지우지 않는 이유**: GA-72·GA-75가 이 함수를 직접 시험하고 있고
 * (`rq-92-remote-mesh-height.test.ts`·`rq-63-interpolation.test.ts`),
 * `playerModelLayout`이 산출하는 머리 볼륨 상단과 **동치**임을 RQ-73
 * 테스트가 단언한다 — 그 동치 단언이 두 경로를 묶어 두는 그물이다.
 *
 * **`@shared`가 아니라 `src/client/scene`에 두는 이유**: "메시 높이"는
 * 서버가 전혀 계산·소비하지 않는 순수 렌더링 개념이다(서버는 히트박스
 * 판정 범위만 알면 되고 "몇 미터짜리 상자를 그릴지"는 모른다) —
 * `hitboxForMode`(서버·클라 공유)와 달리 이 함수는 클라 전용이다
 * (ADR-0008 환경 중립 원칙).
 *
 * 값을 리터럴로 새로 박지 않는다(ADR-0010) — `hitboxForMode`가 이미
 * RQ-92의 정본 히트박스 선택 로직이므로 그대로 재사용하고, "머리 볼륨
 * 상단"(head top)이라는 파생 공식만 이 함수가 담당한다. 이 공식은
 * `nameplateAnchorHeightM()`(`@client/hud/nameplateTarget`)이 이미 쓰는
 * 것과 동일한 파생("헤드 중심+헤드 반경")이다 — 우연이 아니라 둘 다
 * "히트박스 상단"이라는 같은 개념의 다른 소비처다.
 *
 * 선 자세 값(`remoteMeshHeightM('run')`)은 **당시** `PlayerMeshes.tsx`의
 * `BOX_HEIGHT`(1.8)와 수치가 우연히 같았다 — 이 함수 도입으로 선 자세
 * 렌더는 시각적으로 바뀌지 않고 앉은 자세만 새로 1.35로 낮아졌다.
 * (RQ-73 이후 `BOX_HEIGHT`는 없어졌고, 같은 1.8이 6파츠 레이아웃의
 * 머리 볼륨 상단으로 재현된다 — 위 동치 단언이 그것을 고정한다.)
 */
export function remoteMeshHeightM(mode: MoveInput['mode']): number {
  const hitbox = hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, mode)
  return hitbox.headCenterM + hitbox.headRadiusM
}
