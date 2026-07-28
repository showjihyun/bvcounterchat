import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { applySpread, DEGENERATE_RADIAL_EPS, eyeOrigin, raycastHitbox, type Vec3 } from '@shared/sim/combat'
import { createRng } from '@shared/sim/rng'
import { type PositionSnapshot } from '@shared/sim/rewind'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'
import { computeRadialEscape, type SafeZoneEscapeSeam } from '../support/safe-zone'

/**
 * RQ-90 탄퍼짐(랜덤 콘) — **시드 결정론** 통합 테스트 (ADR-0008: Colyseus
 * 룸 경계, ADR-0011: 서버 판정 로직은 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-17** (`harness/evals/golden/...`).
 * GA-17: "given: 서버가 사격 시 자신이 발급한 시드 값으로 탄퍼짐(랜덤 콘)
 * 난수를 생성한다(시뮬레이션 코드는 Math.random()을 직접 호출하지 않는다,
 * ADR-0008) / when: 동일한 시드로 동일한 사격 판정을 두 번 재현 / then: 두
 * 번의 탄착점(탄퍼짐 결과)이 완전히 동일하다 — 같은 시드는 같은 결과를
 * 낳는다." `verify` 필드가 이 파일 경로를 정확히 지정한다.
 *
 * **레벨 분리(ADR-0008)·기존 커버리지와의 차이**: `tests/unit/sim-combat.test.ts`
 * `describe('RQ-90 탄퍼짐 구조...')`(파일 하단, `applySpread` 직접 호출)가
 * 이미 순수 함수 수준에서 "같은 시드는 같은 결과·다른 시드는 다른 결과·콘
 * 반경 0이면 정조준"을 결정론적으로 고정해 뒀다 — **그 계약 자체는 이 파일이
 * 재검증하지 않는다.** 이 파일이 검증하는 것은 그와 다른 층위다: **서버
 * (`GameRoom.handleFire`)가 실제로 자신의 시드를 발급해 `applySpread`에
 * 넘기고 있는가** — 즉 클라이언트가 보낸 조준 방향을 그대로 레이로 쓰는 게
 * 아니라, 서버가 자신의(±테스트가 강제한) 시드로 편차를 얹은 뒤에 판정하는
 * 배선이 실제 Colyseus 룸 경계에서 동작하는가(`rq-12-server-hitscan.test.ts`와
 * 동일한 "클라 요청 → 서버 판정 → HP 반영"의 블랙박스 관측 정신).
 *
 * **현재 상태 확인(코드 감사, 착수 전 실측)**: `createRng`/`SeededRng`/
 * `applySpread`는 저장소 전체에서 `src/shared/sim/combat.ts` 자신과
 * `tests/unit/sim-combat.test.ts` **이외에는 참조되는 곳이 없다**
 * (`grep -rn "createRng\|SeededRng\|applySpread" src` 실행 결과). `GameRoom.
 * handleFire`(L562-565)는 `input.dirX/dirY/dirZ`를 **그대로** 레이 방향으로
 * 쓴다 — 탄퍼짐 적용 단계가 아예 없다. 즉 GA-17의 `given`("서버가... 시드
 * 값으로 탄퍼짐 난수를 생성한다")이 **지금 거짓**이다 — 이 파일은 오늘 실행하면
 * **실패해야 정상**이다(Red).
 *
 * **테스트 시드 주입 인터페이스(신규 화이트박스 계약 — 그린필드)**: 출하
 * 기본값 `DEFAULT_SPREAD.coneRadiusRad`는 0(정조준)이며 이번 라운드는 그
 * 기본값을 바꾸지 않는다(팀리드 결정, "시드 배선만 한다") — 그런데 반경 0에서는
 * `applySpread`가 항등 함수라 시드가 결과에 전혀 드러나지 않는다("공허함
 * 함정"). 그래서 이 테스트는 **테스트 전용 오버라이드 두 개**를 `GameRoom`
 * 인스턴스에 요구한다 — `matchMaker.getLocalRoomById`로 살아있는 서버 룸
 * 객체를 얻어 `as unknown as SpreadTestSeam`으로 직접 필드를 쓰는, 이 저장소가
 * 이미 확립한 화이트박스 관례(`FallDamageTestSeam`·`AfkTestSeam`·
 * `PositionTestSeam`·`RewindTestSeam`과 동일한 `as unknown as` 결합 — `tsc`가
 * 대조하지 않으므로 TS2307/TS2305 없이 컴파일된다):
 *
 *   - `spreadTuningOverride?: { coneRadiusRad: number }` — 있으면 이 룸
 *     인스턴스의 `DEFAULT_SPREAD`를 대체한다(없으면 기존처럼
 *     `DEFAULT_SPREAD`, 즉 반경 0). 룸 생성 시점 옵션(`statsDbPath`처럼
 *     `gameServer.define()`의 3번째 인자)이 아니라 **인스턴스 필드**로 둔
 *     이유: 이 테스트가 한 룸 안에서 반경을 0 → 0이 아닌 값 → 다시 0으로
 *     시나리오 도중에 바꿔야 하기 때문이다(생성 시점 옵션은 재생성 없이
 *     못 바꾼다).
 *   - `forcedSpreadSeed?: number` — 있으면 **다음 'fire' 메시지부터(발신자
 *     무관, 테스트가 다시 바꾸기 전까지 계속)** `applySpread`에 넘길 시드로
 *     이 값을 그대로 쓴다(=`createRng(forcedSpreadSeed)`) — 서버 자신이
 *     고르는 값을 테스트가 대체한다. **자동 소비/초기화되지 않는다**(매
 *     사격마다 다시 세팅할 필요 없음 — 계약을 단순하게 유지하기 위한
 *     선택). 없을 때 서버가 실제로 시드를 어떻게 조달하는지(예: `state.tick`
 *     +내부 카운터 조합)는 **이 테스트가 규정하지 않는다** — coder 재량.
 *     단, ADR-0008 위반 방지를 위해 프로덕션 경로도 반드시 `createRng`를
 *     거쳐야 한다(`Math.random()` 직접 호출 금지, `src/shared`의 규율).
 *     **주의**: `src/server`(이 룸) 자신이 시드의 *원재료*(예: `Date.now()`,
 *     `state.tick`)를 얻는 것은 ADR-0008 위반이 아니다(`handleFire`의
 *     rate-limit이 이미 `Date.now()`를 쓴다, 이 파일 상단 GameRoom 코멘트
 *     참고) — 위반은 오직 **난수 생성 자체**(`applySpread` 내부의 편차
 *     계산)를 `Math.random()`으로 하는 경우다. 여기서는 이미 `applySpread`가
 *     주입된 `SeededRng`만 쓰므로 이 축은 이미 안전하다.
 *
 *   두 필드 다 **오늘은 존재하지 않는다**(Red 전제) — 서버가 저 이름의
 *   필드를 갖지 않으므로 테스트가 이 값을 설정해도 **아무 효과가 없다**
 *   (임의 프로퍼티를 얹는 것 자체는 JS에서 에러가 아니다 — 조용히 무시될
 *   뿐이다). 그래서 이 파일의 Red는 "필드가 없다"는 예외가 아니라 아래
 *   (B)/(C) 단언의 **값 불일치**로 드러난다(타임아웃이 아니라 즉시 실패로
 *   드러나도록 관측 지점을 설계했다 — 아래 "공허함 회피" 참고).
 *
 * **관측 지점 선택 근거**: `handleFire`를 감사한 결과 서버는 명중 결과(부위·
 * 탄착점)를 별도 네트워크 메시지로 브로드캐스트하지 않는다 — 유일하게 외부에서
 * 관측 가능한 신호는 **피격자의 `hp`(state 필드, GA-05/12/13/14 선례)**뿐이다.
 * 그래서 "탄착점이 같다/다르다"는 hp 감소량(바디 25 vs 미스 0 — 이 테스트는
 * 헤드 50 갈래는 쓰지 않는다, 아래 참고)으로 관측한다.
 *
 * **기하 고정(이동 없음)**: A(사수)·B(피격자) 둘 다 'move'를 전혀 보내지
 * 않는다 — 스폰 지점(`initializePlayer`가 join 즉시 채우는 `moveStates`)에
 * 고정된 채로 전부 처리한다. `rq-12`처럼 실측 이동 후 거리를 쓰지 않은
 * 이유: 이 파일은 기하 자체가 아니라 시드 배선을 검증하는 것이라, 기하를
 * 최대한 단순·고정해 오프라인 오라클(아래) 계산이 실측과 어긋날 여지를
 * 없앴다.
 *
 * **오프라인 오라클(공허함 회피의 핵심)**: 이 테스트가 보낼 "원 조준
 * 방향"(스프레드 적용 전, 클라이언트가 실제로 보낼 값)은 A→B 바디 중심을
 * 정확히 겨냥한 단위 벡터다. 그 방향에 특정 시드로 스프레드를 얹으면 실제로
 * 명중/이탈 어느 쪽이 나올지는, **이미 결정론이 고정된 순수 함수
 * (`applySpread`+`raycastHitbox`+`eyeOrigin`, 전부 `src/shared` 기존
 * 구현)를 이 테스트 파일 안에서 그대로 호출**해 미리 계산한다(방금 관측한
 * A·B의 실제 좌표를 그대로 넣으므로 좌표를 하드코딩하지 않는다). 이 계산은
 * 진짜 무작위성이 전혀 없는 순수 산술이라 실행마다 항상 같은 답을 낸다
 * (플레이키 아님) — `findSeedWithBucket`이 이 오라클로 "반드시 바디에
 * 명중하는 시드"와 "반드시 빗나가는 시드"를 탐색해 고른다. 콘 반경(테스트
 * 전용 파라미터, `SPREAD_CONE_MULTIPLIER`)은 사전에 Node 스크래치
 * 스크립트로 실제 스폰 좌표(인접 스폰 지점 간 거리 ≈9.27m)에 대해 배율
 * 2~5 전부 시드 1~10 안에서 두 버킷을 즉시 찾아냄을 확인했다(보고서 참고,
 * 저장소에 커밋된 스크립트는 아니다) — `SEARCH_LIMIT`(5000)은 넉넉한
 * 안전 여유이지 아슬아슬한 값이 아니다.
 *
 * **이 파일이 밸런싱 값을 정하지 않는다**: `coneRadiusRad`는 이 테스트가
 * `spreadTuningOverride`로 **주입하는 값**일 뿐, `DEFAULT_SPREAD`(출하
 * 기본값, 여전히 0)를 바꾸지 않는다 — 게임 감각을 정하는 결정이 아니라
 * 시드가 결과에 드러나게 하는 시험 조건이다.
 *
 * **공허함 회피 — 세 단언의 역할**:
 *   (A) 재현성(양성, GA-17의 본문): 서로 다른 시드 12개(`F1_SEED_SEQUENCE`)를
 *       고정 순서로 쏘고, 매 발의 관측 버킷을 오프라인 오라클의 예측과
 *       **정확히** 대조한 뒤, 같은 12-시드 열을 한 번 더 반복해 동일 결과를
 *       재확인한다(F1 수정 — 아래 REV 참고).
 *   (B) 음성 대조군(GA-17이 실제로 Red가 되는 지점): 오프라인 오라클이
 *       "반드시 빗나감"으로 분류한 다른 시드 `seedMiss`로 **같은 조준·같은
 *       콘 반경**에서 쏘면 hp가 그대로여야 한다. 서버가 스프레드를 적용하지
 *       않는 오늘 상태에서는 이 시드도 원 조준 그대로 바디에 명중해 버려
 *       hp가 줄어든다 — 즉 이 단언이 **오늘 실패한다**(진짜 Red).
 *   (C) 구조 확인(양성, "부록"): (B)와 같은 `seedMiss`를 유지한 채 콘
 *       반경만 0으로 되돌리면(`spreadTuningOverride = { coneRadiusRad: 0 }`)
 *       다시 바디에 명중해야 한다 — `coneRadiusRad===0`이면 편차가 없다는
 *       계약(단위 테스트가 이미 고정)을 서버 배선에서도 재확인해, "콘 반경
 *       오버라이드 자체가 스프레드를 실제로 켜고 끈다"를 보여준다(우연한
 *       seed 궁합이 아니라).
 *
 * **REV(평가 F1/F2 blocker 수정, `_workspace/RQ-90/04_evaluator_report.md`)**:
 * 최초 버전의 (A)는 "강제 시드 하나로 두 발 다 바디 데미지 25"만 확인했다
 * — 이는 GA-17 then("두 번의 **탄착점**이 완전히 동일")이 아니라 **"둘 다
 * 바디 버킷"**이라는 훨씬 거친 술어였다. 평가자가 `handleFire`에서 3발째
 * 부터만 RNG 스트림을 1드로 더 전진시키는 변이(M1C)를 심어 실증했다 —
 * 탄착점이 0.745m(콘 반경의 84%) 어긋나는데도 이전 단언은 전부 통과했다
 * (두 탄착점 다 바디 히트박스 안이라 데미지가 같았을 뿐). (A)를 위
 * "오라클 일치 열" 형태로 재작성했다(`F1_SEED_SEQUENCE`·
 * `fireOracleSequenceAndAssert` 코멘트 참고) — (B)·(C)는 최초 버전 그대로
 * 유지했다(이미 진짜 Red를 정확히 잡고 있었다는 것이 평가로 확인됨).
 * 별도로, 신규 리스너(`waitForDefinedPlayer`·`waitForHpChange`)가 이
 * 저장소의 리스너 생명주기 정본 형태(`rq-61`·`rq-92`의 참조 등록·즉시
 * 충족 시 미등록·해제)를 어겼다는 지적(F2)도 함께 고쳤다(`waitForPlayerCondition`
 * 코멘트 참고).
 *
 * **REV(리뷰 blocker 재현, `_workspace/review/feat-RQ-90-spread-seed-determinism.md`)**:
 * 리뷰가 `handleFire`(`GameRoom.ts:593-604`)가 클라이언트의 조준 벡터를
 * `applySpread`에 넘기기 **전에 정규화하지 않는다**는 계약 위반을 지적했다
 * (`combat.ts`의 `applySpread` 계약은 "이미 정규화된 단위 벡터" — 정규화는
 * 지금까지 `raycastHitbox`가 첫 소비자로서 담당했는데, 이 PR이 그 앞에
 * `applySpread`를 끼워 넣어 전제가 깨졌다). 리뷰가 순수 함수 재현으로
 * 실측한 두 결과를 실 서버 경계에서 재현하는 두 번째 `it()`를 추가했다:
 *   1. **오늘 발생하는 회귀(콘 반경 0에서도)**: `direction.y===0 &&
 *      direction.z===0 && |direction.x|<0.9`이면 `cross(helper={1,0,0},
 *      direction)`이 정확히 영벡터가 되어 `normalize`가 `NaN`을 낸다 —
 *      `coneRadiusRad===0`이어도 `scale(u,0)`이 `0*NaN=NaN`이라 항등
 *      경로가 아니라 `NaN` 방향이 나오고, `raycastHitbox`가 이를 걸러
 *      **무조건 빗나간다**. 자연 스폰 좌표는 이 정확한 퇴화 조건(사수·
 *      피격자가 같은 z·같은 높이)을 우연히 만족하지 않으므로, 화이트박스로
 *      B를 직접 배치한다(`DEGENERATE_DISTANCE` 코멘트 참고).
 *   2. **콘 반경이 0을 벗어나는 순간의 서버 권위 구멍**: `v = cross(direction,
 *      u)`가 정규화되지 않아 크기가 `|direction|`이 된다 — 클라이언트가
 *      조준 벡터의 **크기**를 조절해 자기 탄퍼짐의 콘 모양(정확도)을 바꿀
 *      수 있다. 오프라인 오라클(단위 벡터 기준 예측)과 실제로 부풀린
 *      벡터(`OVERSIZED_AIM_SCALE`)로 쏜 결과를 대조해 확인한다.
 * 이 두 재현은 서버 판정 로직(ADR-0011 Red-first 영역)이라 test-writer가
 * 먼저 작성한다 — 수정(`handleFire`에서 `applySpread` 호출 전 정규화)은
 * coder의 몫이다. (A)/(B)/(C)/`F1_SEED_SEQUENCE` 오라클 열은 이 REV가
 * 한 줄도 건드리지 않았다.
 *
 * **REV(원장 22z7/22aa — 골든 GA-49 그물 + (2) 블록 회수)**: 재리뷰
 * (`_workspace/review/feat-RQ-90-spread-seed-determinism-r2.md` [major N-1])가
 * 바로 위 "(2) 벡터 크기가 콘 형태를 왜곡" 블록이 **구조적으로 공허함**을
 * 실증했다 — 그 블록에 도달할 때 B는 이미 (1)의 퇴화 발과 단위 대조군
 * 발의 헤드 데미지(각 50)로 hp 0(시신)이고, `handleFire`의 `!canAct`
 * 피격 대상 필터(`GameRoom.ts:645`)가 시신을 후보에서 제외해 탄퍼짐이
 * 무엇을 하든 관측값이 변할 수 없었다(재리뷰 E6: 오라클이 '바디 명중'으로
 * 분류한 시드로 바꿔도 그대로 통과 — 명중/빗나감을 원리적으로 구분하지
 * 못했다). 그 블록을 **들어냈고**, 아래 `describe('RQ-90/GA-49: ...')`로
 * 대체했다 — 사용자가 승인한 골든 GA-49("조준 벡터의 크기는 명중
 * 여부에도, 탄퍼짐 콘의 모양·크기에도 영향을 주지 않는다")의 `verify`가
 * 가리키는 대상이 이 신규 describe다.
 *
 * **재배치 대신 신규 describe를 고른 이유**: 재리뷰의 최소 변경안은
 * "(2)를 대조군 사격 앞(B가 hp 50일 때)으로 옮기는" 순서 재배치였다 —
 * 그러면 F1 오라클 열(24발)·(B) 음성 대조군·(C) 콘 반경 0 복귀·N7 퇴화
 * 발·(1)의 두 발까지 이어지는 **한 `it()` 안의 누적 hp 산술 전체**가 옮긴
 * 지점을 기준으로 다시 성립해야 해서 회귀 위험이 실재했다(팀리드 지적).
 * 신규 `describe`는 **자기 서버·자기 룸 인스턴스**를 새로 띄우므로(아래
 * `beforeAll`) 기존 두 `it()`의 hp·seam 상태를 원천적으로 물려받지 않는다
 * — "물려받지 않는다"를 주석으로 선언하는 대신 구조로 강제한다. 대가는
 * 서버 기동 1회 추가(수 초, 기존 타임아웃 예산 안)뿐이다. 새 describe
 * 안에서는 데미지 총합을 의도적으로 `WEAPON.DAMAGE_BODY * 3 = 75 <
 * PLAYER.MAX_HP`로 설계해(바디 버킷 3발만 쏜다) 피격자가 시퀀스 내내
 * 살아있게 했다 — (2)를 공허하게 만든 원인(대상이 시신이 되는 것) 자체를
 * 설계로 없앤 것이지, 우연히 죽지 않기를 바란 것이 아니다.
 *
 * **22z4 회수**: 위 두 번째 `it()`(리뷰 blocker 재현)의 "자기 완결적으로
 * 명시한다" 주석은 실제로는 `forcedSpreadSeed`를 재설정하지 않아 사실과
 * 어긋났다(평가자 N10, 재리뷰 minor N-3) — `seam.forcedSpreadSeed =
 * undefined`를 그 `it()` 서두에 추가해 주석을 사실로 만들었다.
 *
 * **검증(변이, 격리 워크트리 — 전문은 `_workspace/GA-49/01_test-writer.md`)**:
 * MA(3발째부터 RNG 1드로 전진) → F1 오라클 열이 죽는지, MUT-A(정규화
 * 가드 되돌림) → (1)과 신규 GA-49 단언이 **함께** 죽는지(같은 가드가 두
 * 성질 — NaN 방지·크기 무관성 — 을 함께 보장하므로 둘 다 죽는 것이 기대
 * 결과다, 그물이 겹친 것이 아니다), MG1(정규화 가드 줄 삭제) → N7 발이
 * 죽는지, 그리고 (2)가 실패했던 바로 그 시험(오라클이 '바디 명중'으로
 * 분류한 시드로 miss 버킷 시드를 교체)을 신규 GA-49 단언에 다시 적용해
 * 죽는지 — 전부 실측했다.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * 허용 예외, `rq-12`와 동일). 모든 대기에 `withTimeout()` 상한을 건다.
 * hp 변화 관측은 `onStateChange` 이벤트 기반 폴링(고정 슬립 아님)이고,
 * "변화 없음"(오라클 'miss' 예측·(B)) 확인만 예외적으로 고정 슬립 뒤 값을
 * 읽는다(그 자체가 확인 대상이라 이벤트 기반 대기가 부적합 — `rq-12`의
 * "무관한 방향" 테스트와 동일한 필요성). 오프라인 오라클(`classifySpreadSeed`)
 * 은 순수 산술이라 실행마다 항상 같은 답을 낸다(플레이키 아님).
 *
 * **REV(RQ-31 Safe Zone 회귀 대응, `_workspace/RQ-31/03_test-writer_regression
 * .md`)**: RQ-31 Safe Zone 배선(GA-19·GA-11, `86fddf1`) 이후 사수·피격자
 * 둘 다 각자의 스폰 지점(Safe Zone 내부, 거리 0)에 그대로 있으면 (1) GA-19가
 * 사수의 사격 자체를 막고 (2) 피격자가 Safe Zone 안에 있으면 RQ-16과
 * 무관하게 GA-11이 계속 피해를 무효화한다. 피격자의 RQ-16 해제는 자기
 * 사격 대신 화이트박스(`firedSinceSpawn`)로 하고, 기존 `teleportPlayer`를
 * 재사용하는 `escapeSafeZone` 헬퍼로 두 세션 다 각자의 스폰 지점 기준
 * 방사 방향(`rq-31-safe-zone.test.ts` §반경-방사 기하)으로 Safe Zone
 * 밖으로 옮긴다. "정규화되지 않은 조준 벡터" 재현 테스트는 B를 A(탈출
 * 후 위치) 기준 상대 좌표로 재배치하므로 A만 탈출시키면 B도 자연히
 * Safe Zone 밖이 된다(둘 다 원점에서 스폰 반경보다 훨씬 먼 지점에 놓인다).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000

/** 연속 사격 사이 여유(ADR-0005 rate-limit 150ms + 네트워크 왕복 여유를
 * 모두 흡수) — "빗나감" 확인의 정착 대기로도 재사용한다. */
