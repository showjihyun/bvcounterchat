import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { FALL_DAMAGE, PLAYER } from '@shared/constants'

/**
 * RQ-18 낙하 데미지 — 서버 권위(RQ-61) 통합 테스트 (ADR-0008: Colyseus 룸
 * 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-44·GA-45·GA-46**
 * (`harness/evals/golden/track-a-product.jsonl`, `verify` 필드가 이 파일
 * 경로를 정확히 지정한다).
 * - GA-44: 안전 높이(3m) 이하 낙하 → 무피해.
 * - GA-45: 초과 낙하(예: 8m) → 초과분 1m당 10 데미지 정확 적용, 즉사
 *   임계 없음.
 * - GA-46: 낙하 데미지만으로 HP 0 이하가 되는 낙하 → 사망 처리 + 리스폰이
 *   정상 예약되어 3초 후 재배치된다(원장 22e "사망 처리 중앙화" — 현재
 *   `diedAtTick.set`이 `handleFire` 한 곳뿐이라 낙하로 죽으면 영구 시신이
 *   되는 결함의 회귀 고정).
 *
 * **레벨 분리(ADR-0008/ADR-0011)**: "낙하 높이 → 데미지"의 정밀 산술 경계
 * (정확히 3m는 0, 8m는 정확히 50, 즉사 임계 없음)는 `tests/unit/
 * sim-fall-damage.test.ts`(A계층, 결정론 — `fallDamageForHeight` 직접 호출)가
 * 이미 고정했다. 이 파일(B계층)은 그 산술이 실 `GameRoom` 30Hz 틱 루프의
 * 착지 판정에 실제로 배선돼 있는지를 실 WebSocket으로 블랙박스 확인한다
 * (`rq-15-respawn-timer.test.ts` 등이 채택한 A/B 분리와 동일 정신).
 *
 * ---
 *
 * ## 설계 쟁점 1 — 실 게임플레이로는 낙하 데미지를 유발할 방법이 없다
 *
 * `MOVEMENT.JUMP_HEIGHT`(1.0m, RQ-92)가 `FALL_DAMAGE.SAFE_HEIGHT_M`(3m)보다
 * 작다. `@shared/sim/movement`의 해석적 점프 궤적은 항상 y=0에서 이륙해
 * y=0으로 착지하고, 공중 가속·이중 점프도 없다(RQ-92) — 즉 **이번 라운드
 * (평지 y=0, RQ-21 사다리·RQ-22 박스·지형 고저차는 원장 22e가 명시한 스코프
 * 밖)의 실제 `'move'` 프로토콜만으로는 어떤 입력을 보내도 플레이어가 3m를
 * 넘는 높이에 도달할 수 없다**. GA-45(8m 낙하)·GA-46(치명적 낙하)을 검증하려면
 * 지형이 필요한데 지형은 스코프 밖이므로, 이 라운드에서 "서버가 실제로 착지
 * 시 낙하 데미지를 적용하는가"를 검증하려면 높이를 **테스트가 직접 주입**하는
 * 수밖에 없다 — 이것이 아래 "화이트박스 기법"의 존재 이유다. (반대로 GA-44는
 * 실제 점프(최고 1.0m < 3m)만으로 100% 실 E2E로 검증 가능하다 — 아래
 * "동일 절차" 설계 참고.)
 *
 * ## 설계 쟁점 2 — 화이트박스 기법(신규 패턴, 선례와 정합)
 *
 * 이 파일은 `colyseus`의 `matchMaker.getLocalRoomById(roomId)`(실측 확인,
 * `node_modules/@colyseus/core/build/MatchMaker.d.ts`)로 테스트 프로세스
 * **안에서** 실제로 기동 중인 `GameRoom` 인스턴스를 직접 얻어, 그 인스턴스의
 * private map(TypeScript `private`는 컴파일 타임 표시일 뿐 런타임 접근을
 * 막지 않는다)에 낙하 시작 높이를 직접 심는다. `src/`를 수정하는 것이
 * **아니다** — 같은 프로세스 안에서 이미 실행 중인 서버 상태를 테스트가
 * 조작하는 것이다.
 *
 * **왜 정당한가**: (1) `diedAtTick`·`spawnedAtTick`·`firedSinceSpawn` 같은
 * `GameRoom` 내부 private map의 **정확한 이름**은 이미 여러 라운드째
 * test-writer가 지정해 온 그린필드 계약이다(`sim-lifecycle.test.ts`,
 * `rq-15-respawn-timer.test.ts` 등 — 통합 테스트가 아니라 docblock을 통해서긴
 * 하나, "coder가 따라야 할 정확한 필드 이름"을 test-writer가 못박는 선례는
 * 이미 있다). 이 파일은 그 선례를 한 단계 더 밀어 **테스트가 그 이름을 직접
 * 참조**할 뿐이다. (2) 지형 없이 높이를 만들 다른 방법이 구조적으로 없다
 * (위 쟁점 1). (3) `verify` 경로가 이미 `tests/integration/...`로 못박혀
 * 있어(GA-44~46 전부) 이 검증이 통합 레벨에서 이뤄져야 한다는 것은
 * 골든 자체의 요구다.
 *
 * **범위 제한(중요)**: 화이트박스는 "낙하가 어디서 시작됐는가"(높이)만
 * 주입한다 — 착지 판정·데미지 적용·사망 처리·리스폰 예약은 전부 실
 * `GameRoom` 30Hz 틱 루프가 그대로 수행한다. 즉 이 파일이 검증하는 것은
 * "주입한 높이가 정확히 처리되는가"이지 "그 높이에 실제로 도달할 수
 * 있는가"가 아니다 — 후자는 맵 단계(RQ-21/22/30~32)의 몫이다.
 *
 * **그린필드 계약(test-writer 지정)**: `GameRoom`은 세션별 "현재 연속 공중
 * 구간의 최고 y"를 신규 private map `fallPeakY: Map<string, number>`로
 * 추적해야 한다:
 * - `stepPlayerMovement`에서 `next = stepMovement(previous, input)` 직후,
 *   `next.grounded === false`이면 `fallPeakY.set(sessionId,
 *   Math.max(fallPeakY.get(sessionId) ?? next.y, next.y))`(러닝 최댓값).
 * - `previous.grounded === false && next.grounded === true`(착지 전이)이면:
 *   `peak = fallPeakY.get(sessionId) ?? 0`; `damage =
 *   fallDamageForHeight(peak)`(`@shared/sim/fallDamage`); `damage > 0`이면
 *   `applyDamageWithProtection(player.hp, damage, isProtected)`으로 적용
 *   (스폰 보호 게이트는 `handleFire`와 동일 지점 재사용 — 아래 "스폰 보호"
 *   절 참고); died면 가해자가 없으므로 킬 카운트는 증가시키지 않되
 *   `diedAtTick.set(sessionId, currentTick)`은 반드시 갱신한다(원장 22e
 *   "사망 처리 중앙화" — GA-46이 이 회귀를 고정한다); 이후 `fallPeakY
 *   .delete(sessionId)`로 다음 공중 구간을 위해 초기화한다.
 *
 * 이 계약의 정확한 필드 이름(`fallPeakY`)에 이 파일의 화이트박스 접근이
 * 그대로 결합돼 있다 — coder가 다른 이름을 쓰면 이 테스트는 (의미 있는
 * 행동 불일치가 아니라) 화이트박스 접근 자체가 실패해 Red가 된다. 이는
 * 이 접근법의 알려진 트레이드오프다(위 "왜 정당한가" (1) 참고 — 기존
 * `diedAtTick` 등도 동일한 종류의 결합이 이미 있었다).
 *
 * ## 스폰 보호(RQ-16)와의 상호작용 — 강제하지 않음
 *
 * 낙하 데미지가 스폰 보호(3초) 창 안에서도 무효화되어야 하는지는 스펙이
 * 침묵한다. 이 파일은 그 질문에 답하지 않는다 — 모든 케이스가 접속 직후
 * 자기 자신에게 빗나가는 사격(`UP_MISS_AIM`, 기존 RQ-15/16 파일들과 동일
 * 패턴)으로 스폰 보호를 **먼저 해제한** 뒤에만 점프·낙하를 시작하므로,
 * coder가 낙하 데미지에 보호를 적용하든 안 하든 이 파일은 동일하게
 * 통과한다.
 *
 * ## 양성 대조군 설계(공허화 방지)
 *
 * "무피해"류 음성 단언만 있으면 스폰 보호·착지 판정 미배선 등 **다른 이유**
 * 로도 통과할 수 있다. 이 파일은 GA-44(무피해)·GA-45(50 데미지)를 **완전히
 * 동일한 절차**(`jumpAndObserveLanding`)로 실행하고 화이트박스로 주입하는
 * 높이만 다르게 한다 — GA-44는 어떤 높이도 주입하지 않아(실제 점프 물리
 * 그대로) 무피해가 "장치가 꺼져 있어서"가 아니라 "3m 이하라서"임을 GA-45가
 * 같은 절차에서 실제로 데미지가 드는 것으로 반증한다. **주의**: GA-44
 * 단독은 현재(미구현) 상태에서도 트리비얼하게 통과한다(아무것도 안 하므로
 * HP도 안 바뀐다) — 이 GA의 Red 증거력은 GA-45와의 **짝**에서 나온다는
 * 점을 평가자가 판단할 때 감안할 것(Red 실행 출력 보고서에 명시).
 *
 * **가정**: `rq-15-respawn-timer.test.ts`/`rq-16-spawn-protection.test.ts`의
 * 서버 기동·`waitForPlayerCondition`·타임아웃 패턴을 그대로 따른다.
 *
 * ---
 *
 * ## REV(평가 F1·F2 보강, `_workspace/RQ-18/03_evaluator_report.md` §6)
 *
 * 평가(evaluator)가 변이 11건으로 PASS 판정했으나, 생존 변이 2건을 기록했다
 * (FAIL은 아님 — 테스트 강도 공백). 기존 단언은 전혀 건드리지 않고 아래
 * 두 가지를 **순증**했다.
 *
 * **F1 — 착지 전이 조건이 테스트로 고정돼 있지 않았다.** 변이 M1
 * (`trackFallDamage`의 `if (previous.grounded) return` → `if
 * (!previous.grounded) return`, 조건 극성 반전)이 기존 스위트 전체에서
 * survived였다. 이 변이 아래에서는 **모든** 착지 전이(`previous.grounded
 * === false`는 착지 전이의 정의 그 자체)가 조기 반환돼 데미지 적용이
 * "그 다음 접지 유지 틱"으로 미뤄진다 — 최종 합산 HP는 결국 같은 값에
 * 수렴하므로(지연될 뿐 유실·중복은 아님) **"착지 후 어느 정도 시간이
 * 지나 관측한 HP"로는 이 변이를 잡을 수 없다** — 기존 `jumpAndObserveLanding`
 * 이 착지 후 `POST_LANDING_SETTLE_MS`(300ms ≈ 9틱)를 기다린 뒤 읽는
 * 이유가 바로 이 여유이며, 그 여유 자체가 M1을 가려버린다(직접 재현으로
 * 확인 — 아래 참고).
 *
 * **1차 시도(폐기) — 착지 순간 서버 상태를 짧은 간격으로 폴링**: 처음에는
 * "착지가 관측된 바로 그 순간 hp가 이미 줄어 있는가"를 서버 상태(클라
 * 패치가 아니라 `matchMaker.getLocalRoomById`로 얻은 살아있는 객체)를
 * 2ms 간격으로 폴링해 확인하려 했다 — `player.y = next.y`가
 * `trackFallDamage(...)` 호출보다 먼저, 같은 동기 구간 안에서 실행되므로
 * (`src/server/rooms/GameRoom.ts` 확인) 이론상 "y만 갱신되고 hp는 아직인"
 * 찢어진 상태는 관측 불가능해야 했다. **하지만 직접 재현(M1 적용 후 이
 * 방식으로 실행)했더니 여전히 Green이었다** — 자바스크립트 이벤트 루프의
 * 타이머 스케줄링 지터(폴링 콜백 자체가 정확히 2ms마다 실행된다는 보장이
 * 없다 — 다른 콜백(틱 루프, WS 메시지 처리 등)에 밀려 지연될 수 있다)
 * 때문에, 착지 틱(단 1틱 ≈33.33ms)이라는 좁은 창을 매번 정확히 잡는다는
 * 보장이 없었다. 즉 **폴링 기반 "정확히 그 틱을 잡는" 접근은 이론과
 * 달리 결정론적이지 않았다** — 실측으로 폐기를 확정했다(부정 결과도
 * 정직하게 기록).
 *
 * **채택안 — 버니합으로 "접지 유지 틱" 자체를 없앤다**: 정확한 타이밍을
 * 맞추는 대신, **그 문제 자체를 없앴다.** `jump: true`를 보낸 뒤 이
 * 케이스 안에서는 **비활성화하지 않는다.** `stepGrounded`는 매 틱
 * `input.jump`가 참이면 무조건 재이륙시키므로(`@shared/sim/movement`,
 * 쿨다운 없음), jump를 계속 유지하는 한 "착지 전이가 **아닌** 채로 접지
 * 상태에 머무르는 틱"은 **정의상 단 한 번도 오지 않는다** — 매 착지가
 * 곧바로 다음 이륙으로 이어진다(무한 버니합). M1 아래에서 착지 전이는
 * 항상 조기 반환되고, 데미지 적용 분기(`if (previous.grounded) return`을
 * 통과해야 도달하는 코드)는 오직 "접지를 유지하는" 틱에서만 실행되는데,
 * 그런 틱이 이 시나리오에는 아예 없으므로 **데미지 적용이 무기한 보류된다**
 * — 아무리 오래 기다려도 hp가 줄지 않는다. 반대로 올바른 구현은 착지
 * 전이 그 자체(그 틱 안)에서 동기적으로 적용하므로 버니합이 계속되든
 * 말든 무관하게 곧바로(첫 비행 시간 안에) hp가 준다. **더 이상 "정확한
 * 틱을 붙잡을 수 있는가"에 기대지 않는다** — 클라이언트 `onStateChange`
 * (기존 `waitForPlayerCondition`)로 "hp가 기대값이 될 때까지, 넉넉한
 * 상한 안에서" 기다리기만 하면 된다. M1 아래에서는 이 대기가 결정론적으로
 * (운에 좌우되지 않고) 타임아웃된다 — 폴링 간격이나 패치 배치 타이밍과
 * 무관하다.
 *
 * **직접 재현(M1 재현·복원 절차, 팀리드 지시)**: `src/server/rooms/
 * GameRoom.ts`의 `if (previous.grounded) return`을 `if (!previous.grounded)
 * return`으로 바꾼 뒤 이 파일 전체 실행 → 기존 GA-44/45/46은 여전히
 * **Green**(evaluator M1 결과와 일치 — 최종 합산은 수렴하므로 기존
 * 단언은 이 변이를 구분하지 못함을 이 파일 스스로도 재확인한다), **신규
 * F1만 Red**(`[timeout 10000ms] ... 버니합 유지 중 첫 착지 데미지 반영
 * 대기` — 무기한 보류되어 타임아웃). 바이트 사본으로 원복 후 재실행 →
 * 전부 **Green**. 전문은 `_workspace/RQ-18/01_test-writer_red.md`
 * "F1·F2 보강" 절(1차 시도 실패 로그 포함).
 *
 * **F2 — "낙하 사망은 킬을 기록하지 않는다"에 회귀 가드가 없었다.** 변이
 * M5(`registerDeath(sessionId, currentTick)` 호출에 `killerId`로 자기
 * 자신의 `sessionId`를 추가 전달)가 survived였다 — 오늘의 동작(킬 미기록)은
 * 옳지만 그 옳음이 테스트가 아니라 코드 리뷰에만 의존했다. GA-46(치명적
 * 낙하) 직후 `kills === 0`을 한 줄 추가해 고정한다(스코프 크리프 아님 —
 * 새 요구 신설이 아니라 이미 구현된 결정을 고정하는 것, RQ-14 "가해자에게
 * 킬을 기록"의 반대 방향 — 가해자가 없으면 아무에게도 기록되지 않아야
 * 한다).
 *
 * ## REV2(리뷰 minor 3·5 보강, 팀리드 지시, `_workspace/review/
 * feat-RQ-18-fall-damage.md`)
 *
 * **minor 5 — RQ-16 "모든 피해" 이행에 회귀 가드가 없었다.** 리뷰 쟁점 4
 * 판정: RQ-16(`harness/specs/requirements.md:71-73`) "3초간 그 플레이어가
 * 받는 **모든 피해**를 무효화"는 스펙 침묵이 아니라 명문 요구이고,
 * `trackFallDamage`가 스폰 보호 게이트를 적용하는 것은 그 문면의 직접
 * 이행이다. 그런데 기존 통합 3케이스가 전부 점프 전에 `UP_MISS_AIM` 자기
 * 사격으로 보호를 먼저 해제하므로, 그 게이트를 통째로 제거해도(평가 변이
 * M9) 스위트가 침묵했다. 아래 새 `describe` 블록이 자기 사격을 **하지
 * 않은 채**(최초 입장 스폰 보호가 유효한 상태) 치명적 최고점
 * (`FATAL_OVERRIDE_PEAK_M`)을 주입해 착지시키고 `hp === PLAYER.MAX_HP`를
 * 단언한다 — `SPAWN_PROTECTION_MS`(3000ms)에 비해 점프~착지 실측 소요는
 * 약 0.632초(리뷰 minor 6 근거)뿐이라 타이밍 여유는 넉넉하다.
 *
 * **minor 3 — F1의 "버니합 중 접지 유지 틱 없음" 전제가 단언되지
 * 않았다.** F1(위 REV 절)의 M1 검출력은 그 전제에 전적으로 의존하는데,
 * 전제는 docblock 서술뿐이고 코드로 확인되지 않았다. 점프 쿨다운·연사
 * 제한 등이 도입돼 전제가 깨지면 F1은 실패하지 않고 조용히 GA-45의
 * 중복으로 퇴화한다. F1 `it()` 끝(기존 hp 단언 뒤, `finally` 앞)에
 * 전제 자체를 직접 단언하는 대기를 순증했다 — 첫 착지 데미지 반영 이후에도
 * 재이륙(y>0)이 관측돼야 한다. 쿨다운이 도입되면 이 대기가
 * `AIRBORNE_OBSERVE_TIMEOUT_MS` 안에 타임아웃되어 "전제가 깨졌으니 F1을
 * 재설계하라"는 신호를 정확히 낸다 — 기존 헬퍼·상수를 그대로 재사용했다
 * (새 매직 넘버 없음).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const SNAPSHOT_TIMEOUT_MS = 5_000
/** 자기 사격(스폰 보호 해제)이 서버에 반영될 시간. 기존 RQ-15/16 파일들과
 * 동일한 값·동일한 근거. */
