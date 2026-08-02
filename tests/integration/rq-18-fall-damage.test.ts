import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { FALL_DAMAGE, PLAYER } from '@shared/constants'
import { escapeSafeZone, releaseSpawnProtectionAndEscape, type SafeZoneEscapeSeam } from '../support/safe-zone'

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
 * 높이만 다르게 한다 — GA-44는 자연 최고점(1.0m)보다 작은 값(`SAFE_OVERRIDE_
 * PEAK_M=0.1m`, REV4)을 주입해 실제 물리 그대로의 낙차(≈1.0m)가 유지되고,
 * GA-45는 8m를 주입한다. 무피해가 "장치가 꺼져 있어서"가 아니라 "3m
 * 이하라서"임을 GA-45가 같은 절차에서 실제로 데미지가 드는 것으로 반증한다.
 * **주의**: GA-44 단독은 현재(미구현) 상태에서도 트리비얼하게 통과한다
 * (아무것도 안 하므로 HP도 안 바뀐다) — 이 GA의 Red 증거력은 GA-45와의
 * **짝**에서 나온다는 점을 평가자가 판단할 때 감안할 것(Red 실행 출력
 * 보고서에 명시).
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
 * 재이륙(y>0)이 관측돼야 한다. **이 구현은 REV3에서 CI 실패로 폐기·교체됐다
 * (아래 REV3 절 참고).**
 *
 * ## REV3(CI 실패 수정, 팀리드 지시, PR #24 run 30185861428)
 *
 * **증상**: GitHub Actions에서 통합 2건이 `[timeout 3000ms] RQ-18: 점프 후
 * 공중 상태(y>0) 관측 대기`로 실패했다(GA-46, 리뷰 보강 minor 5) — 로컬
 * 355 green과 불일치. `check.sh`는 이를 flaky 재시도 대상으로 보지 않고
 * 실제 결함으로 판정했다(옳은 판정).
 *
 * **원인 확정**: `GameRoom.startTickLoop`(`src/server/rooms/GameRoom.ts:
 * 580-594`)는 `setSimulationInterval` 콜백마다 `driver.advanceByElapsed
 * (deltaMs)`가 반환한 `advancedTicks`만큼 `stepPlayerMovement`를 **같은
 * 동기 for문 안에서** 반복 호출한다. `createTickDriver`
 * (`src/shared/sim/tickDriver.ts:76,111-116`)의 `maxTicksPerAdvance`
 * 기본값은 15(0.5초치) — 즉 콜백 자신이 지연되면(CI 러너의 GC·CPU 경합)
 * `deltaMs`가 커져 한 콜백이 최대 15틱(500ms)을 **한꺼번에** 처리할 수
 * 있다. 반면 Colyseus 패치는 별도 타이머(기본 50ms 주기, 리뷰 minor 6이
 * 이미 확인)로 나가므로, 이 동기 구간이 실행되는 동안에는 어떤 패치도
 * 나갈 수 없다 — 점프 궤적(약 19틱 ≈632ms)이 **두 패치 사이에서 통째로
 * 소비**되면 클라이언트는 `y>0`을 단 한 번도 보지 못한 채 바로 `y=0`
 * (착지)만 관측한다. 이전 `jumpAndObserveLanding`이 "y>0 관측 → 화이트박스
 * 주입" 순서였으므로, 이 경우 주입 자체가 영원히 일어나지 못해(공중 상태
 * 관측 대기가) 타임아웃됐다 — 리뷰 minor 6의 "12배 마진"은 패치 주기만
 * 고려했을 뿐 이 캐치업 경로를 고려하지 않았다.
 *
 * **재현(로컬)**: 이벤트 루프를 동기적으로 정지시키는(`Date.now()` 폴링
 * busy-wait) 진단 코드를 `jump: true` 전송 직후에 임시로 삽입해(같은
 * 프로세스이므로 서버 틱 콜백도 함께 막힌다) CI의 GC/CPU 경합을 모사했다
 * — 수정 전 코드에서 동일한 `[timeout ...] 점프 후 공중 상태(y>0) 관측
 * 대기`로 재현됨을 확인했다. 상세 수치는
 * `_workspace/RQ-18/05_test-writer_ci-fix.md` "부하 상황 모사 검증" 절.
 *
 * **수정**: 주입 시점을 공중 관측에서 분리한다 — `overridePeakM`을 점프
 * **전송 전**(접지 상태) 화이트박스로 심는다. `trackFallDamage`는 접지
 * 상태에서 매 틱 조기 반환하므로(`if (previous.grounded) return`,
 * `GameRoom.ts:463`) 미리 심은 값은 실제 이륙 때까지 그대로 보존되고,
 * 이후 `Math.max` 러닝 최댓값 규칙(실제 물리 최고점 <1.0m < 주입값)으로
 * 착지 전이까지 살아남는다 — **관측 여부와 결과가 무관해진다.** 착지
 * 판정도 `y===0`뿐 아니라 `fallPeakY`가 실제로 소비돼 사라졌는지까지
 * 함께 요구한다(`jumpAndObserveLanding` 최신 docblock 참고) — 둘 다 한번
 * 참이 되면 계속 참인 **안정 신호**라 캐치업에 영향받지 않는다. F1의
 * minor 3 전제 단언도 같은 이유로 취약해 **관측 의존을 제거**했다 — "y>0
 * 재관측" 대신, 1차 착지 직후 **다른 높이**(`SECOND_BOUNCE_OVERRIDE_
 * PEAK_M`)를 즉시 재주입하고 그 값이 소비돼 HP가 한 번 더 주는(안정 신호)
 * 것으로 버니합 지속을 확인한다 — 전제가 깨지면 이 값이 영원히 소비되지
 * 않아 여전히 타임아웃으로 신호를 낸다(삭제가 아니라 재설계).
 *
 * **전수 점검**: `jumpAndObserveLanding`을 공유하는 GA-44·GA-45·GA-46·
 * 리뷰 minor 5가 전부 이 취약점을 그대로 물려받고 있었다 — 헬퍼 하나만
 * 고치면 네 케이스가 한꺼번에 수정된다. F1은 헬퍼를 쓰지 않는 별도
 * 구현이라 위와 같이 개별 수정했다.
 *
 * 상세(부하 모사 수치, 반복 실행 안정성, minor 5 변이 재검증)는
 * `_workspace/RQ-18/05_test-writer_ci-fix.md` 참고.
 *
 * ## REV4(평가 델타2 W1 수정, `_workspace/RQ-18/06_evaluator_delta2.md` §3.2)
 *
 * REV3이 착지 판정을 "`fallPeakY` 소비 확인" 안정 신호로 바꿨지만, 이
 * 신호는 `overridePeakM`이 주어진 케이스에만 적용됐다. **GA-44는 이 파일의
 * 유일한 무주입 케이스**라 착지 술어가 `p.y === 0`으로 축약되는데, 이 값은
 * **점프 이전 접지 상태에서 이미 참**이다 — `waitForPlayerCondition`이
 * 구독 직전 동기 `tryResolve()`를 호출하므로(`waitForPlayerCondition` 정의
 * 참고), `jump:true` 전송 후 `y>0` 패치가 아직 도착하지 않은 시점이면 착지
 * 대기가 **점프가 실제로 처리되기도 전에** 즉시 resolve될 수 있었다 — 이후
 * `POST_LANDING_SETTLE_MS`(300ms) 뒤 HP를 읽으면 점프 시작 ~350ms 시점,
 * 즉 체공(632ms) 한복판이라 GA-44의 골든 `then`("착지 시 HP 불변")이 그
 * 실행에서 단언되지 않는다 — REV3이 스스로 세운 원칙("관측이 아니라 안정
 * 신호")을 GA-44에는 적용하지 못한 **REV3 자신의 회귀**였다(평가 실측:
 * 로컬 유휴 10회 중 1회, 715ms 공허 경로 vs 정상 경로 ≈1300ms).
 *
 * **수정**: `SAFE_OVERRIDE_PEAK_M`(0.1m, 자연 최고점 1.0m보다 작음)을 GA-44
 * 에도 주입한다(상수 docblock 참고) — `overridePeakM !== undefined`가 되어
 * REV3의 안정 신호가 GA-44에도 적용되고, 자연 최고점이 주입값을 `Math.max`
 * 로 이기므로 "실제 점프 물리 그대로"라는 GA-44의 성격도 보존된다.
 *
 * ## REV5(2차 CI 실패 수정, 팀리드 지시, PR #24 run 30188488491)
 *
 * **증상**: REV4 반영 이후 CI가 **다른 케이스, 다른 대기**에서 다시
 * 실패했다 — `[timeout 10000ms] RQ-18: 착지(y=0 복귀, 주입값 소비 확인)
 * 관측 대기`(리뷰 보강 minor 5). 로컬은 계속 355 green.
 *
 * **가설 두 갈래를 재현으로 좁혔다(추측으로 판정하지 않음)**:
 *
 * 1. **캐치업 재현(REV3와 동일 기법) — 재현 안 됨.** `Date.now()` 전역
 *    오프셋(+550ms, `jump:true` 전송 직후 주입)을 현재(REV4) 코드에 그대로
 *    적용해 10회 실행 — **10/10 통과**. REV3/4가 도입한 "안정 신호"(`fallPeakY`
 *    소비 확인)가 여전히 유효함을 재확인했다 — 캐치업은 더 이상 이 파일의
 *    실패 원인이 아니다.
 * 2. **입력 덮어쓰기 재현 — 재현됨, CI 메시지와 문자 단위 일치.**
 *    `jump:true`·`jump:false` 사이의 고정 50ms를 제거하고 두 메시지를
 *    간격 없이 연속 전송하도록 임시 수정 → **CI와 완전히 동일한 오류
 *    메시지**(`[timeout 10000ms] RQ-18: 착지(y=0 복귀, 주입값 소비 확인)
 *    관측 대기`)가 `jumpAndObserveLanding`을 공유하는 **GA-44·GA-45·GA-46·
 *    minor 5 전부**에서 재현됐다. `pendingInputs`는 엣지 트리거가 아니라
 *    "다음 메시지가 올 때까지 최근값 유지" 모델이므로(`GameRoom.ts:
 *    247-248`), 서버가 `jump:true`를 단 한 번도 읽지 못한 채 `jump:false`가
 *    먼저(또는 같은 틱 처리 구간에) 도착하면 `pendingInputs`에서 그대로
 *    덮어써져 **이륙 자체가 일어나지 않는다** — `y`는 계속 0, `fallPeakY`는
 *    영원히 소비되지 않아 착지 대기가 정확히 10초에서 타임아웃된다.
 *
 * **왜 minor 5가 먼저 걸렸는가(원인이 아니라 노출 조건)**: minor 5만 자기
 * 사격 워밍업(`fire` + `SELF_FIRE_SETTLE_MS`)이 없다(스폰 보호를 유지해야
 * 하므로 구조적으로 뺄 수 없다) — 즉 join 직후 **최소한의 실 소켓·룸
 * 활동 이력도 없이** 첫 `move` 메시지를 보낸다. 반면 GA-44/45/46은 자기
 * 사격 메시지가 이미 한 번 왕복해(300ms 여유) 소켓·처리 경로가 "검증된"
 * 상태에서 점프를 보낸다. 재현 2가 보여주듯 **취약점 자체는 헬퍼를 공유하는
 * 네 케이스 모두에 있다** — minor 5는 그 취약점을 가릴 워밍업이 없어 CI의
 * 타이트한 스케줄링에서 가장 먼저 걸렸을 뿐이다.
 *
 * **수정**: `jump:true`·`jump:false` 사이의 고정 50ms 대기를 "서버가 실제로
 * 이륙을 반영했다는 확인"으로 대체한다(`waitForServerTakeoff`) — 화이트박스로
 * 서버 권위 `moveStates`(RQ-20 때부터 있던 기존 private map, 신규 계약
 * 아님)를 직접 폴링해 `grounded===false`(공중)가 됐음을 확인한 **뒤에만**
 * `jump:false`를 보낸다. 확인 전에는 `jump:false`를 보내지 않으므로 덮어쓰기
 * 경로가 구조적으로 차단된다. 이 폴링은 REV3의 "1차 시도(폐기)"가 겪은
 * "정확히 그 틱을 잡아야 하는" 문제와 다르다 — 노리는 창이 단일 틱(≈33ms)이
 * 아니라 이륙~착지 전체 체공(≈632ms)이라 폴링 지터에 안전하다.
 *
 * **고려했으나 채택하지 않은 대안**:
 * - *화이트박스로 `pendingInputs`를 직접 써서 WS 왕복 자체를 우회*: 덮어쓰기
 *   경합은 사라지지만, 이 파일의 존재 이유(`verify`가 `tests/integration/...`
 *   를 못박는 골든 요구, "실 WebSocket으로 블랙박스 확인")를 훼손한다 —
 *   실제 게임 클라이언트가 쓰는 프로토콜 경로를 검증하지 않게 된다. 기각.
 * - *통합에서 룸 단위 화이트박스(더 낮은 레벨)로 전면 하향*: 이번 결함류
 *   (틱 캐치업·입력 덮어쓰기)를 구조적으로 전부 없애지만, ADR-0008이 이
 *   레벨을 "Colyseus 룸 경계 — join/leave, 상태 동기화, 메시지 왕복"으로
 *   명시했고 골든 GA-44~46의 `verify`가 이 파일을 직접 지정한다 — 레벨
 *   변경은 이 PR 범위를 넘는 스펙·ADR 재논의가 필요하다. 이번 결함은 헬퍼
 *   하나의 국소 수정으로 충분히 닫히므로(재현으로 확인) 지금 전면 하향할
 *   근거가 부족하다고 판단했다. 두 차례 연속 CI 실패가 반복되면 재고할
 *   신호로 기록해 둔다.
 *
 * 상세(부하 모사 반복 수치, 4곳 재점검 표)는
 * `_workspace/RQ-18/09_test-writer_ci-fix2.md` 참고.
 *
 * **REV(RQ-31 Safe Zone 회귀 대응, `_workspace/RQ-31/03_test-writer_regression
 * .md`)**: RQ-31 Safe Zone 배선(GA-19, `86fddf1`) 이후 최초 입장 스폰
 * 보호를 해제하는 자기 사격(`UP_MISS_AIM`)이 자신의 스폰 지점(Safe Zone
 * 내부, 거리 0)에서 나가 GA-19에 막힐 수 있다 — 화이트박스
 * (`FallDamageTestSeam.firedSinceSpawn`)로 대체했다. **이 시점에는**
 * `trackFallDamage`가 Safe Zone에 합류되지 않아(coder 결정, `_workspace/
 * RQ-31/02_coder_green.md` §2.4) 위치는 건드릴 필요가 없었다 — 아래
 * REV6이 그 전제를 뒤집는다.
 *
 * **REV6(Safe Zone·낙하 데미지 합류, 사용자 결정 2026-07-28, 커밋
 * `f028736`)**: 리뷰 blocker — RQ-16("그 플레이어가 받는 **모든** 피해를
 * 무효화")은 낙하를 포함하고 이미 그렇게 구현돼 있는데, RQ-31("받는
 * 피해", 한정어 없음)만 hitscan으로 좁혀 읽으면 "스폰 3.000초까지는
 * Safe Zone 안에서 낙하 무피해, 3.001초부터는 같은 자리에서 피해가 든다"는
 * 자기모순이 생긴다 — 어떤 스펙 문장도 그 비대칭을 규정하지 않았다.
 * 사용자 결정으로 `trackFallDamage`도 `handleFire`와 동일한 OR
 * 합성(RQ-16 시간 보호 OR RQ-31 위치 보호, 착지 시점 `moveStates` 기준
 * `isWithinSafeZone(next)`)에 합류했다(`GameRoom.ts` 참고). 이 파일의
 * 모든 케이스가 위치를 옮기지 않고 자기 스폰 지점(= 이제 Safe Zone)에서
 * 낙하·착지하므로, GA-45·GA-46·평가 F1 3건이 회귀했다(피해가 무효화돼
 * 기대 데미지가 적용되지 않는다) — `tests/support/safe-zone.ts`의
 * `releaseSpawnProtectionAndEscape`로 점프 **전에**(접지 상태, `fallPeakY`
 * 주입·`jump:true` 전송 이전) Safe Zone 밖으로 이동시켜 해결했다.
 * **순서가 중요하다**: `escapeSafeZone`이 내부적으로 `moveStates.set`을
 * 호출해 위치·속도·`grounded`를 덮어쓰므로, 이미 도약해 공중에 있는
 * 상태에서 부르면 진행 중인 낙하 물리(속도·`grounded`)가 리셋돼 버린다
 * — 그래서 반드시 접지 상태(점프 전송 전)에서만 호출한다. 이동은 순수
 * 위치 이동(`dirX:0, dirZ:0`인 수직 점프)뿐이라 착지 위치가 이륙
 * 위치와 사실상 같다 — 한 번의 탈출로 착지 시점 판정까지 안전하다.
 * GA-44·GA-25(3m)는 기대 데미지가 원래 0이라 이 회귀와 무관하게
 * 통과했지만, Safe Zone 무피해와 "안전 높이 이하라서 무피해"가 구분되지
 * 않는 공허화가 생기므로 같은 탈출을 추가해 강화했다(팀리드 지시) —
 * 단언(`PLAYER.MAX_HP`)은 그대로다. **"리뷰 보강(minor 5)" 케이스는
 * 이 시점에는 의도적으로 손대지 않았다** — 그 케이스의 존재 이유
 * 자체가 "자기 사격도, 위치 이동도 하지 않은 채 최초 입장 스폰
 * 보호(RQ-16, 시간 기반)만으로 낙하 데미지가 무효화되는가"이므로,
 * 탈출을 넣으면 검증 대상(RQ-16 시간 보호)이 사라진다고 (**잘못**)
 * 판단했다. **이 인과는 뒤집혀 있었다 — 아래 REV8이 바로잡는다.**
 *
 * **REV7(델타 재평가 blocker 대응)**: REV6까지의 수정은 전부 "Safe Zone
 * **밖**에서는 낙하 피해가 정상 적용된다"만 지킨다 — "Safe Zone **안**에서는
 * (RQ-16과 무관하게) 낙하 피해가 무효화된다"를 실제로 검사하는 케이스가
 * 없었다. 평가자가 격리 워크트리에서 `trackFallDamage`의 `|| isSafeZoneProtected`
 * 두 줄만 정확히 되돌려 확인했다 — **491건 전부 통과**했다. 즉 사용자
 * 결정으로 바뀐 그 동작이 코드 주석 한 단락으로만 지켜지고 있었다(리뷰
 * blocker가 지적한 "축소가 스펙이 아니라 소스 주석에만 산다"를 방향만
 * 바꿔 반복). 아래 "리뷰 보강(major, Safe Zone 그물)" `describe`가 이
 * 공백을 닫는다 — **위치를 옮기지 않고**(자기 스폰 지점=Safe Zone에
 * 그대로 둔 채) RQ-16을 화이트박스로 먼저 만료시킨(`firedSinceSpawn
 * =true`) 뒤 낙하시켜 무피해(`hp===MAX_HP`)를 확인한다 — 이렇게 RQ-16을
 * 먼저 만료시키지 않으면 "3초 무적 때문에 통과"하는 공허한 테스트가 된다(원장
 * 25f가 hitscan 축에 대해 이미 경고한 것과 정확히 같은 함정, 이번엔
 * 낙하 축). 이어서 **같은 세션에서 위치만** `escapeSafeZone`으로
 * 옮긴 뒤 동일 절차를 반복해 정상 데미지(50)가 드는 것을 양성
 * 대조군으로 확인한다 — 이게 없으면 첫 단언이 "장치가 꺼져서
 * 무피해"와 구분되지 않는다. 골든 신설(GA-11 `when` 확장 여부)은
 * 사용자 결정 대기 중이라 이번 라운드에서 만들지 않는다 — RQ-31
 * 문면 자체가 이미 피해원을 한정하지 않으므로 이 그물은 그 결정을
 * 기다릴 필요가 없다.
 *
 * **REV8(재리뷰 신규 blocker 대응)**: REV7이 닫은 공백(Safe Zone 축)을
 * 닫으면서 **다른 그물을 무너뜨렸다.** `trackFallDamage`에서 RQ-16
 * 항(`isSpawnTimeProtected`)만 제거해도(`isProtected = isSafeZoneProtected`)
 * 전체 스위트가 그대로 통과했다(리뷰어 MUT-F) — "리뷰 보강(minor 5)"
 * 케이스가 자기 스폰 지점(=Safe Zone)에 그대로 있으므로, RQ-16 항이
 * 있든 없든 `isSafeZoneProtected` 하나만으로 이미 무효화가 성립해
 * 결과가 같아졌기 때문이다. 그 케이스는 원래 **이전 라운드 리뷰
 * minor 5("RQ-16 가드 0건")가 지적해 신설된 회귀 테스트**였는데, REV6이
 * 이번 라운드 그 케이스를 "의도적으로 손대지 않는다"고 판단한 근거
 * (바로 위 문단)가 **인과가 뒤집혀 있었다** — 탈출을 넣으면 검증
 * 대상이 가려지는 게 아니라, **넣지 않아서** 이미 Safe Zone에 가려져
 * 있었다. 수정은 그 `it()`에 **`escapeSafeZone`만**(위치만 이동,
 * `releaseSpawnProtectionAndEscape`가 **아니다** — 그건 RQ-16 자체를
 * 꺼 버려 검증 대상을 통째로 없앤다) 추가해 Safe Zone을 미리 제거하고
 * RQ-16(시간 보호, 자기 사격을 안 보내므로 여전히 유효)만 남긴다 —
 * 이후 관측되는 무피해는 RQ-16 **단독**의 결과가 된다(그 `it()`
 * 본문의 실측 확인 코멘트 참고).
 *
 * **REV9(팀리드 지시, 사용자 결정 — 원장 22f `pendingInputs` 수정 이후
 * F1 재설계)**: 원장 22f가 `GameRoom.ts`의 `pendingInputs.jump`를 엣지
 * 트리거로 고쳤다 — 새 `'move'` 입력의 `jump`를 직전 값과 OR(합집합)한
 * 뒤, `stepPlayerMovement`가 그 값을 실제로 소비한 **직후 다시 `false`로
 * 되돌린다**(`tests/integration/22f-jump-input-loss.test.ts`가 이 계약을
 * 고정한다). 그 결과 F1이 빌려 쓰던 재현 기법 — "`jump:true`를 한 번만
 * 보내고 다시는 `jump:false`를 보내지 않으면 `pendingInputs`에 그 값이
 * 영원히 남아 매 착지마다 자동으로 재이륙한다" — 가 더 이상 성립하지
 * 않는다. 위 REV3 절의 F1 코멘트(원본 936~939행)가 정확히 이 상황을
 * 예견해 문서화해 뒀다: "전제가 깨지면(점프 쿨다운 등 도입으로 재이륙이
 * 멈추면) 이 값은 영원히 소비되지 않고 이 대기가 타임아웃돼 'F1을
 * 재설계하라'는 신호를 낸다." 그 신호가 실제로 왔다 — 22f 수정 이후 F1만
 * 두 번째 착지 대기에서 타임아웃으로 실패했다(다른 GA-44~46·리뷰 보강
 * 케이스는 전부 그대로 통과 — 22f는 연속값(dirX·dirZ·mode)의 "마지막 값"
 * 규칙은 바꾸지 않았고 엣지 비트(jump)만 바꿨으므로, 매 틱 새 입력을
 * 보내는 다른 시나리오에는 영향이 없다).
 *
 * **재설계**: `jump:true`를 한 번만 보내는 대신, 실 클라이언트가 점프
 * 키를 누르고 있는 동안 매 틱 입력을 보내는 것(`PlayerControls.tsx`가
 * 30Hz로 입력을 계속 보낸다는 것은 RQ-43 관련 기존 코멘트에도 이미
 * 나온다)과 동일하게 `startJumpHold()`(아래)로 `jump:true`를 계속
 * 재전송한다.
 *
 * **1차 시도(폐기) — 실시간 간격(`setInterval`) 재전송**: 서버 틱
 * (`NET.TICK_MS`≈33.3ms)의 1/4(≈8.3ms) 간격으로
 * `rq-62-input-sequence-authority.test.ts`의 "리뷰 blocker 재현" 절이 이미
 * 8ms(같은 33ms 틱 대비)로 검증해 둔 자릿수를 그대로 재사용해 재전송했으나,
 * **격리 워크트리 M1 변이 실험에서 재설계한 F1이 그대로 통과해 버렸다**
 * (1차 착지가 예상 1.3초 대신 3.2초 만에 이뤄짐 — "접지 유지 틱"이 실제로
 * 발생해 M1의 지연 경로가 열렸다는 뜻, 검출력 상실). 원인: `pendingInputs`의
 * 리셋(원장 22f 수정)은 `stepPlayerMovement`가 그 값을 실제로 착지·이륙에
 * 썼는지와 무관하게 **매 틱** 무조건 실행된다(공중 물리 `stepAirborne`은
 * `input.jump`를 아예 읽지 않는데도 리셋은 그대로 일어난다) — 즉 체공
 * (≈19틱) 내내 "그 틱 직전에 새 메시지가 도착해 있어야" 살아남는 값이라,
 * 착지 전이 그 틱 하나만 이기면 되는 게 아니라 **모든 개별 틱**에서
 * 이겨야 하는 경합이다. Windows 타이머 해상도(`rq-62` 실측 ~15.6ms)에
 * 걸려 실제 재전송 간격이 늘어난 데다, 이 재전송 타이머와 서버 자신의
 * 30Hz 틱 타이머가 서로 다른 위상으로 독립 표류해(33.3ms:8.3ms, 정수
 * 비율이 아니다) 주기적으로 "막 놓치는" 위상이 찾아온다 — 실시간 타이머
 * 두 개를 경주시키는 방식 자체가 구조적으로 신뢰할 수 없었다.
 *
 * **채택안 — `setImmediate` 이벤트 루프 반복 재전송**: 실시간 간격 대신
 * Node 이벤트 루프의 매 반복(iteration)마다 재전송한다(아래
 * `startJumpHold` 코멘트 참고). 이 통합 테스트는 서버·클라이언트가 한
 * 프로세스 안에서 돌므로, 이벤트 루프가 막히지 않는 한 한 틱 구간
 * (≈33ms) 안에 이 루프가 여러 차례 돌며 그때마다 새 `jump:true`를 보내
 * 실시간 타이머 두 개의 독립 표류에 기대지 않고 훨씬 촘촘하게 창을
 * 메운다 — 착지 즉시 다음 틱에 다시 이륙해 "접지를 유지하는 틱"이
 * 정의상 오지 않는다는 F1의 핵심 전제가 보존된다(아래 "검증" 절이 이
 * 채택안으로 M1 검출력을 재확인한 실측이다).
 *
 * **보존한 것(팀리드 지시 그대로, 이 재설계의 합격 기준)**: 1차·2차
 * 착지 데미지 단언(`expectedDamage`·`secondExpectedDamage`, `hp ===
 * PLAYER.MAX_HP - expectedDamage`/`- secondExpectedDamage`)은 값·의미
 * 모두 손대지 않았다 — 바뀐 것은 오직 "매 틱 `jump:true`를 유지하는
 * 방법"뿐이다.
 *
 * **검증(M1 검출력 실증, 격리 워크트리)**: `harness/workflow/tdd.md`
 * Phase 3 규약대로 `git worktree add --detach`로 격리한 워크트리에서 (1)
 * 원장 22f 수정(이 재설계 시점에 메인 트리에 아직 미커밋 상태였던
 * `src/server/rooms/GameRoom.ts`의 실제 diff를 패치로 반영)만 적용한
 * 상태로 재설계한 F1을 실행 → 통과(1차·2차 단언 모두 그대로). (2) 그 위에
 * M1 변이(`trackFallDamage`의 `if (previous.grounded) return`을 `if
 * (!previous.grounded) return`으로 반전)를 추가로 심고 재실행 → 재설계한
 * F1이 **타임아웃으로 실패**했다(다른 GA-44~46 케이스는 여전히 통과 —
 * 파일 상단 "1차 시도" 절이 이미 기록한 것과 동일하게, 최종 합산 HP가
 * 지연될 뿐 결국 같은 값으로 수렴하는 다른 케이스들은 이 변이를 구분하지
 * 못한다). 전문(양쪽 실행 출력 전부)은
 * `_workspace/22f/01b_test-writer_f1-redesign.md` "M1 변이 실험" 절 참고 —
 * 재설계가 M1 검출력을 잃지 않았음을 실측으로 확인했다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const SNAPSHOT_TIMEOUT_MS = 5_000
/** 착지(y가 0으로 복귀) 관측 상한. 실제 중력 값은 구현 자유(`sim-movement
 * .test.ts` "점프 궤적 유도" 참고 — 실측: 매우 완만한 g=0.5조차 약 170틱
 * ≈5.7초)라 넉넉하게 잡는다 — `rq-15-respawn-timer.test.ts`의
 * `RESPAWN_OBSERVE_TIMEOUT_MS`(8000ms)와 동일한 여유 원칙. */
const LANDING_OBSERVE_TIMEOUT_MS = 10_000
/** REV5 — `jump:true` 전송 뒤 서버가 실제로 이를 반영(이륙)했는지 확인하는
 * 상한. `LANDING_OBSERVE_TIMEOUT_MS`의 절반 — 이 확인이 실패한다면 착지
 * 자체를 기다리는 것보다 훨씬 이전 단계(입력 반영 자체)의 결함이므로
 * 더 짧게 잡아도 무방하나, CI 부하를 넉넉히 흡수하도록 보수적으로 크게
 * 뒀다. */
const TAKEOFF_CONFIRM_TIMEOUT_MS = 5_000
/** REV5 — 서버 권위 상태(화이트박스) 폴링 간격. 이 폴링이 노리는 창은
 * 단일 틱(≈33ms)이 아니라 이륙~착지 전체 체공(≈632ms)이므로(REV3 절
 * "1차 시도(폐기)"가 겪은 "정확히 그 틱을 잡아야 하는" 좁은 창 문제와
 * 다르다), 15ms 간격이면 그 창 안에 여러 번 샘플링할 여유가 충분하다. */
const TAKEOFF_POLL_INTERVAL_MS = 15
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
/** F1의 2차 바운스(REV3, 리뷰 minor 3 전제 재검증용) — `NON_FATAL_OVERRIDE_
 * PEAK_M`(8m)과 다른 값을 써서 1차·2차 데미지가 우연히 같은 값으로
 * 상쇄·오인되지 않게 한다. (5-3)×10=20 — 1차(50)와 합산해도
 * 100-50-20=30>0이라 사망(GA-46 경로)을 유발하지 않는다(HP>0 유지). */
const SECOND_BOUNCE_OVERRIDE_PEAK_M = 5
/** GA-44(REV4, 평가 델타2 W1 수정) — 자연 최고점(`MOVEMENT.JUMP_HEIGHT`
 * =1.0m)보다 **작은** 값을 점프 **전에** 주입한다. `trackFallDamage`의
 * 러닝 최댓값 규칙(`Math.max(기존값, next.y)`)이 실제 물리 최고점을 그대로
 * 이기므로(1.0m > 이 값) "실제 점프 물리 그대로"라는 GA-44의 성격은
 * 보존되고 착지 낙차·기대 데미지 0도 그대로다 — 동시에
 * `overridePeakM !== undefined`가 되어 `jumpAndObserveLanding`의 착지
 * 안정 신호("`fallPeakY` 소비 확인")가 GA-44에도 적용된다. 이 상수를
 * 주입하지 않으면(이전 실수) 착지 술어가 `p.y === 0` 하나로 축약돼
 * "점프 전 접지 상태"에서 이미 참이므로 `waitForPlayerCondition`의
 * 구독 전 동기 `tryResolve()`가 **점프가 실제로 처리되기 전에** 즉시
 * resolve될 수 있었다 — 로컬 유휴 10회 중 1회 실측(체공 632ms 한복판인
 * 715ms 지점에서 HP를 읽음). `FALL_DAMAGE.SAFE_HEIGHT_M`(3)을 대신 주입하는
 * 대안은 채택하지 않는다 — 경계 포함 규칙까지 같이 고정되지만 실제 물리
 * 최고점(1.0m)을 덮어써 "실제 점프"라는 GA-44의 성격을 잃는다. */
const SAFE_OVERRIDE_PEAK_M = 0.1

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

/** 화이트박스 접근 대상 계약 — 파일 상단 "그린필드 계약" 절 참고.
 * `fallPeakY`는 아직 존재하지 않는 신규 필드다(Red 전제). `moveStates`·
 * `positionHistory`·`firedSinceSpawn`은 `tests/support/safe-zone.ts`의
 * `SafeZoneEscapeSeam`을 상속해 얻는다(신규 계약 아님 — `moveStates`는
 * `GameRoom.ts:166`에 RQ-20 때부터 있던 기존 private map을 노출할 뿐이다).
 * REV6(파일 상단) — `trackFallDamage`가 이제 Safe Zone에도 합류하므로,
 * 이 파일도 다른 20개 통합 테스트와 동일하게 `escapeSafeZone`(공용
 * 헬퍼)로 위치를 옮겨야 한다. */
interface FallDamageTestSeam extends SafeZoneEscapeSeam {
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
 * `jump:true` 전송 뒤, 서버가 그 입력을 **실제로 반영**했는지를 화이트박스로
 * 직접 확인한다(REV5 — 파일 상단 REV5 절 참고). `pendingInputs`는
 * "다음 메시지가 올 때까지 최근값 유지" 모델(`GameRoom.ts:247-248`)이라
 * 엣지 트리거가 아니다 — 서버가 `jump:true`를 단 한 번도 읽지 못한 채
 * `jump:false`가 먼저 도착하면 `pendingInputs`에서 그대로 덮어써져 이륙
 * 자체가 일어나지 않는다. 이 함수가 반환할 때까지 `jump:false`를 보내지
 * 않으면 이 경로가 구조적으로 차단된다.
 *
 * 확인 조건은 "현재 공중"(`moveStates.get(sessionId).grounded === false`)
 * **또는**(주입이 있었다면) "이미 착지·소비까지 끝남"(`fallPeakY` 소비
 * 확인)이다 — 후자를 OR로 두는 이유: 이 폴링이 캐치업으로 밀린 여러 틱
 * 사이에서 우연히 "공중" 구간을 못 잡더라도(이론상 가능하나, 아래 참고),
 * "이미 착지까지 끝났다"는 것 자체가 "이륙이 실제로 있었다"는 더 강한
 * 증거이므로 여전히 유효한 확인이다.
 *
 * 이 폴링이 노리는 창은 단일 틱(≈33ms)이 아니라 이륙~착지 전체
 * 체공(≈632ms)이다 — REV3 절 "1차 시도(폐기)"가 폐기했던 "정확히 그 틱을
 * 잡아야 하는" 폴링과는 성격이 다르다(그 폴링은 착지 **순간**이라는 단일
 * 틱을 노렸다). 또한 클라 패치가 아니라 서버 프로세스 안의 살아있는 참조를
 * 직접 읽으므로 패치 배치·유실과 무관하다.
 */
function waitForServerTakeoff(room: Room, sessionId: string, overridePeakM: number | undefined, timeoutMs: number): Promise<void> {
  const seam = getServerRoom(room)
  const isConfirmed = (): boolean => {
    const airborne = seam.moveStates.get(sessionId)?.grounded === false
    const alreadyLandedAndConsumed = overridePeakM !== undefined && seam.fallPeakY.get(sessionId) === undefined
    return airborne || alreadyLandedAndConsumed
  }
  return new Promise<void>((resolve, reject) => {
    if (isConfirmed()) {
      resolve()
      return
    }
    const interval = setInterval(() => {
      if (isConfirmed()) {
        clearInterval(interval)
        clearTimeout(timeout)
        resolve()
      }
    }, TAKEOFF_POLL_INTERVAL_MS)
    const timeout = setTimeout(() => {
      clearInterval(interval)
      reject(new Error(`[timeout ${timeoutMs}ms] RQ-18: 서버 권위 상태로 이륙 반영 확인 대기(입력 덮어쓰기 방지)`))
    }, timeoutMs)
  })
}

/**
 * 실제 점프를 1회 실행하고, (선택적으로) 화이트박스로 낙하 시작 높이를
 * 주입한 뒤, 착지까지 관측한다 — GA-44·GA-45·GA-46·리뷰 minor 5가
 * **동일한 절차**를 공유한다(공허화 방지, 파일 상단 "양성 대조군 설계"
 * 참고).
 *
 * **REV3(CI 실패 수정 — 파일 상단 REV3 절 참고)**: 주입 시점을 "공중 상태
 * 관측 후"에서 "점프 전송 전"으로 옮겼다. 착지 판정도 "y===0 관측"뿐 아니라
 * "주입한 `fallPeakY`가 실제로 소비돼 사라졌는가"를 함께 요구한다 — 둘 다
 * **한번 참이 되면 계속 참으로 유지되는 안정 상태**라, CI의 틱 캐치업
 * (여러 틱이 패치 사이에서 한꺼번에 처리돼 중간 상태가 클라이언트에
 * 보이지 않는 현상)에 영향받지 않는다.
 *
 * **REV5(2차 CI 실패 수정 — 파일 상단 REV5 절 참고)**: `jump:true`와
 * `jump:false` 사이의 고정 50ms 대기를 걷어내고, `waitForServerTakeoff`로
 * **서버가 실제로 이륙을 반영했다는 확인**을 받은 뒤에만 `jump:false`를
 * 보낸다 — 확인 전에 보내면 두 메시지가 `pendingInputs`에서 겹쳐 이륙
 * 자체가 통째로 사라질 수 있었다(REV5 절 재현 참고).
 *
 * 1. `overridePeakM`이 주어지면 점프를 보내기 **전에** 화이트박스로
 *    `fallPeakY`를 심는다. 접지 상태에서는 `trackFallDamage`가 매 틱
 *    조기 반환하므로(`previous.grounded` 분기, `GameRoom.ts:463`) 이
 *    시점에 심은 값은 실제로 이륙할 때까지 그대로 보존된다 — 공중 상태를
 *    관측할 때까지 기다릴 필요가 없다.
 * 2. `jump: true`를 보낸다. `jump`는 엣지 트리거가 아니라 "다음 메시지가
 *    올 때까지 최근값 유지" 모델이므로(`@shared/sim/movement`·
 *    `GameRoom.ts:247-248`), 유지하면 착지 직후 다시 점프해 버린다(끝없는
 *    버니합) — 그래서 이륙 확인 뒤 `jump: false`로 되돌린다(아래 4).
 * 3. `waitForServerTakeoff`로 서버가 이 입력을 실제로 반영했음을(화이트박스,
 *    서버 권위 상태 직접 폴링) 확인한다.
 * 4. 확인 후에만 `jump: false`(유지 입력)를 보낸다 — 착지 후 재이륙(원치
 *    않는 버니합)을 막는다.
 * 5. 이륙 후 실제 물리가 계산하는 높이(최고 1.0m 미만)는 항상 주입값보다
 *    작으므로 `Math.max` 갱신에서 주입값이 그대로 살아남는다(그린필드
 *    계약의 러닝 최댓값 규칙) — 공중 구간을 클라이언트가 실제로
 *    관측하든 못하든(패치 배치·틱 캐치업) 이후 결과는 같다.
 * 6. 착지를 `p.y === 0` **그리고**(주입이 있었다면) `fallPeakY`가 소비돼
 *    사라졌음(`fallPeakY.get(sessionId) === undefined`)으로 판정한다 —
 *    착지 전이가 실제로 일어나야만 삭제되는 값이라(`GameRoom.ts:484`),
 *    아직 이륙조차 하지 않은 접지 기준 상태(y===0)에 허위로 매칭될 수
 *    없다. `POST_LANDING_SETTLE_MS`만큼 더 기다렸다가 최종 상태를 읽는다.
 */
async function jumpAndObserveLanding(room: Room, overridePeakM?: number): Promise<PlayerSnapshot> {
  const sessionId = room.sessionId

  if (overridePeakM !== undefined) {
    getServerRoom(room).fallPeakY.set(sessionId, overridePeakM)
  }

  room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: true })
  await waitForServerTakeoff(room, sessionId, overridePeakM, TAKEOFF_CONFIRM_TIMEOUT_MS)
  room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })

  const landed = await waitForPlayerCondition(
    room,
    sessionId,
    (p) => p.y === 0 && (overridePeakM === undefined || getServerRoom(room).fallPeakY.get(sessionId) === undefined),
    'RQ-18: 착지(y=0 복귀, 주입값 소비 확인) 관측 대기',
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

        // RQ-31 회귀 대응(REV6) — RQ-16 해제 + Safe Zone 탈출을 한 호출로
        // 묶는다. 점프 전(접지 상태, 아래 fallPeakY 주입·jump 전송보다
        // 먼저)에 반드시 해야 한다 — escapeSafeZone이 moveStates.set으로
        // 위치·속도·grounded를 덮어쓰므로, 이미 공중에 있을 때 부르면
        // 낙하 물리가 리셋된다(파일 상단 REV6 참고).
        releaseSpawnProtectionAndEscape(getServerRoom(room), room.sessionId, baseline)

        // REV4(평가 델타2 W1 수정) — SAFE_OVERRIDE_PEAK_M(0.1m, 자연 최고점
        // 1.0m보다 작음)을 주입한다. "실제 점프 물리 그대로(최고점 < 3m)"라는
        // 성격은 그대로 유지하면서(주입값이 실제 물리를 이기지 못한다),
        // 착지 안정 신호(`fallPeakY` 소비 확인)를 GA-44에도 적용해 "점프가
        // 실제로 일어나기 전에 착지 대기가 허위로 resolve"되는 경로를
        // 차단한다(상수 docblock 참고).
        const afterLanding = await jumpAndObserveLanding(room, SAFE_OVERRIDE_PEAK_M)

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

        // RQ-31 회귀 대응(REV6) — RQ-16 해제 + Safe Zone 탈출을 한 호출로
        // 묶는다. 점프 전(접지 상태)에 반드시 해야 한다(파일 상단 REV6
        // 참고).
        releaseSpawnProtectionAndEscape(getServerRoom(room), room.sessionId, baseline)

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

        // RQ-31 회귀 대응(REV6) — RQ-16 해제 + Safe Zone 탈출을 한 호출로
        // 묶는다. 점프 전(접지 상태)에 반드시 해야 한다(파일 상단 REV6
        // 참고).
        releaseSpawnProtectionAndEscape(getServerRoom(room), room.sessionId, baseline)

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

/**
 * REV9(F1 재설계) — 버니합을 유지하려면 실 클라이언트가 점프 키를
 * 누르고 있는 동안 매 틱 입력을 다시 보내는 것과 동일하게 `jump:true`를
 * 계속 재전송해야 한다. 원장 22f 수정 이후 `pendingInputs.jump`는
 * `stepPlayerMovement`가 그 값을 실제로 착지·이륙에 썼는지와 무관하게
 * **매 틱** 소비 즉시 `false`로 되돌린다(`GameRoom.ts` "원장 22f 수정" 절
 * — 공중 물리(`stepAirborne`)는 `input.jump`를 아예 읽지 않는데도 리셋은
 * 무조건 실행된다). 즉 체공(≈19틱) 내내 매 틱 이 리셋이 반복되므로, 착지
 * 전이 틱에 `jump`가 살아있으려면 **그 틱 직전에도** 새 메시지가 도착해
 * 있어야 한다 — "한동안 유지"가 아니라 "매 틱마다 새로 이겨야 하는 경합"
 * 이라는 뜻이다.
 *
 * **1차 시도(폐기) — `setInterval(8.3ms)` 실측 실패**: 서버 틱의 1/4
 * 간격으로 재전송했으나, 격리 워크트리 M1 변이 실험에서 **재설계한 F1이
 * 그대로 통과해 버렸다**(1차 착지가 1.3초 대신 3.2초 만에 이뤄짐 — 접지
 * 유지 틱이 실제로 발생해 M1의 지연 경로가 열렸다는 뜻). 원인: Windows
 * 타이머 해상도(`rq-62-input-sequence-authority.test.ts` 실측 ~15.6ms)에
 * 걸려 실제 재전송 간격이 늘어난 데다, 이 재전송 타이머와 서버 자신의
 * 30Hz 틱 타이머가 **서로 다른 위상으로 독립 표류**해 두 틱 길이의
 * 비정수 비율(33.3ms:8.3ms) 때문에 주기적으로 "막 놓치는" 위상이
 * 찾아온다 — 실시간 타이머 두 개를 경주시키는 방식 자체가 구조적으로
 * 신뢰할 수 없었다(전문은 `_workspace/22f/01b_test-writer_f1-redesign.md`
 * "1차 시도(폐기)" 절).
 *
 * **채택안 — `setImmediate` 루프**: 실시간 간격 대신 Node 이벤트 루프의
 * 매 반복(iteration)마다 재전송한다. 서버의 틱 콜백도 같은 프로세스의
 * 같은 이벤트 루프에서 실행되므로(이 통합 테스트는 서버·클라이언트가
 * 한 프로세스 안에서 돈다), 이벤트 루프가 막히지 않는 한 한 틱 구간
 * (≈33ms) 안에 이 루프가 여러 차례 돌며 그때마다 새 `jump:true`를 보낸다
 * — 실시간 타이머 두 개의 독립 표류에 기대지 않으므로 훨씬 촘촘하고
 * 안정적으로 창을 메운다(같은 격리 워크트리에서 M1 변이 실험으로 실측
 * 재확인 — 아래 REV9 절·`01b_test-writer_f1-redesign.md` 참고).
 *
 * 반환하는 함수를 호출하면 재전송을 멈춘다 — 호출자가 `finally`에서
 * 정지시키고 명시적으로 `jump:false`를 보내야 한다(그러지 않으면 다음
 * 테스트로 넘어간 뒤에도 이 세션이 살아있는 한 계속 재전송된다 — 이
 * 파일에서는 `leaveRoom` 전에 반드시 멈춘다).
 */
function startJumpHold(room: Room): () => void {
  let active = true
  const pump = (): void => {
    if (!active) return
    room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: true })
    setImmediate(pump)
  }
  pump()
  return () => {
    active = false
  }
}

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
      // REV9: try 블록 안에서 대입하지만 finally에서도 멈춰야 하므로 try
      // 바깥(블록 스코프 밖)에 선언한다 — `room`과 동일한 이유.
      let stopHold: (() => void) | undefined

      try {
        const baseline = await waitForPlayerCondition(room, room.sessionId, () => true, '초기 스냅샷', SNAPSHOT_TIMEOUT_MS)
        expect(baseline.hp).toBe(PLAYER.MAX_HP)

        // RQ-31 회귀 대응(REV6) — RQ-16 해제 + Safe Zone 탈출을 한 호출로
        // 묶는다. 아래 fallPeakY 주입·jump 전송보다 반드시 먼저(접지
        // 상태에서)여야 한다 — escapeSafeZone이 moveStates.set으로 위치를
        // 덮어쓰므로, 나중에 부르면 진행 중인 낙하 물리가 리셋된다(파일
        // 상단 REV6 참고).
        releaseSpawnProtectionAndEscape(getServerRoom(room), room.sessionId, baseline)

        // REV3(CI 수정) — 주입을 점프 전송 전으로 옮긴다(`jumpAndObserveLanding`
        // REV3 절과 동일 근거). 접지 상태에서는 trackFallDamage가 매 틱
        // 조기 반환하므로(`previous.grounded` 분기) 이 시점에 심은 값이
        // 이륙 때까지 그대로 보존된다.
        getServerRoom(room).fallPeakY.set(room.sessionId, NON_FATAL_OVERRIDE_PEAK_M)

        // REV9(F1 재설계) — `jump:true`를 한 번만 보내는 것이 아니라
        // `startJumpHold()`로 계속 재전송한다(파일 상단 REV9 절, 위
        // `startJumpHold` 코멘트 참고) — `stepGrounded`가 매 틱
        // `input.jump`를 그대로 확인해 참이면 무조건 재이륙시키므로,
        // 착지 즉시 다시 이륙하는 버니합이 유지된다. 이 시나리오에는
        // "착지 전이가 아닌 채로 접지 상태에 머무르는 틱"이 정의상 단
        // 한 번도 없다 — `finally`에서 `stopHold()`로 멈출 때까지.
        stopHold = startJumpHold(room)

        const expectedDamage = (NON_FATAL_OVERRIDE_PEAK_M - FALL_DAMAGE.SAFE_HEIGHT_M) * FALL_DAMAGE.DAMAGE_PER_METER

        // 핵심 단언 — 버니합을 유지한 채(stopHold() 호출 전) 데미지 반영을
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

        // 리뷰 minor 3(REV3 재수정, 파일 상단 REV3 절 참고) — 이 테스트의
        // M1 검출력이 의존하는 전제("버니합 중에는 접지 유지 틱이 없다")를
        // "y>0 관측"이 아니라 **2차 낙하의 안정 신호**로 재확인한다. y>0
        // 관측은 CI 실패의 근본 원인과 정확히 같은 취약점(틱 캐치업으로
        // 중간 공중 상태가 관측되지 않을 수 있음)을 그대로 물려받으므로
        // 폐기했다. 대신 1차 착지 직후 **1차와 다른 높이**
        // (`SECOND_BOUNCE_OVERRIDE_PEAK_M` — 데미지가 우연히 상쇄·오인되지
        // 않도록)를 즉시 주입한다. jump는 아직 유지 중이므로, 전제가
        // 참이면(버니합이 계속된다면) 다음 접지→공중→착지 전이가
        // **언제 처리되든**(캐치업으로 여러 틱이 한꺼번에 처리돼도) 이
        // 값을 소비해 HP가 한 번 더 준다 — 착지 전이가 실제로 일어나야만
        // 삭제되는 값이므로(`GameRoom.ts:484`), 중간 공중 상태를 관측하지
        // 못해도 무관하다(1차 착지 확인과 동일한 안정-신호 메커니즘). 전제가
        // 깨지면(점프 쿨다운 등 도입으로 재이륙이 멈추면) 이 값은 영원히
        // 소비되지 않고 이 대기가 타임아웃돼 "F1을 재설계하라"는 신호를
        // 낸다.
        getServerRoom(room).fallPeakY.set(room.sessionId, SECOND_BOUNCE_OVERRIDE_PEAK_M)
        const secondExpectedDamage = (SECOND_BOUNCE_OVERRIDE_PEAK_M - FALL_DAMAGE.SAFE_HEIGHT_M) * FALL_DAMAGE.DAMAGE_PER_METER

        const afterSecondLanding = await waitForPlayerCondition(
          room,
          room.sessionId,
          (p) => p.hp === PLAYER.MAX_HP - expectedDamage - secondExpectedDamage,
          'RQ-18/F1 전제 확인(리뷰 minor 3, REV3): 첫 착지 데미지 이후에도 버니합이 유지돼 2차 주입값이 소비된다 — 소비되지 않으면(전제 붕괴) 타임아웃',
          LANDING_OBSERVE_TIMEOUT_MS,
        )
        expect(afterSecondLanding.hp).toBe(PLAYER.MAX_HP - expectedDamage - secondExpectedDamage)
      } finally {
        // 정리 — REV9: 재전송을 먼저 멈춘 뒤(그러지 않으면 아래 jump:false가
        // 다음 재전송의 jump:true에 다시 OR로 덮여 살아난다) 명시적으로
        // 비활성화한다. stopHold는 try 블록 초반(재전송 시작 직후)에만
        // 대입되므로, try 블록이 그 대입 이전에 던지는 극단적인 경우를
        // 대비해 optional call로 방어한다.
        stopHold?.()
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

        // 재리뷰 blocker 대응(파일 상단 REV8 참고) — **위치만** Safe Zone
        // 밖으로 옮긴다. `releaseSpawnProtectionAndEscape`가 **아니다** —
        // 그건 firedSinceSpawn까지 해제해 이 케이스가 검증하려는 RQ-16을
        // 꺼 버린다. RQ-16(시간 보호)은 자기 사격을 보내지 않으므로
        // (아래) 여전히 유효한 채로 남는다 — 이 escape 한 줄이 Safe
        // Zone(위치 보호)이라는 두 번째 무효화 경로를 미리 제거해, 이후
        // 관측되는 무피해가 RQ-16 **단독**의 결과임을 보장한다.
        escapeSafeZone(getServerRoom(room), room.sessionId, baseline)

        // 다른 케이스들과 달리 자기 사격을 보내지 않는다 — 최초 입장 스폰
        // 보호(RQ-16, PLAYER.SPAWN_PROTECTION_MS=3000ms)가 해제되지 않은
        // 채로 남아 있어야 이 케이스의 의미가 성립한다.
        const afterLanding = await jumpAndObserveLanding(room, FATAL_OVERRIDE_PEAK_M)

        // 핵심 회귀 단언 — 치명적 높이(FATAL_OVERRIDE_PEAK_M, GA-46과 동일
        // 값)를 주입했음에도 스폰 보호가 유효한 동안은 낙하 데미지를 포함한
        // "모든 피해"가 무효화돼야 한다(RQ-16 문면, 리뷰 쟁점 4·minor 5).
        // **실측 확인(재리뷰 blocker, MUT-F)**: `trackFallDamage`의
        // `isProtected`에서 RQ-16 항(`isSpawnTimeProtected`)만 제거하면
        // (`isProtected = isSafeZoneProtected`) 이 단언이 실제로 죽는다 —
        // 위에서 이미 Safe Zone을 탈출했으므로 `isSafeZoneProtected`는
        // false이고, RQ-16 항이 없으면 아무것도 남지 않아 데미지가
        // 정상 적용된다(격리 워크트리 재현, `_workspace/RQ-31/
        // 12_test-writer_rq16-net.md` §MUT-F). **이 escape가 없던
        // 시점(RQ-31 Safe Zone·낙하 데미지 합류 이후)에는 이 단언이
        // 죽지 않았다** — 위치가 자기 스폰 지점(=Safe Zone)에 그대로
        // 있어 `isSafeZoneProtected`만으로 이미 무효화가 성립했기
        // 때문이다(RQ-16 항 유무와 무관하게 결과가 같았다).
        expect(afterLanding.hp).toBe(PLAYER.MAX_HP)
      } finally {
        await leaveRoom(room)
      }
    },
    20_000,
  )
})