const SHOT_GAP_MS = 400

/** 콘 반경 = (바디 반지름의 각반경) × 이 배율 — 테스트 전용 파라미터(밸런싱
 * 값 아님). 스크래치 검증(파일 상단 "오프라인 오라클" 참고)으로 2~5 배율
 * 전부 시드 한 자릿수 안에서 명중·이탈 버킷이 갈리는 것을 확인했다. */
const SPREAD_CONE_MULTIPLIER = 3
/** `findSeedWithBucket` 탐색 상한 — 순수 결정론 계산이라 느리지 않다
 * (수천 회도 밀리초 미만). 실제로는 한 자릿수 안에서 찾힘(위 스크래치
 * 검증) — 이 값은 넉넉한 안전 여유다. */
const SEARCH_LIMIT = 5_000
/** F1 수정 — RQ-10(탄창 10발)의 재장전(RQ-11, 2초)이 이 파일의 관심사를
 * 가리지 않도록 A의 탄창을 넉넉히 채운다(오라클 열 26발 예정, 아래
 * `F1_SEED_SEQUENCE` 코멘트). 탄약·재장전 메커니즘 자체는 이 파일의
 * 검증 대상이 아니다. */
const AMPLE_MAGAZINE = 999

/** 리뷰 blocker 재현(§"REV(리뷰 blocker 재현)") — B를 A와 정확히 같은
 * z·같은 높이, +X로만 이 거리만큼 떨어진 지점에 배치한다. `applySpread`의
 * 퇴화 조건(`direction.y===0 && direction.z===0`)을 만들려면 사수·피격자가
 * 정확히 같은 z·같은 높이여야 하는데, 자연 스폰 좌표(원 위의 15개 점)는
 * 이 조건을 우연히 만족하지 않는다 — 화이트박스로 직접 배치한다. */