const SELF_FIRE_SETTLE_MS = 300
/** 점프 입력이 실제로 처리돼 공중 상태(y>0)가 관측되기까지의 상한. 정상
 * 조건에서는 1~2틱(약 33~67ms) 안에 관측된다 — 스케줄링 지터를 넉넉히
 * 흡수하는 여유. */
const AIRBORNE_OBSERVE_TIMEOUT_MS = 3_000
/** 착지(y가 0으로 복귀) 관측 상한. 실제 중력 값은 구현 자유(`sim-movement
 * .test.ts` "점프 궤적 유도" 참고 — 실측: 매우 완만한 g=0.5조차 약 170틱
 * ≈5.7초)라 넉넉하게 잡는다 — `rq-15-respawn-timer.test.ts`의
 * `RESPAWN_OBSERVE_TIMEOUT_MS`(8000ms)와 동일한 여유 원칙. */
const LANDING_OBSERVE_TIMEOUT_MS = 10_000
/** 착지 직후 데미지 적용 틱이 반영될 시간(로컬 WS라 짧아도 충분, 여유). */
const POST_LANDING_SETTLE_MS = 300
/** GA-46 리스폰 관측 상한 — 기존 rq-15 파일과 동일 근거. */
const RESPAWN_OBSERVE_TIMEOUT_MS = 8_000
/** "3초보다 눈에 띄게 이르게 리스폰되면 안 된다"는 하한 — rq-15 파일과
 * 동일 근거(스케줄링 지터 흡수 500ms 관대). */