describe('RQ-18 리뷰 보강(major, Safe Zone 그물, 파일 상단 REV7 참고) — Safe Zone 안에서는 RQ-16 만료 후에도 낙하 데미지가 무효화된다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-18 회귀(델타 재평가 blocker): 자기 스폰 지점(Safe Zone)에 그대로 있으면 RQ-16(시간 보호)이 만료된 뒤에도 낙하 데미지가 무효화된다 — 대조군: 같은 절차에서 위치만 탈출하면 정상 데미지(50)가 든다',
    async () => {
      const client = newClient(server)
      const room = await joinGame(client)

      try {
        const baseline = await waitForPlayerCondition(room, room.sessionId, () => true, '초기 스냅샷', SNAPSHOT_TIMEOUT_MS)
        expect(baseline.hp).toBe(PLAYER.MAX_HP)

        // 핵심 격리 — RQ-16(시간 보호)을 화이트박스로 즉시 만료 처리한다
        // (`firedSinceSpawn=true`이면 `isSpawnProtected`가 항상 false를
        // 반환한다, `@shared/sim/lifecycle` 참고). **위치는 절대 건드리지
        // 않는다** — 자기 스폰 지점(Safe Zone 내부, 거리 0)에 그대로
        // 남겨 둔다. 이 격리가 없으면 "RQ-16이 아직 안 끝나서 통과"하는
        // 공허한 테스트가 된다(원장 25f가 hitscan 축에 대해 이미 경고한
        // 함정과 정확히 같다 — 이 REV7은 그 함정을 낙하 축에 적용한다).
        getServerRoom(room).firedSinceSpawn.set(room.sessionId, true)

        // 핵심 단언 — RQ-16은 이미 꺼졌는데도(위에서 만료 처리) Safe Zone
        // 안(위치를 옮기지 않았으므로 착지 위치 `next`가 자기 스폰
        // 지점 그대로)이라 낙하 데미지가 무효화돼야 한다. `trackFallDamage`
        // 에서 `|| isSafeZoneProtected`(RQ-31 위치 보호) 두 줄이 없으면
        // (또는 되돌아가면) 이 단언만 죽는다 — RQ-16 게이트(`isSpawnTimeProtected`)
        // 는 이미 위에서 꺼졌으므로 그쪽으로는 이 실패를 가릴 수 없다.
        const inZoneLanding = await jumpAndObserveLanding(room, NON_FATAL_OVERRIDE_PEAK_M)
        expect(inZoneLanding.hp).toBe(PLAYER.MAX_HP)

        // 양성 대조군(공허화 방지, 팀리드 지시) — 같은 세션에서 위치만
        // Safe Zone 밖으로 옮긴 뒤(RQ-16은 이미 위에서 꺼진 채로 유지)
        // 완전히 동일한 절차(같은 낙하 높이)를 반복한다. 위 무피해가
        // "낙하 데미지 장치 자체가 꺼져 있어서"가 아니라 "Safe Zone
        // 안이라서"였음을 여기서 정상 데미지(50)로 반증한다 — 이 대조군이
        // 없으면 위 단언은 자기 자신만으로 두 가설을 구분하지 못한다.
        escapeSafeZone(getServerRoom(room), room.sessionId, inZoneLanding)
        const escapedLanding = await jumpAndObserveLanding(room, NON_FATAL_OVERRIDE_PEAK_M)

        const expectedDamage = (NON_FATAL_OVERRIDE_PEAK_M - FALL_DAMAGE.SAFE_HEIGHT_M) * FALL_DAMAGE.DAMAGE_PER_METER
        expect(expectedDamage).toBe(50) // GA-45와 동일 산술 — 리터럴로도 재확인
        expect(escapedLanding.hp).toBe(PLAYER.MAX_HP - expectedDamage)
        expect(escapedLanding.hp).toBe(50)
      } finally {
        await leaveRoom(room)
      }
    },
    30_000,
  )
})