const DEGENERATE_DISTANCE = 6
/** GA-49(조준 벡터 크기 무관성) — 조준 벡터를 이 배율만큼 부풀려 보낸다.
 * 정규화 가드(`GameRoom.handleFire`가 `applySpread` 호출 전에 세운다)가
 * 없다면 `v = cross(direction, u)`가 정규화되지 않아 크기가 `|direction|`
 * 이 되므로(계약 위반), 벡터를 부풀리면 편차 분포가 왜곡된다 — 리뷰가
 * 실측한 배율(1000)과 동일하게 맞췄다. 정규화 가드가 있는 오늘은 이
 * 배율에서도 단위 벡터와 동일한 결과가 나와야 한다 — 그것이 GA-49 then. */
const OVERSIZED_AIM_SCALE = 1000
/** GA-49 — 조준 벡터를 이 배율만큼 줄여 보낸다(골든 given의 예시 "1e-6으로
 * 줄인 벡터"와 동일). `DEGENERATE_RADIAL_EPS`(1e-12)보다 한참 위 자릿수라
 * `GameRoom`의 정규화 퇴화 가드(`dirMagnitude < DEGENERATE_RADIAL_EPS`)에
 * 걸리지 않는다 — 걸리면 그건 크기 무관성이 아니라 가드 자체를 관측하는
 * 것이 되어 GA-49의 대상에서 벗어난다. `OVERSIZED_AIM_SCALE`(부풀리기)과
 * 대칭인 축소 방향을 덮는다. */
const UNDERSIZED_AIM_SCALE = 1e-6

/** N7 그물(2차 델타 재평가 지적) — `GameRoom.ts`의 정규화 가드
 * (`dirMagnitude < DEGENERATE_RADIAL_EPS`이면 조기 return)가 실제로
 * load-bearing인지 확인하는 크기. `DEGENERATE_RADIAL_EPS`(`combat.ts`
 * export, 1e-12)보다 한 자릿수 작게 잡아(1e-13) 그 가드가 반드시
 * 걸려야 하는 구간 안에 확실히 들어가게 한다 — 하드코딩된 매직넘버가
 * 아니라 실제 임계 상수에서 유도한다(그 상수가 바뀌어도 이 값이 항상
 * 그 절반의 자릿수를 유지한다). */
const SUB_DEGENERATE_MAGNITUDE = DEGENERATE_RADIAL_EPS / 10

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 모든 대기에 상한을 강제하는 래퍼 — 상한 초과는 hang이 아니라 즉시 실패다. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[timeout ${ms}ms] ${label}`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

interface RunningServer {
  app: FastifyInstance
  endpoint: string
}

async function startServer(): Promise<RunningServer> {
  const app = buildServer({ logger: false })
  const address = await withTimeout(
    app.listen({ port: 0, host: '127.0.0.1' }),
    LISTEN_TIMEOUT_MS,
    'app.listen({ port: 0 })',
  )
  const { port } = new URL(address)
  return { app, endpoint: `ws://127.0.0.1:${port}` }
}

async function stopServer(server: RunningServer): Promise<void> {
  await withTimeout(server.app.close(), CLOSE_TIMEOUT_MS, 'app.close()')
}

function newClient(server: RunningServer): Client {
  return new Client(server.endpoint)
}

async function joinGame(client: Client): Promise<Room> {
  return withTimeout(client.joinOrCreate(ROOM_NAME), JOIN_TIMEOUT_MS, `joinOrCreate('${ROOM_NAME}')`)
}

async function leaveRoom(room: Room): Promise<void> {
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

interface PlayerFields {
  x: number
  y: number
  z: number
  hp: number
}

function readPlayer(room: Room, sessionId: string): PlayerFields | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { x?: unknown; y?: unknown; z?: unknown; hp?: unknown } | undefined }
  } | null
  const player = state?.players?.get?.(sessionId)
  if (
    typeof player?.x === 'number' &&
    typeof player?.y === 'number' &&
    typeof player?.z === 'number' &&
    typeof player?.hp === 'number'
  ) {
    return { x: player.x, y: player.y, z: player.z, hp: player.hp }
  }
  return undefined
}

/**
 * 리스너 생명주기 정본 형태(평가 F2 blocker 수정,
 * `_workspace/RQ-90/04_evaluator_report.md` §7) —
 * `rq-61-server-authoritative-position.test.ts`의 `waitForCrossViewCondition`
 * (`:289-316`)·`rq-92-fall-damage-curve.test.ts`의 `waitForPlayerCondition`
 * (`:225-253`)과 동일한 세 규칙을 따른다: (1) 등록은 **참조**로(익명 래퍼
 * 금지 — `colyseus.js`의 `EventEmitter.remove(cb)`는 미등록 콜백을 넘기면
 * `handlers[-1]=last; pop()`을 수행해 맨 뒤 정상 핸들러를 조용히 지운다,
 * 원장 20e에서 실측 확인된 함정) (2) **즉시 충족되면 `onStateChange`를
 * 아예 등록하지 않는다** — 해제할 리스너 자체가 없으므로 이 경로는 처음
 * 부터 누수가 없다 (3) 조건 충족 시 그 자리에서 `remove`한다.
 *
 * 이전 버전(`waitForDefinedPlayer`·`waitForHpChange`를 각각 별도 익명
 * 클로저로 구현)은 이 세 규칙을 전부 어겼다 — 룸이 곧 닫혀 이번 테스트의
 * 정확성에는 영향이 없었으나, 같은 라운드의 `rq-61` 파일은 정본을
 * 지키는데 이 파일만 어겨 형태가 갈렸다(평가 지적). 이제 `rq-92`와 동일한
 * 이름·형태의 단일 헬퍼로 통합한다.
 */