const MIN_RESPAWN_ELAPSED_MS = 2_500

/** GA-45: 초과분 1m당 10 데미지 — (8-3)×10=50, 생존(HP 50 잔존). */
const NON_FATAL_OVERRIDE_PEAK_M = 8
/** GA-46: (3+10+5-3)×10=150 > PLAYER.MAX_HP(100) — 낙하 데미지만으로
 * 확실히 사망하도록 여유를 둔 값(경계에 딱 맞추지 않는다 — 부동소수점
 * 경계 우연 방지). */
const FATAL_OVERRIDE_PEAK_M = FALL_DAMAGE.SAFE_HEIGHT_M + PLAYER.MAX_HP / FALL_DAMAGE.DAMAGE_PER_METER + 5

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

interface PlayerSnapshot {
  x: number
  y: number
  z: number
  hp: number
  /** 평가 F2 회귀 가드용(GA-46) — 낙하(환경 피해)는 가해자가 없으므로
   * 어떤 세션의 킬 수도 늘어서는 안 된다. */
  kills: number
}

function readPlayer(room: Room, sessionId: string): PlayerSnapshot | undefined {
  const state = room.state as {
    players?: {
      get?: (key: string) => { x?: unknown; y?: unknown; z?: unknown; hp?: unknown; kills?: unknown } | undefined
    }
  } | null
  const player = state?.players?.get?.(sessionId)
  if (
    typeof player?.x === 'number' &&
    typeof player?.y === 'number' &&
    typeof player?.z === 'number' &&
    typeof player?.hp === 'number' &&
    typeof player?.kills === 'number'
  ) {
    return { x: player.x, y: player.y, z: player.z, hp: player.hp, kills: player.kills }
  }
  return undefined
}