function waitForPlayerCondition(
  room: Room,
  sessionId: string,
  predicate: (p: PlayerFields) => boolean,
  label: string,
  timeoutMs: number,
): Promise<PlayerFields> {
  return withTimeout(
    new Promise<PlayerFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayer(room, sessionId)
        if (current && predicate(current)) {
          room.onStateChange.remove(tryResolve)
          resolve(current)
        }
      }
      const immediate = readPlayer(room, sessionId)
      if (immediate && predicate(immediate)) {
        resolve(immediate)
        return
      }
      room.onStateChange(tryResolve)
    }),
    timeoutMs,
    label,
  )
}

function waitForDefinedPlayer(room: Room, sessionId: string): Promise<PlayerFields> {
  return waitForPlayerCondition(room, sessionId, () => true, `초기 스냅샷(hp 포함, sessionId=${sessionId}) 관측`, HP_TIMEOUT_MS)
}

/** hp가 `previousHp`에서 실제로 바뀔 때까지 관측한다(어느 값으로 바뀌는지는
 * 호출자가 그 뒤 `expect`로 정확히 단언한다) — "다음 값"을 미리 단정하지
 * 않으므로, 구현이 예상과 다른 값을 내도 이 대기 자체는 그 값을 빠르게
 * 반환하고 실패는 뒤이은 `expect`가 즉시·명확한 값 불일치로 드러낸다(같은
 * predicate에 정확한 목표값을 박아 두면 오답일 때 타임아웃까지 기다려야
 * 하는 문제를 피한다). */
function waitForHpChange(room: Room, sessionId: string, previousHp: number, label: string): Promise<PlayerFields> {
  return waitForPlayerCondition(room, sessionId, (p) => p.hp !== previousHp, label, HP_TIMEOUT_MS)
}

function bodyCenterM(): number {
  return (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
}

/** A(사수, 발 좌표)에서 B(피격자, 발 좌표)의 바디 중심을 정확히 겨냥하는
 * 단위 벡터와, 그 조준의 실제 3D 거리(콘 반경 스케일 산정에 쓴다) —
 * `rq-12-server-hitscan.test.ts`의 `aimAt`과 동일한 산식(거리도 함께
 * 반환하는 점만 다르다). */
function aimAtBodyWithDistance(
  shooterFoot: { x: number; z: number },
  targetFoot: { x: number; z: number },
): { aim: Vec3; distance: number } {
  const dx = targetFoot.x - shooterFoot.x
  const dz = targetFoot.z - shooterFoot.z
  const dy = bodyCenterM() - DEFAULT_HITBOX.eyeHeightM
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { aim: { x: dx / distance, y: dy / distance, z: dz / distance }, distance }
}

type SpreadBucket = 'body' | 'head' | 'miss'

/** 오프라인 오라클 — 이미 결정론이 고정된 순수 함수(`applySpread`+
 * `raycastHitbox`)를 그대로 호출해 "이 시드가 실제로 명중을 내는지"를
 * 미리 계산한다. 진짜 무작위성이 없으므로 몇 번을 다시 실행해도 항상 같은
 * 분류를 낸다(플레이키 아님). */
function classifySpreadSeed(origin: Vec3, aim: Vec3, targetFoot: Vec3, coneRadiusRad: number, seed: number): SpreadBucket {
  const deviated = applySpread(aim, createRng(seed), coneRadiusRad)
  const result = raycastHitbox({ origin, direction: deviated }, { position: targetFoot }, DEFAULT_HITBOX)
  if (!result.hit) return 'miss'
  return result.region === 'head' ? 'head' : 'body'
}

/** [1, searchLimit] 범위에서 `wanted` 버킷('body' 또는 'miss'만 — 'head'는
 * 이 파일이 쓰지 않는 갈래라 건너뛴다)에 해당하는 첫 시드를 찾는다. 방금
 * 관측한 A·B의 실제 좌표로 계산하므로 스폰 좌표를 하드코딩하지 않는다. */
function findSeedWithBucket(
  origin: Vec3,
  aim: Vec3,
  targetFoot: Vec3,
  coneRadiusRad: number,
  wanted: Extract<SpreadBucket, 'body' | 'miss'>,
  searchLimit: number,
): number {
  for (let seed = 1; seed <= searchLimit; seed += 1) {
    if (classifySpreadSeed(origin, aim, targetFoot, coneRadiusRad, seed) === wanted) return seed
  }
  throw new Error(
    `RQ-90 테스트 셋업 실패 — coneRadiusRad=${coneRadiusRad}에서 '${wanted}' 결과를 내는 시드를 1..${searchLimit} 범위에서 찾지 못했다(콘 반경 배율 조정 필요 — 실제 스폰 기하가 스크래치 검증 때와 달라졌을 수 있다).`,
  )
}

/** RQ-90 화이트박스 접근 대상 계약 — 파일 상단 "테스트 시드 주입 인터페이스"
 * 절 참고. `spreadTuningOverride`·`forcedSpreadSeed`는 그린필드 계약이다
 * (Red 전제 — `GameRoom`이 `applySpread`를 전혀 호출하지 않는 오늘 상태에서
 * 이 필드들도 당연히 없었다). `magazines`·`moveStates`·`positionHistory`는
 * 그린필드가 아니다 — `AfkTestSeam`(`rq-43-afk-kick.test.ts`)이
 * `magazines`를, `FallDamageTestSeam`(`rq-18-fall-damage.test.ts`)·
 * `rq-92-fall-damage-curve.test.ts`가 `moveStates`를, `RewindTestSeam`
 * (`rq-64-lag-compensation-bound.test.ts`)이 `positionHistory`를 이미
 * 이 정확한 이름으로 화이트박스 접근하는 기존 private 필드다. `magazines`는
 * F1 수정(§"오라클 일치 열" 참고)이 한 세션에서 26발을 쏘아야 해서
 * RQ-10/11의 재장전(2초) 대기를 이 파일의 관심사로 끌어들이지 않기 위해
 * 미리 채운다. `moveStates`·`positionHistory`는 리뷰 blocker 재현 (2차,
 * §"REV(텔레포트-되감기 버퍼 충돌 수정)" 참고)이 자연 스폰 좌표로는
 * 우연히 만들 수 없는 정확한 퇴화 기하(사수·피격자가 같은 z, 같은 높이)를
 * 직접 배치하는 데 함께 쓴다 — 둘 다 갱신해야 하는 이유는 아래
 * `teleportPlayer` 코멘트 참고. */
interface SpreadTestSeam extends SafeZoneEscapeSeam<PositionSnapshot> {
  spreadTuningOverride?: { coneRadiusRad: number }
  // `| undefined`를 명시한다(단순 `?:`가 아니라) — `exactOptionalPropertyTypes`
  // 아래서는 `seam.forcedSpreadSeed = undefined`(22z4 회수, 명시 초기화)가
  // 그냥 `?:`로는 타입 에러(TS2412)가 난다. 실제 프로덕션 필드
  // (`GameRoom.ts` `private forcedSpreadSeed: number | undefined`)도 애초에
  // 옵셔널이 아니라 이 유니언 형태다.
  forcedSpreadSeed?: number | undefined
  magazines: Map<string, number>
}

/** `matchMaker.getLocalRoomById`(`rq-18-fall-damage.test.ts`가 확립한 기법)로
 * 테스트 프로세스 안에서 실행 중인 실제 `GameRoom` 인스턴스를 얻는다. 룸을
 * 찾지 못하면(경로 오류) 이후 관측이 아니라 여기서 즉시 실패해 원인을
 * 분명히 한다. */
function getServerRoom(room: Room): SpreadTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as SpreadTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-90 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/**
 * **REV(텔레포트-되감기 버퍼 충돌 수정, coder 보고
 * `_workspace/RQ-90/08_coder_...`)**: 화이트박스로 `sessionId`의 위치를
 * 순간이동시킬 때는 `moveStates`(현재 위치)와 `positionHistory`(RQ-64
 * 되감기 링버퍼)를 **함께** 갱신해야 한다 — 이 둘을 따로 부르면 반드시
 * 하나를 잊는다(`tests/support/harness.ts`의 `advanceTicks`가 시계
 * 전진과 스케줄러 만료를 한 호출로 묶은 것과 같은 이유).
 *
 * **왜 `positionHistory`를 비우는가**: `handleFire`의 대상 포즈 조회는
 * `sampleRewoundPosition(positionHistory.get(id) ?? [], tick,
 * rewindTicksFor(rttMs))`이고(`GameRoom.ts:641`), `rewindTicksFor(0)===0`
 * 이어도 그 함수는 **버퍼가 완전히 비어 있을 때만** `moveStates`로
 * 폴백한다(`sampleRewoundPosition` 계약, `@shared/sim/rewind`) — 버퍼에
 * 텔레포트 **이전**의 stale 스냅샷이 남아 있으면 그 값을 그대로 반환해
 * 방금 세팅한 `moveStates`가 무시된다. 정확히 같은 결함 계열이 이미 한
 * 번 나왔다 — 리스폰 텔레포트도 같은 오염을 만들어서 `respawnPlayer`가
 * `positionHistory.delete(sessionId)`로 정리한다(`GameRoom.ts:1089`,
 * "평가 F2 수정" 코멘트). 여기서는 대칭적으로 `positionHistory`를 비워
 * "버퍼가 비어 있으면 즉시 `moveStates`로 폴백"하는 기존 계약을 그대로
 * 이용한다 — **타이밍(틱 대기)이 아니라 제어 흐름으로 해결한다**(이
 * 저장소가 RQ-18·RQ-62에서 타이밍 기반 해결로 CI flaky를 겪은 전례가
 * 있어 피한다).
 *
 * **REV(N8 정정, 2차 델타 재평가)**: 이전 버전은 "`moveStates`와
 * `positionHistory`가 항상 `stepPlayerMovement` 한 곳에서 함께 갱신되므로
 * 프로덕션에는 어긋나는 경로가 없다"고 적었는데, 이는 **사실이 아니다**
 * — `moveStates.set`은 이 저장소에 **세 곳**에 있다:
 *   1. `stepPlayerMovement:950` — 매 틱, `positionHistory`도 같은 반복에서
 *      append한다(`:960` 부근).
 *   2. `respawnPlayer:1080` — `positionHistory.delete`를 명시적으로
 *      동반한다(`:1089`, "평가 F2 수정").
 *   3. `initializePlayer:1269` — **`positionHistory`를 전혀 건드리지
 *      않는다.**
 * 그런데도 프로덕션에 stale 그림자가 생기지 않는 진짜 이유는 "한 곳뿐"이
 * 아니라 **`initializePlayer`의 호출 경로 자체가 `positionHistory`에
 * 항목이 있을 수 없는 세션만 대상으로 하기 때문**이다 —
 * `initializePlayer`는 `onJoin`(신규 세션, `:1145`)과
 * `promoteWaitingSpectator`(관전자 승격, `:1365`) 두 곳에서만 불린다.
 * 이 저장소에는 **플레이어 → 관전자 강등 경로가 없다**(`state.spectators
 * .set`은 `onJoin`의 "정원 초과 시 관전자로 참여" 분기 한 곳뿐이다 —
 * 실측 확인, `grep -n "state.spectators.set(" src`). 즉
 * `initializePlayer`에 도달하는 세션은 그 시점까지 `state.players`에
 * 들어간 적이 **한 번도 없다** — `positionHistory`는 `stepPlayerMovement`
 * (= `state.players` 순회)만 채우므로, 그 세션의 버퍼 항목 자체가
 * 존재할 수 없다. 그래서 `sampleRewoundPosition([], ...)`이 `undefined`를
 * 반환해 `?? moveStates` 폴백이 방금 `initializePlayer`가 세팅한 스폰
 * 좌표를 그대로 준다 — "한 곳에서 함께 갱신"이 아니라 "그 세션에 애초에
 * 버퍼가 없다"가 안전의 근거다. 이 화이트박스 텔레포트(`teleportPlayer`)
 * 는 **이미 `state.players`에 있는 세션**(A·B 둘 다 join 이후)을
 * 대상으로 하므로 이 안전판이 적용되지 않는다 — 그래서 이 헬퍼가 직접
 * `positionHistory`를 정리해야 한다.
 */
function teleportPlayer(seam: SpreadTestSeam, sessionId: string, position: { x: number; y: number; z: number }): void {
  seam.moveStates.set(sessionId, {
    x: position.x,
    y: position.y,
    z: position.z,
    vx: 0,
    vy: 0,
    vz: 0,
    grounded: true,
  })
  seam.positionHistory.delete(sessionId)
}

/** RQ-31 Safe Zone 회귀 대응 — 세션을 자신의 현재 위치 기준 방사
 * 방향(원점→현재 위치)으로 밀어내 모든 Safe Zone 밖으로 옮긴다. 좌표
 * 수학은 `tests/support/safe-zone.ts`의 `computeRadialEscape`에 위임하고
 * (`rq-31-safe-zone.test.ts` §반경-방사 기하와 동일 증명 — 15개 스폰
 * 지점×오프셋 0~20m 전수 확인됨), 화이트박스 쓰기는 이 파일의 기존
 * `teleportPlayer`(위 REV 코멘트 — `moveStates`+`positionHistory` 원자적
 * 갱신 이력)를 그대로 재사용한다. */
function escapeSafeZone(
  seam: SpreadTestSeam,
  sessionId: string,
  base: { x: number; z: number },
): { x: number; y: number; z: number } {
  const escaped = computeRadialEscape(base)
  teleportPlayer(seam, sessionId, escaped)
  return escaped
}

/**
 * F1 수정(평가 blocker, `_workspace/RQ-90/04_evaluator_report.md` §4) —
 * 서로 다른 시드 12개를 이 고정 순서로 쏘고(그 다음 같은 열을 한 번 더
 * 반복한다), 각 발의 관측 버킷이 오프라인 오라클의 예측과 **정확히
 * 일치**하는지 단언한다. 이전 버전은 "강제 시드 하나로 두 발 다 바디
 * 데미지 25"만 확인했는데, 이는 GA-17 then("두 번의 **탄착점**이 완전히
 * 동일")이 아니라 **"둘 다 바디 버킷"**이라는 훨씬 거친 술어였다 —
 * 평가자가 `handleFire`에서 3발째부터만 RNG 스트림을 1드로 더 전진시키는
 * 변이(M1C)를 심어 실증했다: 탄착점이 0.745m(콘 반경의 84%) 어긋나는데도
 * 이전 단언은 전부 통과했다(두 탄착점 다 바디 히트박스 안이라 데미지가
 * 같았을 뿐).
 *
 * 이 시퀀스는 **정확히 1개**의 'body' 버킷(시드 1)과 **11개**의 'miss'
 * 버킷으로 골랐다 — 2 pass(24발) 전체에서 바디 명중은 정확히 2회
 * (hp: 100→75→50)뿐이라 RQ-14(바디샷 4회=사망)에 걸리지 않고, 결과값도
 * 기존 (B)/(C)가 참조하던 기준값(50)과 그대로 맞물린다. 11개의 miss
 * 시드 중 `13`·`17`·`18`·`26`·`43`·`44` 여섯 개는 **"정상 계산에서는
 * miss지만 RNG 스트림이 1드로 더 밀리면 다른 버킷으로 뒤집힌다"**는
 * 것을 세션 스크래치 스크립트(오프라인 재구현, 커밋 안 함)로 이 정확한
 * 기하(A=SPAWN_POINTS[0]·B=SPAWN_POINTS[1]·`coneRadiusRad =
 * atan(bodyRadiusM/distance)*3`)에 대해 1..200 시드 전수 검사로 확인했다
 * — 확률(팀리드 실측 K=12 생존율 ≈1.4%)에 기대지 않고, **이 정확한 집합이
 * M1C류 변이를 실제로 죽인다는 것을 격리 워크트리에서 재확인**했다
 * (`_workspace/RQ-90/05_test-writer_blockers.md` §2). 나머지 5개
 * (2·4·5·9·10)는 안정적인(뒤집히지 않는) miss라 "잡음 없는 대조점"
 * 역할이다.
 *
 * 순서상 첫 항목(시드 1, 'body')은 이 세션의 첫 사격(글로벌 사격 카운트가
 * 아직 M1C류 변이의 문턱— "3발째부터"— 에 못 미치는 지점)이라 그 자체로는
 * 변이 검출에 기여하지 않는다 — 검출은 뒤따르는 11개의 miss 시드가 맡는다.
 */
const F1_SEED_SEQUENCE: readonly number[] = [1, 2, 4, 5, 9, 10, 13, 17, 18, 26, 43, 44]

/** **결합 주의(원장 22y, 리뷰 major 5)**: 위 시드 열은 A·B 사이 실제
 * `distance`(→ `coneRadiusRad = atan(bodyRadiusM/distance)*
 * SPREAD_CONE_MULTIPLIER`)에 대해 "정확히 1개 body·11개 miss"가 성립하도록
 * 골랐다. RQ-31 회귀 대응(`escapeSafeZone`, 이 파일 위쪽)이 A·B를 각자의
 * 스폰 지점 기준 `tests/support/safe-zone.ts`의
 * `DEFAULT_SAFE_ZONE_ESCAPE_OFFSET_M`만큼 방사 방향으로 밀어내므로, 그 값이
 * 바뀌면 `distance`가 바뀌고 `coneRadiusRad`도 따라 바뀐다 — **이 시드
 * 열의 전제가 조용히 깨질 수 있다는 뜻**이다(원장 22y가 이미
 * `SPAWN_POINTS`·스폰 기하 변경을 트리거로 등재해 뒀다 — 이 오프셋도 같은
 * 트리거에 속한다). 다행히 조용히 통과하지는 않는다 — 아래
 * `fireOracleSequenceAndAssert` 호출부의 실측 전제 가드(`RQ-90 F1 시퀀스
 * 전제 위반 ...`, `expectedBuckets` 계산 직후)가 분류 결과가 "정확히 1개
 * body"가 아니면 즉시 명확한 에러로 던진다. `DEFAULT_SAFE_ZONE_ESCAPE_OFFSET_M`
 * 를 바꾸는 PR은 이 파일을 반드시 재실행해 그 가드가 던지는지 확인해야
 * 한다(안 던지면 운 좋게 여전히 성립한다는 뜻이지 검증됐다는 뜻은
 * 아니다 — 필요하면 시드 열을 재선정한다, `tests/support/safe-zone.ts`의
 * `DEFAULT_SAFE_ZONE_ESCAPE_OFFSET_M` 코멘트도 참고). */

/**
 * `F1_SEED_SEQUENCE`를 고정 순서로 한 번(pass) 쏘고, 매 발의 관측 버킷이
 * `expectedBuckets[i]`(오프라인 오라클 예측)와 정확히 일치하는지
 * 단언한다 — 'body' 예측이면 hp가 정확히 `WEAPON.DAMAGE_BODY`만큼
 * 줄어야 하고, 'miss' 예측이면 hp가 전혀 변하지 않아야 한다. 갱신된
 * hp를 반환해 다음 pass·이후 (B)/(C)가 이어받는다.
 */
async function fireOracleSequenceAndAssert(
  roomA: Room,
  roomB: Room,
  seam: SpreadTestSeam,
  aim: Vec3,
  seeds: readonly number[],
  expectedBuckets: readonly SpreadBucket[],
  startingHp: number,
  passLabel: string,
): Promise<number> {
  let previousHp = startingHp
  for (let i = 0; i < seeds.length; i += 1) {
    const seed = seeds[i]!
    const bucket = expectedBuckets[i]!
    seam.forcedSpreadSeed = seed
    roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })

    if (bucket === 'body') {
      const after = await waitForHpChange(
        roomB,
        roomB.sessionId,
        previousHp,
        `RQ-90 F1: ${passLabel} #${i + 1}(seed=${seed}) 'body' 예측 hp 변화 대기`,
      )
      expect(after.hp).toBe(previousHp - WEAPON.DAMAGE_BODY) // 오라클 예측('body')과 정확히 일치
      previousHp = after.hp
      await sleep(SHOT_GAP_MS) // rate-limit 여유(hp 변화 대기가 빠르게 끝났을 수 있어 별도 확보)
    } else {
      // 'miss' 예측 — 정착 대기(=rate-limit 여유 겸용) 후 변화 없음을 확인.
      await sleep(SHOT_GAP_MS)
      const after = readPlayer(roomB, roomB.sessionId)
      expect(after?.hp).toBe(previousHp) // 오라클 예측('miss')과 정확히 일치 — hp 불변
    }
  }
  return previousHp
}