function waitForPlayerCondition(
  room: Room,
  sessionId: string,
  predicate: (p: PlayerSnapshot) => boolean,
  label: string,
  timeoutMs: number,
): Promise<PlayerSnapshot> {
  return withTimeout(
    new Promise<PlayerSnapshot>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayer(room, sessionId)
        if (current && predicate(current)) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    timeoutMs,
    label,
  )
}

/** GA-06/GA-08/RQ-16 파일들과 동일한 근거로 기하학적으로 항상 빗나가는
 * 방향(수직 위) — 자기 자신을 쏘면 최초 입장 스폰 보호가 즉시 해제된다
 * (RQ-16). 이 파일에는 대상(다른 플레이어)이 없다 — 낙하 데미지는
 * 가해자 없는 환경 피해라 단일 플레이어로 충분하다. */
const UP_MISS_AIM = { dirX: 0, dirY: 1, dirZ: 0 }

/** 화이트박스 접근 대상 계약 — 파일 상단 "그린필드 계약" 절 참고.
 * `fallPeakY`는 아직 존재하지 않는 신규 필드다(Red 전제). */
interface FallDamageTestSeam {
  fallPeakY: Map<string, number>
}

/** `matchMaker.getLocalRoomById`(실측 확인, `@colyseus/core`)로 테스트
 * 프로세스 안에서 실행 중인 실제 `GameRoom` 인스턴스를 얻는다 — 파일 상단
 * "설계 쟁점 2" 참고. 룸을 찾지 못하면(경로 오류) 착지 이후 관측이 아니라
 * 여기서 즉시 실패해 원인을 분명히 한다. */
function getServerRoom(room: Room): FallDamageTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as FallDamageTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-18 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/**
 * 실제 점프를 1회 실행하고, (선택적으로) 화이트박스로 낙하 시작 높이를
 * 주입한 뒤, 착지까지 관측한다 — GA-44·GA-45·GA-46이 **동일한 절차**를
 * 공유한다(공허화 방지, 파일 상단 "양성 대조군 설계" 참고).
 *
 * 1. `jump: true`를 1회 보내고 곧바로 `jump: false`(유지 입력)를 보낸다 —
 *    `jump`는 엣지 트리거라(`@shared/sim/movement` 계약) 유지하면 착지 직후
 *    다시 점프해 버린다(끝없는 버니합). 두 메시지 사이 간격(50ms)은 실제
 *    이륙까지 걸리는 시간(최소 1틱)보다 훨씬 짧아 첫 점프가 새는 일이
 *    없다.
 * 2. 공중 상태(y>0)가 실제로 관측될 때까지 기다린다(점프가 실제로
 *    처리됐다는 확인 — 관측 없이 바로 화이트박스를 주입하면 아직 접지
 *    상태인 세션에 주입하는 셈이 되어 다음 착지 전이 판정과 타이밍이
 *    어긋날 수 있다).
 * 3. `overridePeakM`이 주어지면 그 시점의 `fallPeakY`를 그 값으로 덮어쓴다
 *    — 이후 실제 물리가 이어 계산하는 높이는(최고 1.0m 미만이므로) 항상
 *    이 값보다 작아 `Math.max` 갱신에서 살아남는다(그린필드 계약의 러닝
 *    최댓값 규칙).
 * 4. 착지(y가 다시 0으로 복귀)까지 기다린다 — 어떤 중력 구현을 고르든
 *    (구현 자유, `sim-movement.test.ts` 참고) 상한 안에서 자연히 착지한다.
 */