describe('RQ-90/GA-17: 서버가 발급한 시드로 탄퍼짐을 적용하며, 같은 시드는 같은 탄착 결과를 재현한다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-90/GA-17: 강제된 동일 시드 2회는 동일 판정(바디 명중·동일 데미지)을 재현하고, 다른 시드는 다른 판정(빗나감)을 내며, 콘 반경을 0으로 되돌리면 다시 정조준 명중으로 돌아온다',
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수 — 이동하지 않는다(스폰 지점 고정)
      const roomB = await joinGame(newClient(server)) // 피격자 — 이동하지 않는다(스폰 지점 고정)

      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      // RQ-31 회귀 대응(파일 상단 REV) — B의 RQ-16 해제는 화이트박스로
      // (자기 사격은 자신의 Safe Zone에 막힐 수 있다). A·B 둘 다 Safe
      // Zone 밖으로 옮긴다 — 그러지 않으면 A의 사격 자체가 GA-19에 막히고
      // (사수 고정), B가 Safe Zone 안에 있으면 RQ-16과 무관하게 GA-11이
      // 계속 피해를 무효화한다(피격자 고정). 이후 모든 기하 계산(원점·
      // 조준·거리·콘 반경)은 이 탈출 후 위치를 기준으로 한다.
      const seam = getServerRoom(roomA)
      seam.firedSinceSpawn.set(roomB.sessionId, true)
      const escapedA = escapeSafeZone(seam, roomA.sessionId, baselineA)
      const escapedB = escapeSafeZone(seam, roomB.sessionId, baselineB)
      await sleep(SHOT_GAP_MS)

      const origin = eyeOrigin({ x: escapedA.x, y: escapedA.y, z: escapedA.z }, DEFAULT_HITBOX.eyeHeightM)
      const targetFoot: Vec3 = { x: escapedB.x, y: escapedB.y, z: escapedB.z }
      const { aim, distance } = aimAtBodyWithDistance(escapedA, escapedB)

      const coneRadiusRad = Math.atan(DEFAULT_HITBOX.bodyRadiusM / distance) * SPREAD_CONE_MULTIPLIER
      const seedMiss = findSeedWithBucket(origin, aim, targetFoot, coneRadiusRad, 'miss', SEARCH_LIMIT)

      seam.spreadTuningOverride = { coneRadiusRad }
      // F1 수정 — 오라클 열이 A에게 26발(12*2 + (B) 1 + (C) 1)을 요구한다.
      // RQ-10/11(탄창 10발·재장전 2초)이 이 파일의 관심사를 가리지 않도록
      // 미리 넉넉히 채운다(위 `SpreadTestSeam.magazines` 코멘트 참고).
      seam.magazines.set(roomA.sessionId, AMPLE_MAGAZINE)

      // --- (A) 재현성 — F1 수정: 단일 시드·단일 버킷 비교 대신, 서로 다른
      // 시드 12개(`F1_SEED_SEQUENCE`)를 고정 순서로 쏘고 매 발을 오프라인
      // 오라클과 대조한 뒤, 같은 열을 한 번 더 반복해 동일 결과를 재확인한다
      // — GA-17 then("두 번의 탄착점이 완전히 동일")을 "둘 다 바디"라는
      // 거친 버킷 비교가 아니라 시드별 정밀 대조로 검증한다(평가 F1 blocker,
      // 위 `F1_SEED_SEQUENCE` 코멘트 참고).
      const expectedBuckets = F1_SEED_SEQUENCE.map((seed) => classifySpreadSeed(origin, aim, targetFoot, coneRadiusRad, seed))
      const bodyBucketCount = expectedBuckets.filter((bucket) => bucket === 'body').length
      if (bodyBucketCount !== 1 || expectedBuckets.includes('head')) {
        throw new Error(
          `RQ-90 F1 시퀀스 전제 위반 — F1_SEED_SEQUENCE는 정확히 1개의 'body'와 나머지 'miss'를 기대했으나 실제 분류는 [${expectedBuckets.join(', ')}]였다(스폰 기하가 스크래치 검증 때와 달라졌을 수 있다).`,
        )
      }

      const hpAfterPass1 = await fireOracleSequenceAndAssert(
        roomA,
        roomB,
        seam,
        aim,
        F1_SEED_SEQUENCE,
        expectedBuckets,
        baselineB.hp,
        '1차 통과',
      )
      await sleep(SHOT_GAP_MS)

      // 같은 12-시드 열을 한 번 더 반복 — GA-17 when("동일한 시드로 동일한
      // 사격 판정을 두 번 재현")의 문자 그대로의 뜻. 각 발이 또다시
      // 오프라인 오라클과 정확히 일치해야 하므로, 1차 통과와 다른 결과가
      // 나오면(스트림이 조금이라도 어긋나면) 이 두 번째 통과에서 바로
      // 잡힌다.
      const hpAfterPass2 = await fireOracleSequenceAndAssert(
        roomA,
        roomB,
        seam,
        aim,
        F1_SEED_SEQUENCE,
        expectedBuckets,
        hpAfterPass1,
        '2차 통과(재현)',
      )
      expect(hpAfterPass2).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY * 2) // 2 pass 합쳐 바디 명중 정확히 2회 — 기존 (B)/(C) 기준값과 동일

      await sleep(SHOT_GAP_MS)

      // --- (B) 음성 대조군 — 오프라인 오라클이 '반드시 빗나감'으로 분류한
      // 다른 시드 `seedMiss`는, 같은 조준·같은 콘 반경에서도 다른 결과
      // (명중 실패)를 내야 한다. 이게 없으면 (A)의 "재현"이 시드와 무관하게
      // 항상 같은 결과를 내는 배선 결함(예: 스프레드 미적용 — 오늘의 실제
      // 상태)과 구별되지 않는다. **이 단언이 오늘 Red다**: 서버가 아직
      // 스프레드를 적용하지 않으므로 이 시드도 원 조준 그대로 바디에
      // 명중해 hp가 줄어든다.
      seam.forcedSpreadSeed = seedMiss
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      await sleep(SHOT_GAP_MS)
      const afterDifferentSeed = readPlayer(roomB, roomB.sessionId)
      expect(afterDifferentSeed?.hp).toBe(hpAfterPass2) // 변화 없음 — 실제로 빗나갔다(다른 시드 -> 다른 결과)

      await sleep(SHOT_GAP_MS)

      // --- (C) 구조 확인(양성, 부록) — 같은(빗나가는) `seedMiss`를 유지한
      // 채 콘 반경만 0(출하 기본값)으로 되돌리면, `applySpread`의 계약
      // (coneRadiusRad===0 -> 편차 없음, `tests/unit/sim-combat.test.ts`가
      // 이미 고정)에 따라 다시 정조준 명중이어야 한다 — 콘 반경 오버라이드
      // 자체가 실제로 스프레드를 켜고 끈다는 것을 보여준다(우연한 seed
      // 궁합이 아니라).
      seam.spreadTuningOverride = { coneRadiusRad: 0 }
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      const afterRadiusZero = await waitForHpChange(roomB, roomB.sessionId, hpAfterPass2, 'RQ-90 콘 반경 0 복귀 후 hp 변화 대기')
      expect(afterRadiusZero.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY * 3) // 50 -> 25, 다시 명중

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    60_000, // F1 수정 이후 26발(12*2 + 2) — 이전(30_000ms, 4발)보다 넉넉히 늘렸다.
  )

  it(
    'RQ-90 리뷰 blocker 재현: handleFire가 정규화되지 않은 클라 조준 벡터를 applySpread에 그대로 넘기면, 콘 반경 0에서도 특정 방향에서 NaN으로 확정 미스가 난다(정규화 가드로 수정됨 — 이 발이 그 수정을 고정한다) + N7 서브임계 가드 확인(GA-49 그물은 별도 describe로 이동, 원장 22aa)',
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수
      const roomB = await joinGame(newClient(server)) // 피격자

      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      // RQ-31 회귀 대응(파일 상단 REV) — B의 RQ-16 해제는 화이트박스로.
      // A는 Safe Zone 밖으로 옮긴다(그러지 않으면 A의 사격 자체가 GA-19에
      // 막힌다) — 아래 (1)에서 B를 A 기준 상대 위치에 재배치하므로, A를
      // 먼저 옮기면 B도 자동으로 스폰 지점들에서 멀어져 Safe Zone 밖이
      // 된다(둘 다 원점에서 ~42m 근방 — 15개 스폰 지점은 전부 ~22m 반경
      // 안에 있어 여유가 크다).
      const seam = getServerRoom(roomA)
      seam.firedSinceSpawn.set(roomB.sessionId, true)
      const escapedA = escapeSafeZone(seam, roomA.sessionId, baselineA)
      await sleep(SHOT_GAP_MS)

      // 이 `it()`은 이전 `it()`이 룸에 남긴 상태(`spreadTuningOverride`·
      // `forcedSpreadSeed`)에 기대지 않는다 — 자기 완결적으로 명시한다
      // (22z4 회수, 재리뷰 minor N-3: 이전 버전은 `forcedSpreadSeed`를
      // 재설정하지 않아 이 주석이 사실과 어긋났다 — 아래 줄로 명시
      // 재설정해 주석을 사실로 만든다).
      seam.spreadTuningOverride = { coneRadiusRad: 0 } // (1)은 출하 기본값(반경 0)에서도 재현된다.
      seam.forcedSpreadSeed = undefined // 22z4 — 이전 `it()`의 값을 물려받지 않도록 명시 초기화(이후 각 발 앞에서 다시 확정한다)

      // --- (1) NaN 회귀 — 화이트박스로 B를 A(탈출 후 위치)와 정확히 같은
      // z·같은 높이, +X로 `DEGENERATE_DISTANCE`만큼 떨어진 지점에 배치한다
      // (자연 스폰 좌표는 이 정확한 퇴화 조건을 우연히 만족하지 않는다).
      // `teleportPlayer`가 `moveStates`와 `positionHistory`(RQ-64 되감기
      // 버퍼)를 함께 갱신하므로(코멘트 참고) `handleFire`의 대상 포즈
      // 조회가 텔레포트 이전의 stale 스냅샷이 아니라 방금 세팅한 위치를
      // 즉시 쓴다 — 틱 경과를 기다릴 필요가 없다.
      teleportPlayer(seam, roomB.sessionId, { x: escapedA.x + DEGENERATE_DISTANCE, y: escapedA.y, z: escapedA.z })

      // 사전 확인(오프라인, 네트워크 없음) — 이 기하에서 "정규화된" 방향은
      // 실제로 헤드에 명중해야 한다(그렇지 않다면 아래 실패가 이 blocker가
      // 아니라 테스트 기하 자체의 결함일 수 있다).
      const origin1 = eyeOrigin({ x: escapedA.x, y: escapedA.y, z: escapedA.z }, DEFAULT_HITBOX.eyeHeightM)
      const targetFoot1: Vec3 = { x: escapedA.x + DEGENERATE_DISTANCE, y: escapedA.y, z: escapedA.z }
      const normalizedDegenerateAim: Vec3 = { x: 1, y: 0, z: 0 }
      const sanityResult = raycastHitbox({ origin: origin1, direction: normalizedDegenerateAim }, { position: targetFoot1 }, DEFAULT_HITBOX)
      if (!sanityResult.hit || sanityResult.region !== 'head') {
        throw new Error(
          `RQ-90 리뷰 blocker 재현 셋업 실패 — 정규화된 방향 (1,0,0)이 이 기하에서 헤드에 명중해야 하는데 실제로는 ${JSON.stringify(sanityResult)}였다(DEGENERATE_DISTANCE 조정 필요).`,
        )
      }

      // 퇴화 벡터(단위가 아님, |dirX|=0.5<0.9 → helper={1,0,0} → cross=0
      // → NaN) — 정규화됐다면(위 사전 확인) 헤드에 명중해 데미지가
      // 줄어야 한다. **이 단언은 작성 당시 Red였다**(정규화 가드가 없던
      // 시점 — 실제로는 NaN이 전파돼 `raycastHitbox`가 걸러 무조건
      // 빗나가고, hp가 그대로였다). `GameRoom.ts:618`의 정규화 가드가
      // 그 이후 이 경로를 고쳤고, 이 발은 그 수정을 오늘도 회귀 없이
      // 고정하는 그물이다(위 22z3 REV 참고 — MUT-A가 이 가드를 되돌리면
      // 이 단언이 다시 죽는 것을 실측했다).
      const hpBeforeDegenerate = baselineB.hp
      roomA.send('fire', { dirX: 0.5, dirY: 0, dirZ: 0 })
      const afterDegenerate = await waitForHpChange(
        roomB,
        roomB.sessionId,
        hpBeforeDegenerate,
        'RQ-90 퇴화 조준 사격 후 hp 변화 대기',
      )
      expect(afterDegenerate?.hp).toBe(hpBeforeDegenerate - WEAPON.DAMAGE_BODY * WEAPON.HEADSHOT_MULTIPLIER)

      await sleep(SHOT_GAP_MS)

      // --- N7 방어 확인(2차 델타 재평가 지적) — `GameRoom.ts`의 정규화
      // 가드(`dirMagnitude < DEGENERATE_RADIAL_EPS`면 조기 return)는
      // `raycastHitbox`가 이미 갖고 있던 것과 **동일한 임계**를 재사용한다
      // (`combat.ts:170`) — 즉 크기가 `(0, DEGENERATE_RADIAL_EPS)` 구간인
      // 조준 벡터는 이 PR **이전**(`main`, `raycastHitbox` 자신의 가드)과
      // 오늘(`HEAD`, `GameRoom`의 가드) 둘 다 **빗나감**으로 처리해야
      // 한다는 뜻이다. 평가자가 그 가드를 통째로 삭제한 변이(MG1)를
      // 심었더니 전체 스위트(단위 353 + 통합 27)가 그대로 통과했다 —
      // 어떤 기존 테스트도 이 구간을 고정하지 않는다. MG1에서는 이
      // 구간의 벡터(예: `dirX: 1e-13`)가 정규화 후 정확히 `(1,0,0)`이
      // 되어(자기 자신으로 나누므로) 헤드에 명중한다 — 그래서 이 발이
      // 공허하지 않다. B는 (1)에서 배치한 위치를 그대로 유지한다(아직
      // hp=`hpBeforeDegenerate - HEADSHOT`, 생존 — 이 발이 명중하면
      // 정확히 사망 문턱에 닿으므로 "빗나감" 단언이 사망 여부와 무관하게
      // 명확하다).
      const hpBeforeSubDegenerate = afterDegenerate?.hp ?? hpBeforeDegenerate
      roomA.send('fire', { dirX: SUB_DEGENERATE_MAGNITUDE, dirY: 0, dirZ: 0 })
      await sleep(SHOT_GAP_MS)
      const afterSubDegenerate = readPlayer(roomB, roomB.sessionId)
      expect(afterSubDegenerate?.hp).toBe(hpBeforeSubDegenerate) // 변화 없음 — 가드가 이 구간을 거부해야 한다(MG1이 가드를 지우면 명중해 hp가 줄어든다)

      await sleep(SHOT_GAP_MS)

      // 대조군(양성) — 같은 방향의 단위 벡터(|dirX|=1>=0.9 → helper=
      // {0,1,0} → 퇴화 아님)는 이 리뷰 blocker와 무관하게 이전에도 정상
      // 동작했다. 이 단언이 실패하면 기하 자체가 잘못된 것이지 blocker와
      // 무관하다 — (1)의 실패가 "빗나가는 기하" 때문이 아니라 진짜
      // NaN 회귀 때문임을 보증한다. hp는 (1)·N7 확인의 실제 결과와
      // 무관하게 "직전 관측값에서 정확히 헤드 데미지만큼" 줄어야 하므로
      // 절대값이 아니라 직전 관측값 기준으로 단언한다.
      const hpBeforeUnitControl = afterSubDegenerate?.hp ?? hpBeforeDegenerate
      roomA.send('fire', { dirX: 1, dirY: 0, dirZ: 0 })
      const afterUnitControl = await waitForHpChange(
        roomB,
        roomB.sessionId,
        hpBeforeUnitControl,
        'RQ-90 단위 벡터 대조군 사격 후 hp 변화 대기',
      )
      expect(afterUnitControl?.hp).toBe(hpBeforeUnitControl - WEAPON.DAMAGE_BODY * WEAPON.HEADSHOT_MULTIPLIER)

      // --- (2) 벡터 크기가 콘 형태를 왜곡 — 이 자리에 있던 블록은
      // **제거했다**(원장 22z3/22aa, 재리뷰 major N-1). 도달 시점에 B가
      // 이미 hp 0(시신)이라 `handleFire`의 `!canAct` 피격 대상 필터가
      // 명중 후보에서 제외해 구조적으로 아무것도 관측할 수 없었다(재리뷰
      // E6·E7 실측 — MUT-VAC 변이에도 그대로 통과했다). 그 명제("조준
      // 벡터의 크기는 명중 여부·탄퍼짐 콘 모양에 영향을 주지 않는다")는
      // 골든 GA-49로 승격돼 아래 `describe('RQ-90/GA-49: ...')`가 대신
      // 검증한다 — 피격자가 시퀀스 내내 살아있도록 설계해 이 자리의
      // 공허를 원천적으로 만들지 않는다(파일 상단 REV 참고).

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    30_000,
  )
})