async function jumpAndObserveLanding(room: Room, overridePeakM?: number): Promise<PlayerSnapshot> {
  const sessionId = room.sessionId

  room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: true })
  await sleep(50)
  room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })

  await waitForPlayerCondition(room, sessionId, (p) => p.y > 0, 'RQ-18: 점프 후 공중 상태(y>0) 관측 대기', AIRBORNE_OBSERVE_TIMEOUT_MS)

  if (overridePeakM !== undefined) {
    getServerRoom(room).fallPeakY.set(sessionId, overridePeakM)
  }

  const landed = await waitForPlayerCondition(
    room,
    sessionId,
    (p) => p.y === 0,
    'RQ-18: 착지(y=0 복귀) 관측 대기',
    LANDING_OBSERVE_TIMEOUT_MS,
  )
  await sleep(POST_LANDING_SETTLE_MS)
  const settled = readPlayer(room, sessionId)
  return settled ?? landed
}

describe('RQ-18/GA-44/GA-45: 낙하 데미지 — 안전 높이 이하 무피해 vs 초과 낙하 정확 적용(동일 절차, 양성 대조군)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-18/GA-44: 실제 점프(최고 1.0m, 안전 높이 3m 이하)로 착지해도 HP가 변하지 않는다 — 무피해',
    async () => {
      const client = newClient(server)
      const room = await joinGame(client)

      try {
        const baseline = await waitForPlayerCondition(room, room.sessionId, () => true, '초기 스냅샷', SNAPSHOT_TIMEOUT_MS)
        expect(baseline.hp).toBe(PLAYER.MAX_HP)

        room.send('fire', UP_MISS_AIM) // 최초 입장 스폰 보호(RQ-16) 즉시 해제
        await sleep(SELF_FIRE_SETTLE_MS)

        // 화이트박스 주입 없음 — 실제 점프 물리 그대로(최고점 < 3m).
        const afterLanding = await jumpAndObserveLanding(room)

        expect(afterLanding.hp).toBe(PLAYER.MAX_HP)
      } finally {
        await leaveRoom(room)
      }
    },
    20_000,
  )

  it(
    'RQ-18/GA-45(양성 대조군): 동일 절차에서 낙하 시작 높이를 8m로 주입하면 초과분(8-3)×10=50 데미지가 정확히 적용된다',
    async () => {
      const client = newClient(server)
      const room = await joinGame(client)

      try {
        const baseline = await waitForPlayerCondition(room, room.sessionId, () => true, '초기 스냅샷', SNAPSHOT_TIMEOUT_MS)
        expect(baseline.hp).toBe(PLAYER.MAX_HP)

        room.send('fire', UP_MISS_AIM) // 최초 입장 스폰 보호(RQ-16) 즉시 해제
        await sleep(SELF_FIRE_SETTLE_MS)

        const afterLanding = await jumpAndObserveLanding(room, NON_FATAL_OVERRIDE_PEAK_M)

        const expectedDamage = (NON_FATAL_OVERRIDE_PEAK_M - FALL_DAMAGE.SAFE_HEIGHT_M) * FALL_DAMAGE.DAMAGE_PER_METER
        expect(expectedDamage).toBe(50) // GA-45 given 그대로 — 리터럴로도 재확인
        expect(afterLanding.hp).toBe(PLAYER.MAX_HP - expectedDamage)
        expect(afterLanding.hp).toBe(50)
      } finally {
        await leaveRoom(room)
      }
    },
    20_000,
  )
})

describe('RQ-18/GA-46: 낙하 데미지로 사망 → 리스폰이 정상 예약된다(사망 처리 중앙화 회귀 고정)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-18/GA-46: 낙하 데미지만으로 HP가 0이 되면 사망 처리되고, 3초 후 SPAWN_POINTS 중 하나로 재배치되며 HP가 100으로 복귀한다',
    async () => {
      const client = newClient(server)
      const room = await joinGame(client)

      try {
        const baseline = await waitForPlayerCondition(room, room.sessionId, () => true, '초기 스냅샷', SNAPSHOT_TIMEOUT_MS)
        expect(baseline.hp).toBe(PLAYER.MAX_HP)

        room.send('fire', UP_MISS_AIM) // 최초 입장 스폰 보호(RQ-16) 즉시 해제
        await sleep(SELF_FIRE_SETTLE_MS)

        const atDeath = await jumpAndObserveLanding(room, FATAL_OVERRIDE_PEAK_M)
        const deathAtMs = Date.now()

        // 핵심 회귀 단언 — 현재 구현은 diedAtTick.set이 handleFire(사격)
        // 한 곳뿐이라, 낙하로 죽으면 hp는 0이 되지만 diedAtTick이 갱신되지
        // 않아 stepPlayerMovement의 isRespawnDue 판정 대상이 되지 못하고
        // 영구 시신이 된다(원장 22e). 이 단언은 사망 자체를 먼저 확인한다.
        expect(atDeath.hp).toBe(0)
        // 평가 F2 회귀 가드 — 낙하는 환경 피해라 가해자가 없다. 자기
        // 자신을 포함해 그 누구의 킬 수도 늘어서는 안 된다(변이 M5: 자기
        // 자신을 가해자로 registerDeath에 전달 → 이 단언이 killed로 잡는다).
        expect(atDeath.kills).toBe(0)

        // RQ-15: 사망 후 3초 경과 시 리스폰(HP 100 복귀) — diedAtTick이
        // 실제로 갱신됐어야만 이 대기가 타임아웃 없이 resolve된다.
        const afterRespawn = await waitForPlayerCondition(
          room,
          room.sessionId,
          (p) => p.hp === PLAYER.MAX_HP,
          'RQ-18/GA-46: 낙하 사망 후 3초 경과 리스폰(HP 100 복귀) 대기 — diedAtTick이 갱신되지 않으면 영구 시신이 되어 타임아웃된다',
          RESPAWN_OBSERVE_TIMEOUT_MS,
        )
        const respawnElapsedMs = Date.now() - deathAtMs

        expect(afterRespawn.hp).toBe(PLAYER.MAX_HP)
        // 즉시 리스폰(0초 지연) 같은 결함을 놓치지 않는 실측 하한
        // (`rq-15-respawn-timer.test.ts`와 동일 근거).
        expect(respawnElapsedMs).toBeGreaterThanOrEqual(MIN_RESPAWN_ELAPSED_MS)
      } finally {
        await leaveRoom(room)
      }
    },
    30_000,
  )
})