/**
 * RQ-90/GA-49(원장 22z7·22aa) — "악의적 클라이언트가 방향은 정상이지만
 * 크기가 1이 아닌 조준 벡터(1000배로 부풀리거나 1e-6배로 줄인 벡터)를
 * 보내며, 서버의 탄퍼짐 콘 반경은 0이 아닌 값으로 설정돼 있을 때, 판정
 * 결과가 같은 방향의 단위 벡터로 쏜 경우와 동일하다."
 *
 * **독립 서버·독립 룸** — 위 describe와 완전히 분리된 `beforeAll`/`afterAll`
 * 로 새 서버를 띄운다(파일 상단 REV "재배치 대신 신규 describe를 고른
 * 이유" 참고) — 위 두 `it()`이 남긴 hp·`spreadTuningOverride`·
 * `forcedSpreadSeed` 상태를 구조적으로 물려받을 수 없다(같은 프로세스
 * 안이라도 `matchMaker.getLocalRoomById`가 반환하는 룸 인스턴스 자체가
 * 다른 서버에 속한다).
 *
 * **공허함 회피(양성 대조 필수, 22z3 교훈)**: "아무 일도 없었다" 형태의
 * 단언만으로는 사격 자체가 무시돼도 통과한다. 그래서 매 배율(단위·과대·
 * 과소)마다 **같은 시드·같은 콘 반경**에서 오프라인 오라클이 예측한 버킷
 * ('body' 또는 'miss')과 정확히 일치하는지 단언한다 — 단위 벡터 대조가
 * 먼저 그 시드·반경 구간에서 사격이 실제로 유효함을 증명하고, 그 다음
 * 크기만 바꾼 발이 **같은 결과**를 내는지 비교한다.
 *
 * **바디 버킷이 시신을 만들지 않는 이유**: 이 describe는 바디 버킷에서
 * 정확히 3발(단위·과대·과소)만 쏜다 — `WEAPON.DAMAGE_BODY * 3 = 75 <
 * PLAYER.MAX_HP(100)`이라 피격자가 세 발 내내 살아있다(`canAct` 유지).
 * 위 describe의 (2) 블록이 공허했던 원인(대상이 이미 시신)을 설계로
 * 없앤 것이다 — 우연이 아니라 데미지 총합을 의도적으로 문턱 밑에 뒀다.
 *
 * **두 방향 × 두 버킷**: 골든 given이 명시한 두 방향(1000배 부풀리기·
 * 1e-6배 축소)을 각각 'body'·'miss' 두 버킷 모두에서 확인한다 — 한쪽
 * 방향·한쪽 버킷만 확인하면 "우연히 그 조합에서만 무해했다"는 반쪽
 * 결론을 배제하지 못한다.
 */