describe('RQ-18 평가 기록 보강 — F1: 착지 전이 조건 고정(파일 상단 REV 절)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-18 회귀(평가 F1): 착지 데미지는 착지 전이 그 자체에서 반영된다 — "접지 유지 틱"이 없는 시나리오(버니합)에서도 무기한 보류되지 않는다',
    async () => {
      const client = newClient(server)
      const room = await joinGame(client)

      try {
        const baseline = await waitForPlayerCondition(room, room.sessionId, () => true, '초기 스냅샷', SNAPSHOT_TIMEOUT_MS)
        expect(baseline.hp).toBe(PLAYER.MAX_HP)

        room.send('fire', UP_MISS_AIM) // 최초 입장 스폰 보호(RQ-16) 즉시 해제
        await sleep(SELF_FIRE_SETTLE_MS)

        // jump:true를 보내고 이 케이스 안에서는 비활성화하지 않는다(파일
        // 상단 REV 절 "채택안" 참고) — `stepGrounded`가 매 틱 `input.jump`
        // 를 그대로 확인해 참이면 무조건 재이륙시키므로, 착지 즉시 다시
        // 이륙하는 버니합이 유지된다. 이 시나리오에는 "착지 전이가 아닌
        // 채로 접지 상태에 머무르는 틱"이 정의상 단 한 번도 없다.
        room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: true })

        await waitForPlayerCondition(
          room,
          room.sessionId,
          (p) => p.y > 0,
          'RQ-18/F1: 공중 상태(y>0) 관측 대기',
          AIRBORNE_OBSERVE_TIMEOUT_MS,
        )
        getServerRoom(room).fallPeakY.set(room.sessionId, NON_FATAL_OVERRIDE_PEAK_M)

        const expectedDamage = (NON_FATAL_OVERRIDE_PEAK_M - FALL_DAMAGE.SAFE_HEIGHT_M) * FALL_DAMAGE.DAMAGE_PER_METER

        // 핵심 단언 — 버니합을 유지한 채(jump 비활성화 전) 데미지 반영을
        // 기다린다. 착지 전이 조건이 뒤집히면(평가 M1 변이) 데미지 적용
        // 분기는 오직 "접지를 유지하는" 틱에서만 실행되는데 그런 틱이 이
        // 시나리오엔 없으므로 적용이 **무기한** 미뤄진다 — 아무리 기다려도
        // hp가 줄지 않아 타임아웃으로 드러난다(폴링 간격·패치 배치 타이밍에
        // 좌우되지 않는 결정론적 신호, 파일 상단 REV 절 "1차 시도" 참고).
        // 올바른 구현은 착지 전이 그 자체에서 동기적으로 적용하므로 버니합
        // 지속 여부와 무관하게 첫 비행 시간 안에 곧바로 줄어든다.
        const afterFirstLanding = await waitForPlayerCondition(
          room,
          room.sessionId,
          (p) => p.hp === PLAYER.MAX_HP - expectedDamage,
          'RQ-18/F1: 버니합 유지 중 첫 착지 데미지 반영 대기 — 착지 전이 조건이 뒤집히면(M1) "접지 유지 틱"이 정의상 오지 않아 데미지가 무기한 미뤄진다',
          LANDING_OBSERVE_TIMEOUT_MS,
        )
        expect(afterFirstLanding.hp).toBe(PLAYER.MAX_HP - expectedDamage)

        // 리뷰 minor 3 — 이 테스트의 M1 검출력이 의존하는 전제("버니합
        // 중에는 접지 유지 틱이 없다")를 직접 단언한다. jump 입력은 아직
        // 유지 중이므로(`finally`에서 비활성화하기 전) 첫 착지 데미지가
        // 반영된 뒤에도 곧바로 재이륙(y>0)해야 한다 — 그렇지 않다면(예:
        // 점프 쿨다운·연사 제한 도입) 전제가 깨진 것이고, 이 대기는
        // `AIRBORNE_OBSERVE_TIMEOUT_MS` 안에 타임아웃되어 "F1을 재설계하라"
        // 는 신호를 낸다(파일 상단 REV2 절 참고, 새 매직 넘버 없음 — 기존
        // 헬퍼·상수 재사용).
        await waitForPlayerCondition(
          room,
          room.sessionId,
          (p) => p.y > 0,
          'RQ-18/F1 전제 확인(리뷰 minor 3): 첫 착지 데미지 반영 이후에도 재이륙(버니합)이 유지된다',
          AIRBORNE_OBSERVE_TIMEOUT_MS,
        )
      } finally {
        // 정리 — 더 이상 재점프하지 않도록 명시적으로 비활성화한다.
        room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })
        await leaveRoom(room)
      }
    },
    20_000,
  )
})

describe('RQ-18 리뷰 보강(minor 5) — RQ-16 스폰 보호가 낙하 데미지에도 적용된다(파일 상단 REV2 절)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-18 회귀(리뷰 minor 5): 자기 사격으로 보호를 해제하지 않은 채(최초 입장 스폰 보호 유효) 치명적 낙하를 겪어도 HP가 전혀 줄지 않는다 — RQ-16 "모든 피해" 무효화 고정',
    async () => {
      const client = newClient(server)
      const room = await joinGame(client)

      try {
        const baseline = await waitForPlayerCondition(room, room.sessionId, () => true, '초기 스냅샷', SNAPSHOT_TIMEOUT_MS)
        expect(baseline.hp).toBe(PLAYER.MAX_HP)

        // 다른 케이스들과 달리 자기 사격을 보내지 않는다 — 최초 입장 스폰
        // 보호(RQ-16, PLAYER.SPAWN_PROTECTION_MS=3000ms)가 해제되지 않은
        // 채로 남아 있어야 이 케이스의 의미가 성립한다.
        const afterLanding = await jumpAndObserveLanding(room, FATAL_OVERRIDE_PEAK_M)

        // 핵심 회귀 단언 — 치명적 높이(FATAL_OVERRIDE_PEAK_M, GA-46과 동일
        // 값)를 주입했음에도 스폰 보호가 유효한 동안은 낙하 데미지를 포함한
        // "모든 피해"가 무효화돼야 한다(RQ-16 문면, 리뷰 쟁점 4·minor 5).
        // `trackFallDamage`가 스폰 보호 게이트를 건너뛰도록 바뀌면(리뷰가
        // 실증한 변이 M9와 동치) 이 단언만 실패한다 — 기존 3케이스는 전부
        // 점프 전 자기 사격으로 보호를 먼저 해제하므로 이 회귀를 잡지
        // 못했다.
        expect(afterLanding.hp).toBe(PLAYER.MAX_HP)
      } finally {
        await leaveRoom(room)
      }
    },
    20_000,
  )
})