describe('RQ-90/GA-49: 조준 벡터의 크기(magnitude)는 명중 여부·탄퍼짐 콘의 모양에 영향을 주지 않는다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-90/GA-49: 콘 반경이 0이 아닐 때 조준 벡터를 1000배로 부풀리거나 1e-6배로 줄여도, 단위 벡터로 쏜 경우와 동일한 판정(바디 명중·빗나감 둘 다)이 나온다',
    async () => {
      const roomC = await joinGame(newClient(server)) // 사수 — 이 describe 전용 신규 서버·신규 세션
      const roomD = await joinGame(newClient(server)) // 피격자

      const baselineC = await waitForDefinedPlayer(roomC, roomC.sessionId)
      const baselineD = await waitForDefinedPlayer(roomD, roomD.sessionId)
      expect(baselineD.hp).toBe(PLAYER.MAX_HP)

      // RQ-31 회귀 대응(파일 상단 REV) — D의 RQ-16 해제는 화이트박스로.
      // C·D 둘 다 Safe Zone 밖으로 옮긴다 — 그러지 않으면 C의 사격 자체가
      // GA-19에 막히고, D가 Safe Zone 안에 있으면 RQ-16과 무관하게 GA-11이
      // 계속 피해를 무효화한다.
      const seam = getServerRoom(roomC)
      seam.firedSinceSpawn.set(roomD.sessionId, true)
      const escapedC = escapeSafeZone(seam, roomC.sessionId, baselineC)
      const escapedD = escapeSafeZone(seam, roomD.sessionId, baselineD)
      await sleep(SHOT_GAP_MS)

      // 이 it()이 쏘는 6발(3 바디 + 3 미스)은 기본 탄창(10발)으로도
      // 충분하지만, 재장전(RQ-11) 타이밍을 이 테스트의 관심사에서 완전히
      // 배제하기 위해 명시적으로 채운다(위 describe의 F1 수정과 동일 근거).
      seam.magazines.set(roomC.sessionId, AMPLE_MAGAZINE)

      const origin = eyeOrigin({ x: escapedC.x, y: escapedC.y, z: escapedC.z }, DEFAULT_HITBOX.eyeHeightM)
      const targetFoot: Vec3 = { x: escapedD.x, y: escapedD.y, z: escapedD.z }
      const { aim, distance } = aimAtBodyWithDistance(escapedC, escapedD)
      // GA-49 given: "탄퍼짐 콘 반경은 0이 아닌 값" — 반경 0이면 크기가
      // 결과에 전혀 드러나지 않아 이 골든이 공허해진다(위 describe와 동일
      // 근거로 `spreadTuningOverride`를 쓴다. 출하 기본값은 불변).
      const coneRadiusRad = Math.atan(DEFAULT_HITBOX.bodyRadiusM / distance) * SPREAD_CONE_MULTIPLIER
      seam.spreadTuningOverride = { coneRadiusRad }

      // 오프라인 오라클로 이 정확한 기하·반경에서 '바디 명중'·'빗나감'을
      // 내는 시드를 각각 하나씩 확정한다 — 두 버킷 모두에서 크기 무관성을
      // 확인해야 "우연히 한쪽 판정에만 무해했다"는 반쪽 결론을 피한다.
      const seedBody = findSeedWithBucket(origin, aim, targetFoot, coneRadiusRad, 'body', SEARCH_LIMIT)
      const seedMiss = findSeedWithBucket(origin, aim, targetFoot, coneRadiusRad, 'miss', SEARCH_LIMIT)

      // ============================================================
      // 바디 버킷 3연발(단위 → 과대 → 과소) — 셋 다 정확히 같은 시드·
      // 같은 콘 반경에서 쏜다. 데미지 총합 75 < 100이라 D가 세 발 내내
      // 살아있다.
      // ============================================================
      seam.forcedSpreadSeed = seedBody // 매 발 앞에서 다시 확정한다(22z4 교훈 — 이전 it()의 값에 기대지 않는다)
      const hpBeforeBodyUnit = baselineD.hp
      roomC.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z }) // 단위 벡터(양성 대조 — 22z3가 요구한 "같은 반경·같은 시드 구간의 양성 대조")
      const afterBodyUnit = await waitForHpChange(
        roomD,
        roomD.sessionId,
        hpBeforeBodyUnit,
        'RQ-90/GA-49 바디 버킷 단위 벡터 대조 사격 후 hp 변화 대기',
      )
      expect(afterBodyUnit.hp).toBe(hpBeforeBodyUnit - WEAPON.DAMAGE_BODY) // 오라클 예측('body')과 일치 — 이 구간에서 사격 자체가 실제로 명중함을 먼저 증명한다
      await sleep(SHOT_GAP_MS)

      seam.forcedSpreadSeed = seedBody
      roomC.send('fire', {
        dirX: aim.x * OVERSIZED_AIM_SCALE,
        dirY: aim.y * OVERSIZED_AIM_SCALE,
        dirZ: aim.z * OVERSIZED_AIM_SCALE,
      }) // 같은 방향, 크기만 1000배
      const afterBodyOversized = await waitForHpChange(
        roomD,
        roomD.sessionId,
        afterBodyUnit.hp,
        'RQ-90/GA-49 바디 버킷 과대(x1000) 사격 후 hp 변화 대기',
      )
      expect(afterBodyOversized.hp).toBe(afterBodyUnit.hp - WEAPON.DAMAGE_BODY) // 단위 벡터와 정확히 같은 결과 — GA-49 then(부풀리기 방향, body 버킷)
      await sleep(SHOT_GAP_MS)

      seam.forcedSpreadSeed = seedBody
      roomC.send('fire', {
        dirX: aim.x * UNDERSIZED_AIM_SCALE,
        dirY: aim.y * UNDERSIZED_AIM_SCALE,
        dirZ: aim.z * UNDERSIZED_AIM_SCALE,
      }) // 같은 방향, 크기만 1e-6배
      const afterBodyUndersized = await waitForHpChange(
        roomD,
        roomD.sessionId,
        afterBodyOversized.hp,
        'RQ-90/GA-49 바디 버킷 과소(x1e-6) 사격 후 hp 변화 대기',
      )
      expect(afterBodyUndersized.hp).toBe(afterBodyOversized.hp - WEAPON.DAMAGE_BODY) // 단위 벡터와 정확히 같은 결과 — GA-49 then(축소 방향, body 버킷)

      await sleep(SHOT_GAP_MS)

      // ============================================================
      // 빗나감 버킷 3연발(단위 → 과대 → 과소) — D는 hp=25(생존)로 시작해
      // 이 구간 내내 변하지 않아야 한다. "변화 없음"을 확인하는 구간이라
      // `waitForHpChange`(변화를 기다리는 헬퍼)가 아니라 고정 슬립 뒤 값을
      // 읽는다 — 파일 상단 "결정론 메모"가 이미 명시한 기존 예외와 동일한
      // 이유(그 자체가 확인 대상이라 이벤트 기반 대기가 부적합하다).
      // ============================================================
      seam.forcedSpreadSeed = seedMiss
      const hpBeforeMissUnit = afterBodyUndersized.hp
      roomC.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z }) // 단위 벡터(양성 대조)
      await sleep(SHOT_GAP_MS)
      const afterMissUnit = readPlayer(roomD, roomD.sessionId)
      expect(afterMissUnit?.hp).toBe(hpBeforeMissUnit) // 오라클 예측('miss')과 일치 — 변화 없음(이 구간에서도 사격 판정 자체는 정상 동작함을 먼저 증명)

      seam.forcedSpreadSeed = seedMiss
      roomC.send('fire', {
        dirX: aim.x * OVERSIZED_AIM_SCALE,
        dirY: aim.y * OVERSIZED_AIM_SCALE,
        dirZ: aim.z * OVERSIZED_AIM_SCALE,
      })
      await sleep(SHOT_GAP_MS)
      const afterMissOversized = readPlayer(roomD, roomD.sessionId)
      expect(afterMissOversized?.hp).toBe(hpBeforeMissUnit) // 부풀려도 여전히 빗나감 — GA-49 then(부풀리기 방향, miss 버킷)

      seam.forcedSpreadSeed = seedMiss
      roomC.send('fire', {
        dirX: aim.x * UNDERSIZED_AIM_SCALE,
        dirY: aim.y * UNDERSIZED_AIM_SCALE,
        dirZ: aim.z * UNDERSIZED_AIM_SCALE,
      })
      await sleep(SHOT_GAP_MS)
      const afterMissUndersized = readPlayer(roomD, roomD.sessionId)
      expect(afterMissUndersized?.hp).toBe(hpBeforeMissUnit) // 줄여도 여전히 빗나감 — GA-49 then(축소 방향, miss 버킷)

      await Promise.all([leaveRoom(roomC), leaveRoom(roomD)])
    },
    30_000,
  )
})
