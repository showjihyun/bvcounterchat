import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { CAPACITY, NET } from '@shared/constants'
import { AFK_TICKS } from '@shared/sim/afk'

/**
 * RQ-43 AFK 자동 퇴장 + 관전자 승격 — 서버 권위(RQ-61) 통합 테스트
 * (ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-13** (`harness/evals/golden/track-a-product.jsonl`,
 * `verify` 필드가 이 파일 경로를 정확히 지정한다).
 * - given: 플레이어 A가 5분간 이동·사격·채팅 등 어떤 입력도 보내지 않았고,
 *   대기 중인 관전자가 존재.
 * - when: 5분이 경과.
 * - then: A는 자동으로 퇴장 처리되고, 대기 중이던 관전자 중 한 명이 A의
 *   슬롯으로 플레이어 전환된다.
 *
 * RQ-43 전문: "플레이어가 5분간 입력이 없으면, 시스템은 그 플레이어를
 * 자동 퇴장시켜야 한다(AFK). 퇴장 시 그 슬롯은 대기 중인 관전자에게
 * 열려야 한다."
 *
 * **레벨 분리(ADR-0008/ADR-0011)**: "경과 틱이 정확히 임계(9000틱=5분)에
 * 도달하는 순간"이라는 타이트한 경계 판정은 `tests/unit/sim-afk.test.ts`
 * (A계층, 틱 정수만 주입)가 이미 고정했다. 이 파일(B계층)은 그 판정 로직이
 * 실 `GameRoom` 30Hz 틱 루프·메시지 핸들러·`spectators`↔`players` 전환에
 * 실제로 배선돼 있는지를 실 WebSocket으로 블랙박스 확인한다 — 경계 정밀도
 * 대신 "임계를 한참 넘김 vs 아직 충분히 여유 있음"이라는 여유 있는 두
 * 극단만 다룬다(`rq-15-respawn-timer.test.ts`/`rq-18-fall-damage.test.ts`가
 * 이미 채택한 A/B 레벨 분리와 동일한 정신).
 *
 * ---
 *
 * ## 설계 쟁점 1 — 5분을 실제로 기다릴 수 없다
 *
 * `PLAYER.AFK_TIMEOUT_MS`(5분)를 실 WebSocket 대기로 검증하면 이 파일
 * 하나가 5분 넘게 걸린다 — CI 게이트 예산(ADR-0008 §7, 3분)을 이 파일
 * 혼자 넘긴다. 그래서 `rq-18-fall-damage.test.ts`가 낙하 높이를 화이트박스로
 * 주입한 것과 동일한 이유로, 이 파일은 "마지막 입력 처리 틱"을 화이트박스로
 * 직접 주입해 5분 경과 상황을 즉시 만든다(팀리드 지시 — "5분을 실제로
 * 기다리지 않는다").
 *
 * ## 설계 쟁점 2 — 화이트박스 기법(RQ-18 선례 재사용)
 *
 * `matchMaker.getLocalRoomById(roomId)`(`rq-18-fall-damage.test.ts`가 이미
 * 확립한 기법, `node_modules/@colyseus/core/build/MatchMaker.d.ts` 실측
 * 확인)로 테스트 프로세스 **안에서** 실제로 기동 중인 `GameRoom` 인스턴스를
 * 직접 얻어, 그 인스턴스의 신규 private map `lastInputAtTick`(그린필드
 * 계약, `sim-afk.test.ts` 상단 "가정" 절 참고)에 "마지막 입력 처리 틱"을
 * 직접 심는다. `src/`를 수정하는 것이 **아니다** — 같은 프로세스 안에서
 * 이미 실행 중인 서버 상태를 테스트가 조작하는 것이다.
 *
 * `GameRoom.state`(서버 권위 `GameState`, `@colyseus/core`의 `Room.state`가
 * public이라 이 접근도 신규 계약이 아니다)의 `tick`도 함께 읽어, 클라이언트
 * 패치 지연(기본 20Hz)에 흔들리지 않는 서버 권위 값을 기준으로 주입량을
 * 계산한다.
 *
 * **RQ-18과의 차이(더 단순함)**: RQ-18의 화이트박스는 "주입 후 실제 물리
 * (점프)가 그 값을 소비할 때까지" 실 WebSocket 왕복·틱 캐치업과 경합했다
 * (REV3~5가 그 경합을 순차로 해결). 이 파일의 "AFK 임계를 한참 넘김" 주입은
 * 그런 경합이 없다 — 주입 자체가 동기 프로세스 내 직접 대입이고, 그 다음
 * 어떤 실 메시지 왕복도 필요 없이 다음 실 틱(≈33ms)이 곧바로 그 값을 읽어
 * 판정한다. 유일하게 실 WS 왕복과 경합하는 것은 "입력이 타이머를 리셋하는가"
 * 테스트뿐이다(아래 "설계 쟁점 3" 참고).
 *
 * ## 설계 쟁점 3 — 입력 리셋 검증과 레이스
 *
 * "아직 임계 전" 상태를 만든 뒤 그 세션에 실제 입력 메시지를 보내 타이머가
 * 리셋되는지 확인하려면, 주입 시점에 **충분한 여유(REMAINING_TICKS_BEFORE_
 * DUE, 30틱≈1000ms)**를 남겨 둔다 — 리셋 메시지의 실 WS 왕복(로컬에서 통상
 * 수~수십 ms, CI 지터를 감안해도 이 파일의 다른 여유값(300ms대)보다 넉넉한
 * 1000ms 여유 안에 도착한다고 가정)이 그 여유를 초과하지 않는 한 "리셋
 * 전에 먼저 킥되어 버리는" 거짓 실패가 생기지 않는다.
 *
 * **양성 대조군(공허화 방지, `rq-18-fall-damage.test.ts` "양성 대조군 설계"와
 * 동일 정신)**: "리셋 후 살아있다"는 음성 단언만으로는 AFK 킥 자체가
 * 배선되지 않은 경우와 구분되지 않는다. 그래서 각 입력-리셋 케이스는 생존을
 * 확인한 직후, **같은 세션**에 이번엔 확실히 임계를 넘긴 값을 주입해 실제로
 * 킥되는 것까지 반증한다(`assertInputResetsAfkTimer` 헬퍼).
 *
 * **F2 수정(평가 보고서 `_workspace/RQ-43/04_evaluator_report.md` §5-2,
 * major — `_workspace/RQ-43/05_test-writer_f1f2.md` 대응)**: 위 설계 당시
 * "생존 확인"을 `expect(isPlayer(room, sessionId)).toBe(true)`로 **자기
 * 자신의** 시야로 읽었으나, 이는 원천적으로 무효였다 — 서버가 그 세션을
 * 실제로 끊으면 자기 제거 패치는 그 소켓으로 도달하지 못해 자기 시야가
 * 영구히 낡은 채 `true`에 머문다. 평가자 실측: 킥 1800ms 후에도 피해자
 * 자기 시야는 `isPlayer=true`인 반면, 제3자 시야는 `isPlayer=false`·서버
 * `players`도 실제로 줄어 있었다 — 즉 **리셋이 실패해 실제로 킥된 뒤에도
 * 이 단언은 통과했다**(당시 M3 4종이 검출된 것은 이 단언이 아니라 양성
 * 대조군의 타임아웃이라는 부수효과였다). **원칙**: 자기 자신의 소속을
 * 자기 시야로 읽는 단언은 연결이 끊길 수 있는 세션에 대해서는 원천적으로
 * 무효다. 수정: `assertInputResetsAfkTimer`가 방관자(bystander) 연결을
 * 추가로 받아 그 시야로 생존을 확인한다 — GA-13 케이스가 이미 쓰는
 * `bystanderSeesFinalStatePromise` 패턴과 동일하다.
 *
 * ## 설계 쟁점 4 — F1 회귀 가드: AFK 킥의 멱등성
 *
 * 평가(`04_evaluator_report.md` §7, FAIL 사유)가 실증한 결함: `kickAfkPlayer`는
 * `promoteWaitingSpectator()`(정원 검사 없음) 뒤 `client.leave()`를 부르는데,
 * 세션이 `state.players`에서 실제로 빠지는 시점은 **소켓 close 핸드셰이크가
 * 끝난 뒤의 `onLeave`**다. close가 1틱(33ms)보다 오래 걸리면 다음 틱이 같은
 * 세션을 다시 AFK로 판정해 승격이 반복된다 — 로컬호스트에서는 close가 보통
 * 1틱 안에 끝나 이 결함이 가려지지만(평가자의 "대조군" 실측), RTT가 있는 모든
 * 실 네트워크·특히 AFK의 대표적 원인인 무응답 연결에서는 최악 경로가 곧 흔한
 * 경로다(평가자 실측: RTT 60ms→2명 승격, 무응답 연결이면 `ws`의
 * `closeTimeout` 30초까지 최대 900틱 동안 매 틱 승격).
 *
 * **재현 기법**: 실 소켓 close 지연은 재현하기 어렵고, 억지로 재현해도
 * 그 자체가 실 타이머 의존이라 비결정론적이다(ADR-0008 위반 소지). 그래서
 * "onLeave가 아직 처리되기 전에 같은 세션이 다시 AFK로 판정됐다"는 **결과**를,
 * 화이트박스로 `kickAfkPlayer`(private 메서드 — `lastInputAtTick`과 동일한
 * `as unknown as` 캐스팅 결합, 신규 계약 아님)를 **연속 2회** 직접 호출해
 * 결정론적으로 만든다(평가 보고서 §7 "회귀 테스트 제안" ②를 그대로 따른다).
 * 이는 실제 결함의 그럴듯한 발현이기도 하다 — `startTickLoop`의 캐치업 for문이
 * 완전히 동기라 여러 틱이 한 콜백 안에서 몰아 처리될 수 있고(`rq-18-fall-
 * damage.test.ts` REV3가 실측한 것과 동일한 메커니즘), 그 경우 두 번째(또는
 * 그 이상의) `kickAfkPlayer` 호출이 `onLeave`(비동기 close 완료 후에만
 * 발화)가 개입할 여지조차 없이 같은 동기 구간 안에서 연달아 일어난다.
 *
 * **두 시나리오(팀리드가 명시한 두 불변식을 각각 고정)**: (a) 정원
 * 시나리오 — 플레이어 정원(10)을 채운 상태에서 재현해 RQ-03 정원 불변식
 * (`players.size <= CAPACITY.PLAYERS`)이 실제로 깨지는 것을 직접 보인다
 * (평가자의 실측 시나리오와 동일). (b) 정원 무관 시나리오 — 정원을 채워
 * 관전자를 확보한 뒤 필러 플레이어 대부분을 자발적으로 퇴장시켜(승격을
 * 유발하지 않는다 — 스코프 밖, §"스코프 밖" 참고) 인위적으로 "정원보다
 * 훨씬 적은" 상태를 만들고 나서 재현한다 — "승격은 최대 1명"이 정원
 * 클램프의 **부수효과**가 아니라 `kickAfkPlayer` 자체의 독립적인 멱등성
 * 불변식임을 고정한다. 정원 가드만 넣고 킥 자체를 멱등하게 만들지 않는
 * 부분 수정(평가 보고서 §7 "수정 방법"이 "어느 하나만으로는 부족하다"고
 * 명시적으로 경고한 그 절반)은 정원 미만 상태에서는 여전히 이중 승격을
 * 허용한 채 (a)만 통과시킬 수 있다 — (b)가 그 틈을 막는다.
 *
 * ## 설계 쟁점 5 — 리뷰 blocker 재현: 유휴 `move` 하트비트가 AFK를 무력화했다(현재는 회귀 가드)
 *
 * **당시(수정 전) 결함**(리뷰 `_workspace/review/feat-RQ-43-afk-kick.md`
 * blocker가 실증): 실 `src/client/scene/PlayerControls.tsx:121-127`은 조작
 * 여부와 무관하게 매 `NET.TICK_MS`(33ms)마다 `move`를 보낸다(아무 키도 안
 * 눌렸으면 `{dirX:0,dirZ:0,mode:'run',jump:false}`, `movementInput.ts:54-59`
 * 가 반환하는 정상 유휴값). 당시 서버 `touchAfkTimer`는 payload 내용과
 * 무관하게 무조건 `lastInputAtTick`을 갱신했으므로, **실 클라이언트를 켠
 * 세션은 절대 AFK로 판정되지 않았다** — GA-13의 given("어떤 입력도 보내지
 * 않았고")이 이 클라이언트로는 도달 불가능한 상태였다. 기존 통합
 * 테스트(GA-13 등)가 이 결함을 못 잡은 이유: 테스트 클라이언트는
 * `PlayerControls`를 마운트하지 않는 순수 `colyseus.js` `Room`이라 아무것도
 * 자동 전송하지 않는다 — 제품이 실제로 보내는 30Hz 유휴 하트비트를 관측하는
 * 테스트가 0건이었다.
 *
 * **현재 계약(수정 커밋 `07499e1`)**: `registerMessageHandlers`의 `'move'`
 * 핸들러가 `sanitizeMoveInput` 결과로 `isMoveActivity`(실제 조작 성분 —
 * `dirX`/`dirZ`가 유한하고 0이 아니거나 `jump`)를 판정해, 참일 때만
 * `touchAfkTimer`를 호출한다. 유휴값 하트비트(`isMoveActivity === false`)는
 * 더 이상 AFK 타이머를 리셋하지 않는다 — 아래 두 케이스는 이제 이 계약을
 * 지키는 **회귀 가드**다: 재현 케이스는 유휴 하트비트가 계속 흘러도 여전히
 * 킥되는지(수정이 유지되는지)를, 대조군은 실제 조작 하트비트가 여전히
 * 킥을 막는지(과잉 수정으로 되돌아가지 않았는지)를 지킨다.
 *
 * **재현 설계 — 단발 레이스가 아니라 지속 하트비트로 재현한다**: 화이트박스로
 * "곧 임계"인 상태를 한 번 주입한 뒤 그 순간 하트비트가 먼저 도착하는지
 * 서버 스캔이 먼저 도는지를 다투는 **단발 경합**으로 설계하면 결과가 실행마다
 * 갈릴 수 있다(운에 좌우됨 — ADR-0008이 배제하는 비결정론). 그래서 이 파일은
 * `forceAfkRemaining`에 **하트비트 주기(33ms)보다 훨씬 큰 여유**
 * (`IDLE_HEARTBEAT_MARGIN_TICKS`=60틱≈2000ms)를 주고, 그 여유가 흐르는 **내내**
 * 하트비트를 계속 보낸다 — 당시 결함의 성질 그대로("매 하트비트가 무조건
 * 리셋"하므로 ≈60번의 기회 중 단 한 번만 서버에 도달해도 마감이 다시
 * 늘어난다) 재현하는 것이라, 단 한 번의 타이밍이 아니라 하트비트가 실제로
 * 계속 흐르는 한 결정론적으로 재현된다(이 여유 안에 하트비트가 전혀
 * 도달하지 않을 정도의 지속적 지연은 로컬 WS에서 일어나지 않는다).
 *
 * **대조군(팀리드 지시 — 과잉 수정 방지)**: 같은 절차를 **실제 조작이 담긴**
 * payload(`dirZ:1`)로도 반복해, 그 세션은 킥되지 **않아야** 함을 확인한다.
 * 이 대조군이 없으면 "`move`를 전부 무시하게" 만드는 과잉 수정(예: `move`
 * 핸들러 자체를 비활성화)도 재현 케이스를 통과시킬 수 있다 — 대조군은 수정
 * 전 코드에서도, 수정 후 코드에서도 항상 통과해야 한다(실제 조작은 어느
 * 쪽 구현에서도 AFK를 리셋해야 정상이다).
 *
 * **미결 — 스펙 질의 대상(리뷰가 지적, 이 파일은 어느 방향으로도 단언하지
 * 않는다 — 원장 22l 참조)**: ① 앉기(crouch) 키를 누른 채 가만히 있는 세션 —
 * `mode`가 `'crouch'`로 계속 전송되는데 이를 "활동"으로 볼지는 스펙 침묵
 * (현재 계약은 `mode`를 활동으로 치지 않는다 — `isMoveActivity` 참고). ②
 * 마우스 룩(시점 회전)만 하는 플레이어 — yaw/pitch가 와이어에 실리지
 * 않아(`GameState.ts` `Player`에 없음) 서버가 관측할 수 없다. 두 경우 모두
 * 스펙·골든이 답을 요구하지 않으며, 이 재현 가드는 오직 "완전한 유휴값
 * 하트비트"(`{dirX:0,dirZ:0,mode:'run',jump:false}`) 하나만 재현·단언한다.
 *
 * ## 대기 술어 컨벤션(팀리드 지시 — 반드시 준수, 근거는 각 호출부에 명시)
 *
 * ① 대기 조건은 단조·안정 신호만 쓴다 — 이 파일의 모든 `waitForCondition`/
 *    `waitForLeave` 호출은 "한 번 참이 되면 이후 계속 참인" 상태(연결 종료,
 *    컬렉션 멤버십 전환)만 기다린다. 전이 중간 상태를 관측하는 대기는 없다.
 * ② 구독 시점에 술어가 거짓임이 보장돼야 한다 — 이 파일은 매번 (a) 직전
 *    동기 단언으로 시작 상태를 확인하고 (b) 그 즉시(사이에 `await`나 다른
 *    비동기 경계 없이) 리스너를 등록한 **다음에만** 화이트박스 주입(트리거)을
 *    호출한다. 주입 자체가 동기 same-process 대입이고 판정은 다음 비동기
 *    틱에서만 일어나므로, 리스너 등록 시점에는 아직 트리거조차 실행되지
 *    않은 상태다 — "구독 전에 이미 참"이 될 경로가 없다(RQ-18처럼 실 WS
 *    왕복이 끼어들 필요가 없어 이 보장이 더 직접적이다, 설계 쟁점 2 참고).
 *
 * ## 격리(팀리드 지시 — RQ-40 라운드 교훈)
 *
 * `GameRoom`은 `autoDispose=false`(GA-29 단일 룸)라 룸이 살아있는 한 세션별
 * 부기 상태가 `it()` 사이에 자연히 리셋되지 않는다. `rq-40-chat-history-
 * restore.test.ts`가 이미 겪은 문제(공유 서버 + 정확 일치 단언의 오염)와
 * 동일한 리스크를 피하기 위해, 이 파일은 (다른 통합 테스트 파일들과 달리)
 * `beforeAll`/`afterAll`이 아니라 **`beforeEach`/`afterEach`로 매 `it()`마다
 * 서버(=룸)를 새로 기동·종료**한다.
 *
 * ## 스코프 밖(팀리드 지시 — 원장 22g)
 *
 * - **정상 접속 종료(voluntary disconnect) 시 승격** — RQ-43 원문은 AFK
 *   퇴장 경로만 명시한다. 이 파일은 그 경로만 검증하고, 자발적 `room.leave()`
 *   시에도 관전자가 승격돼야 하는지는 스펙 침묵이라 다루지 않는다(질의로
 *   이월, 원장 22g).
 * - AFK 경고·카운트다운 HUD 표시 — 스펙 없음.
 *
 * ## 입력 종류(RQ-43 "이동·사격·채팅 등 어떤 입력도")
 *
 * `'move'`·`'fire'`·`'chat'`·`'reload'` 4종 전부를 개별 검증한다 — 하나라도
 * 빠지면 그 경로로 AFK가 오작동한다(팀리드 지시). 각 케이스는 살아있는
 * (사망하지 않은) 갓 접속한 플레이어가 그 메시지를 정상적으로 처리 가능한
 * 상태에서 보낸다 — "게임 로직상 거부되는 입력(예: 시신의 사격)도 수신
 * 자체로 리셋되는가"는 이 파일이 다루지 않는다(스펙·골든 미규정, `sim-afk
 * .test.ts` 상단 "가정" 절 참고 — coder의 구현 자유).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const STATE_TIMEOUT_MS = 5_000

/** AFK 킥이 실제로 처리될 때까지의 관측 상한 — 화이트박스 주입 직후 다음
 * 실 틱(≈33ms) 안에 처리될 것으로 예상하나, CI 스케줄링 지터를 넉넉히
 * 흡수한다(`rq-18-fall-damage.test.ts`의 유사 상수들과 동일한 여유 원칙). */
const KICK_OBSERVE_TIMEOUT_MS = 5_000

/** "아직 임계 도달 전" 주입 시 남겨 두는 여유 틱 — 30틱≈1000ms. 입력
 * 리셋 메시지의 실 WS 왕복(로컬에서 통상 수~수십 ms)이 이 여유 안에 항상
 * 도착한다고 가정한다(파일 상단 "설계 쟁점 3" 참고). */
const REMAINING_TICKS_BEFORE_DUE = 30

/** 리셋 입력을 보낸 뒤, 원래(리셋이 없었다면) 킥됐을 시점을 명백히 지나서까지
 * 생존을 확인하는 대기(ms) — REMAINING_TICKS_BEFORE_DUE(≈1000ms)보다
 * 넉넉히 길게 잡는다. */
const SURVIVE_AFTER_RESET_MS = 1_800

/** 화이트박스로 주입하는 "이미 한참 지남" 값의 안전 여유(틱) — 정확히
 * AFK_TICKS만큼만 빼면 경계 정밀도에 좌우될 수 있으므로(그 정밀도는
 * `sim-afk.test.ts`의 책임) 넉넉히 더 뺀다. */
const OVERDUE_SAFETY_MARGIN_TICKS = 1_000

/** F1 회귀 가드(a) 정원 시나리오 — 대기 관전자 수. 이중 승격(결함)이면
 * 2명이 소진되므로 그보다 크게 잡아 "소진 후에도 여유가 있었다"를 함께
 * 보인다(설계 쟁점 4). */
const F1_CAPACITY_SPECTATOR_COUNT = 3
/** F1 회귀 가드(b) 정원 무관 시나리오 — 필러 퇴장 후 남는 플레이어 수
 * (AFK 대상 + 방관자 둘뿐). `CAPACITY.PLAYERS`(10)보다 훨씬 작다. */
const F1_UNDER_CAPACITY_REMAINING_PLAYERS = 2
/** F1 회귀 가드(b) — 같은 시나리오의 대기 관전자 수. */
const F1_UNDER_CAPACITY_SPECTATOR_COUNT = 3

/** 리뷰 blocker 재현(설계 쟁점 5) — 실 `PlayerControls.tsx`와 동일한
 * 하트비트 주기. */
const IDLE_HEARTBEAT_INTERVAL_MS = NET.TICK_MS

/** 하트비트 재현 시나리오에서 주입하는 여유 틱 — 60틱≈2000ms. 하트비트
 * 주기(33ms)보다 훨씬 커서, 그 사이 하트비트가 ≈60회 도착할 기회를 준다
 * (설계 쟁점 5 "단발 경합이 아니라 지속 하트비트로 재현" 참고 — 단 한
 * 번의 타이밍에 좌우되지 않는다). */
const IDLE_HEARTBEAT_MARGIN_TICKS = 60

/** 하트비트가 계속 흐르는 동안 킥을 관측하는 상한 — 여유(≈2000ms)의
 * 4배 가까이 잡아 CI 지터를 흡수한다. 결함이 남아있으면(하트비트가 계속
 * 막으면) 이 상한에서 타임아웃되고, 고쳐지면 여유가 지나는 즉시 킥이
 * 관측된다. */
const IDLE_HEARTBEAT_KICK_TIMEOUT_MS = 8_000

/** 대조군(실제 조작 payload)에서 "여유가 명백히 지난 뒤에도 살아있어야
 * 한다"를 확인하는 고정 대기 — 여유(≈2000ms)를 충분히 지난 시점까지
 * 기다린다. */
const IDLE_HEARTBEAT_SURVIVE_MS = 3_000

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

interface StateLike {
  players?: { has?: (key: string) => boolean; size?: number }
  spectators?: { has?: (key: string) => boolean; size?: number }
}

function isPlayer(room: Room, sessionId: string): boolean {
  const state = room.state as StateLike | null
  return state?.players?.has?.(sessionId) === true
}

function isSpectator(room: Room, sessionId: string): boolean {
  const state = room.state as StateLike | null
  return state?.spectators?.has?.(sessionId) === true
}

function playersCount(room: Room): number {
  const state = room.state as StateLike | null
  return state?.players?.size ?? -1
}

/** F1 회귀 가드 전용(설계 쟁점 4) — `playersCount`와 대칭. */
function spectatorsCount(room: Room): number {
  const state = room.state as StateLike | null
  return state?.spectators?.size ?? -1
}

/** RQ-18의 `waitForPlayerCondition`과 동일한 정신을 일반화한 버전 — 특정
 * 플레이어 스냅샷이 아니라 임의의 상태 술어를 기다린다(위 "대기 술어
 * 컨벤션" ①②를 만족하도록 호출부가 구성한다). */
function waitForCondition(room: Room, predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      const tryResolve = (): void => {
        if (predicate()) resolve()
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    timeoutMs,
    label,
  )
}

/**
 * REV(레이스 수정, 팀리드 지시 — `_workspace/RQ-43/03_test-writer_race-fix.md`
 * 참고): `joinOrCreate()`가 resolve된 시점에도 그 클라이언트 **자기 자신의**
 * `room.state`는 아직 `undefined`일 수 있다(coder 격리 진단으로 실측
 * 확인 — resolve 직후 `state` undefined, 이후 첫 스냅샷이 도착하면
 * `spectators.has(self)`/`players.has(self)`가 정확해진다). `join` 직후
 * 자기 자신의 소속 컬렉션을 **동기적으로** `expect()`하기 전에는 항상 이
 * 함수로 최초 동기화를 먼저 기다린다 — `rq-03-spectator-overflow.test.ts`
 * 의 `waitForOwnMembership()`과 동일한 이유·동일한 패턴(그 파일 :125).
 * 다른 클라이언트의 시야로 상태를 기다리는 `waitForCondition` 호출들은
 * 이미 구독형 대기라 이 문제와 무관하다(전수 점검 결과, 위 보고서 §2 표
 * 참고) — `tryResolve()`가 `state`가 아직 없을 때 조용히 `false`를
 * 반환하고 `onStateChange`로 다음 스냅샷을 기다리므로 거짓 실패가 생기지
 * 않는다. 반면 이 함수처럼 결과를 곧바로 동기 `expect()`하는 지점은 그
 * 안전장치가 없어 별도로 대기가 필요하다.
 */
function waitForOwnMembership(room: Room, timeoutMs: number): Promise<'players' | 'spectators'> {
  return withTimeout(
    new Promise<'players' | 'spectators'>((resolve) => {
      const tryResolve = (): void => {
        if (isPlayer(room, room.sessionId)) {
          resolve('players')
          return
        }
        if (isSpectator(room, room.sessionId)) {
          resolve('spectators')
        }
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    timeoutMs,
    `sessionId=${room.sessionId} 소속 컬렉션(players/spectators) 최초 동기화 대기`,
  )
}

/** 서버가 이 연결을 강제 종료했음을 클라이언트 쪽에서 관측한다 —
 * `room.leave()`를 이 파일이 직접 호출하지 않은 세션에서 이 이벤트가
 * 발생했다면 그것은 서버측 강제 퇴장(AFK 킥)이라는 뜻이다. */
function waitForLeave(room: Room, timeoutMs: number, label: string): Promise<number> {
  return withTimeout(
    new Promise<number>((resolve) => {
      room.onLeave((code) => resolve(code))
    }),
    timeoutMs,
    label,
  )
}

/** 부기 맵 원소를 키로 지울 수 있다는 최소 계약 — `MapSchema#delete`/
 * `Map#delete`가 공통으로 만족한다(`Map#delete`와 동일한 표준 시그니처). */
interface DeletableMap {
  delete(key: string): boolean
}

/** 화이트박스 접근 대상 계약 — 파일 상단 "설계 쟁점 2" 참고.
 * `lastInputAtTick`은 아직 존재하지 않는 신규 필드다(Red 전제, `sim-afk
 * .test.ts` 상단 "가정" 절이 정본). `state`는 신규 계약이 아니다 —
 * `@colyseus/core`의 `Room.state`가 이미 public이다. `kickAfkPlayer`도
 * 신규 계약이 아니다 — F1 회귀 가드(설계 쟁점 4)를 위한 접근이며,
 * coder 구현이 이미 이 이름으로 존재한다(`GameRoom.ts` 확인 완료).
 *
 * **RQ-41 개정(2026-07-27) F1 "정원 무관" 셋업 갱신(원장 22n,
 * `_workspace/RQ-41/03_test-writer_f1-setup.md` §1 "새 셋업의 근거"가
 * 정본)으로 추가**: `state.players`/`state.spectators`(둘 다 이미
 * public `Room.state` 하위라 신규 계약이 아니다 — 여기서는 `.delete()`
 * 시그니처만 별도로 타입한다)와 `onLeave`가 정리하는 나머지 세션별
 * 부기 맵 전부. `evictFillerWithoutPromotion`(아래)이 `onLeave`와 동일한
 * 정리를 수행하되 승격 호출만 생략하기 위해 필요하다 — 전부 신규
 * 계약이 아니다(`GameRoom.ts`에 이미 이 정확한 이름으로 존재함을 직접
 * 읽어 확인했다, `fallPeakY`·`lastInputAtTick`과 동일한 화이트박스
 * 결합 방식). */
interface AfkTestSeam {
  lastInputAtTick: Map<string, number>
  state: { tick: number; players: DeletableMap; spectators: DeletableMap }
  kickAfkPlayer(sessionId: string): void
  moveStates: Map<string, unknown>
  pendingInputs: Map<string, unknown>
  pendingSeqs: Map<string, number>
  lastFireAtMs: Map<string, number>
  diedAtTick: Map<string, number>
  spawnedAtTick: Map<string, number>
  firedSinceSpawn: Map<string, boolean>
  magazines: Map<string, number>
  reloadStartedAtTick: Map<string, number>
  fallPeakY: Map<string, number>
}

/** `matchMaker.getLocalRoomById`(`rq-18-fall-damage.test.ts`가 이미 확립한
 * 기법)로 테스트 프로세스 안에서 실행 중인 실제 `GameRoom` 인스턴스를
 * 얻는다. 룸을 찾지 못하면(경로 오류) 이후 관측이 아니라 여기서 즉시
 * 실패해 원인을 분명히 한다. */
function getServerRoom(room: Room): AfkTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as AfkTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-43 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** 해당 세션이 AFK 임계를 이미 한참 넘겼다고 서버에 직접 주입한다 — 5분을
 * 실제로 기다리지 않는다(파일 상단 "설계 쟁점 1·2" 참고). 서버 권위
 * `state.tick`을 기준으로 계산해 클라이언트 패치 지연에 흔들리지 않는다. */
function forceImmediateAfkDue(room: Room, sessionId: string): void {
  const seam = getServerRoom(room)
  seam.lastInputAtTick.set(sessionId, seam.state.tick - AFK_TICKS - OVERDUE_SAFETY_MARGIN_TICKS)
}

/** 해당 세션의 AFK 마감까지 정확히 `remainingTicks`틱이 남은 상태로
 * 주입한다 — "곧 임계에 도달하지만 아직은 아니다"를 만들어, 그 직후 보내는
 * 입력이 타이머를 리셋하는지 확인하는 데 쓴다(설계 쟁점 3). */
function forceAfkRemaining(room: Room, sessionId: string, remainingTicks: number): void {
  const seam = getServerRoom(room)
  seam.lastInputAtTick.set(sessionId, seam.state.tick - (AFK_TICKS - remainingTicks))
}

/**
 * RQ-41 개정(2026-07-27) F1 "정원 무관" 셋업 갱신 — `onLeave`가 하는
 * 세션별 부기 정리(`GameRoom.ts` `onLeave`)를 **동일하게** 수행하되
 * `promoteWaitingSpectator()` 호출만 생략한다. 필러를 승격을 전혀
 * 유발하지 않고 조용히 제거해, "players가 정원보다 훨씬 적으면서
 * spectators는 손대지 않은" 전제를 화이트박스로 구성한다 — 이 전제가
 * 왜 실 접속/퇴장 흐름으로는 더 이상 도달 불가능한지는 아래 F1 "정원
 * 무관" 케이스 상단 주석과 `_workspace/RQ-41/03_test-writer_f1-setup.md`
 * §1을 보라.
 *
 * 실 소켓은 이 함수가 건드리지 않는다(열린 채로 남는다) — 호출자가
 * 테스트 종료 시 `leaveRoom()`으로 정상적으로 닫아야 한다. 그 시점의
 * 실 `onLeave`는 이미 지워진 세션이라 `state.players.delete()`가
 * `false`를 반환해 `wasPlayer=false`가 되고, 나머지 정리 라인들도 전부
 * 이미 지워진 키에 대한 `Map#delete` 재호출이라 표준 멱등 동작으로
 * 안전하게 아무 것도 하지 않는다(`onLeave` 자체 문서화 — "이미 지워진
 * 키에 대한 재호출을 전제하는데... 표준 멱등 동작이다") — 그리고
 * `wasPlayer=false`이므로 승격도 다시 호출되지 않는다.
 */
function evictFillerWithoutPromotion(room: Room, sessionId: string): void {
  const seam = getServerRoom(room)
  seam.state.players.delete(sessionId)
  seam.moveStates.delete(sessionId)
  seam.pendingInputs.delete(sessionId)
  seam.pendingSeqs.delete(sessionId)
  seam.lastFireAtMs.delete(sessionId)
  seam.diedAtTick.delete(sessionId)
  seam.spawnedAtTick.delete(sessionId)
  seam.firedSinceSpawn.delete(sessionId)
  seam.magazines.delete(sessionId)
  seam.reloadStartedAtTick.delete(sessionId)
  seam.fallPeakY.delete(sessionId)
  seam.lastInputAtTick.delete(sessionId)
}

/**
 * "아직 AFK 임계 전"인 상태를 화이트박스로 만든 뒤 `sendInput`으로 지정한
 * 종류의 메시지를 보내고, 원래(리셋이 없었다면) 킥됐을 시점을 명백히 지난
 * 뒤에도 여전히 접속 중임을 확인한다. 그 직후 양성 대조군(설계 쟁점 3)으로
 * 같은 세션에 확실히 임계를 넘긴 값을 주입해 실제로 킥되는 것까지
 * 반증한다 — 4종(move/fire/chat/reload) 공통 절차.
 *
 * **F2 수정(설계 쟁점 3 "F2 수정" 절 참고)**: 생존 확인은 `room` 자신이
 * 아니라 `bystander`(독립 연결)의 시야로 한다 — `room`(킥 대상이 될 수
 * 있는 세션) 자신의 시야는 실제로 킥되면 자기 제거 패치를 받지 못해
 * 영구히 낡은 채 남으므로, 그 시야로 "생존"을 읽는 단언은 연결이 끊길 수
 * 있는 세션에 대해서는 원천적으로 무효하다. 호출자는 `bystander`가
 * `room`의 최초 상태를 이미 관측했다는 전제(`waitForCondition`으로 확인)
 * 위에서 이 함수를 호출해야 한다.
 */
async function assertInputResetsAfkTimer(room: Room, bystander: Room, sendInput: () => void): Promise<void> {
  const sessionId = room.sessionId

  forceAfkRemaining(room, sessionId, REMAINING_TICKS_BEFORE_DUE)
  sendInput()
  await sleep(SURVIVE_AFTER_RESET_MS)
  expect(isPlayer(bystander, sessionId)).toBe(true)

  // 양성 대조군: 리스너를 먼저 등록한(대기 술어 ②) 다음에만 트리거한다.
  const kicked = waitForLeave(room, KICK_OBSERVE_TIMEOUT_MS, 'RQ-43 양성 대조군: 리셋 없이 재주입하면 실제로 AFK 킥이 발생하는지(onLeave) 대기')
  forceImmediateAfkDue(room, sessionId)
  await kicked
}

interface HeartbeatMoveInput {
  dirX: number
  dirZ: number
  mode: 'run' | 'walk' | 'crouch'
  jump: boolean
}

/**
 * 리뷰 blocker 재현(설계 쟁점 5) — 실 `src/client/scene/PlayerControls
 * .tsx:121-127`이 매 `NET.TICK_MS`마다 조작 여부와 무관하게 `move`를
 * 보내는 것과 동일한 하트비트를 재현한다. payload 형태도 실 `src/client
 * /net/connection.ts:258`의 `room.send('move', { ...input, seq })`와
 * 동일하게(증가하는 `seq` 포함) 맞춘다 — 서버는 `seq`가 없어도 정상
 * 동작하지만(하위 호환), 재현 충실도를 위해 그대로 포함한다.
 *
 * `input`이 유휴값(`{dirX:0,dirZ:0,mode:'run',jump:false}`)이면 실제
 * 방치 플레이어를, 조작값(예: `dirZ:1`)이면 대조군을 재현한다. 반환하는
 * 함수를 호출하면 하트비트를 멈춘다 — 호출자는 반드시 `finally`에서
 * 멈춰야 한다(멈추지 않으면 `room.leave()` 이후에도 인터벌이 남아
 * 다음 케이스로 새는 리소스 누수가 된다).
 */
function startIdleHeartbeat(room: Room, input: HeartbeatMoveInput): () => void {
  let seq = 0
  const intervalId = setInterval(() => {
    room.send('move', { ...input, seq })
    seq += 1
  }, IDLE_HEARTBEAT_INTERVAL_MS)
  return () => clearInterval(intervalId)
}

describe('RQ-43 AFK 자동 퇴장 + 관전자 승격', () => {
  let server: RunningServer

  // 팀리드 지시(원장 22g) — RQ-40 라운드 교훈과 동일한 이유로 케이스마다
  // 서버(=룸)를 새로 기동·종료한다(파일 상단 "격리" 절).
  beforeEach(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterEach(async () => {
    await stopServer(server)
  })

  it(
    `RQ-43/GA-13: 대기 중인 관전자가 있을 때, 입력 없는 플레이어는 AFK로 자동 퇴장되고 그 슬롯이 관전자에게 넘어간다`,
    async () => {
      const players: Room[] = []
      for (let i = 0; i < CAPACITY.PLAYERS; i += 1) {
        players.push(await joinGame(newClient(server)))
      }
      const afkTarget = players[0]
      const bystander = players[1]
      if (!afkTarget || !bystander) throw new Error('플레이어 정원 채우기 실패 — players가 비어 있다')

      const spectator = await joinGame(newClient(server))

      try {
        const afkTargetId = afkTarget.sessionId
        const spectatorId = spectator.sessionId

        // given: 정원이 찬 뒤 입장한 접속은 RQ-03에 따라 관전자다(그 분류
        // 판정 자체는 `rq-03-spectator-overflow.test.ts`가 전담 — 이
        // 파일은 전제로 삼아 확인만 한다).
        await waitForCondition(bystander, () => isPlayer(bystander, afkTargetId), 'AFK 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)
        // REV(레이스 수정) — spectator 자신의 최초 상태 동기화를 먼저
        // 기다린다(`waitForOwnMembership` docblock 참고). 이 대기가 없으면
        // `joinOrCreate()` resolve 직후 `spectator.state`가 아직 `undefined`인
        // 채로 곧바로 아래 두 `expect()`를 동기 평가해 거짓 실패할 수 있었다.
        const spectatorMembership = await waitForOwnMembership(spectator, STATE_TIMEOUT_MS)
        expect(spectatorMembership).toBe('spectators')
        expect(isSpectator(spectator, spectatorId)).toBe(true)
        expect(isPlayer(spectator, spectatorId)).toBe(false)

        // 대기 술어 ② — 리스너를 먼저 등록한(직전 동기 단언으로 시작 상태
        // 확인 완료) 다음에만 화이트박스 트리거를 호출한다.
        //
        // REV2(레이스 수정 2차 — 5회 반복 실행으로 재현) — 각 클라이언트가
        // "자신의 관심사"만 반영됐다고 확인하는 것으로는 부족했다. 실측
        // 재현: `promotedPromise`(spectator 자신의 승격만 확인)가 resolve된
        // **뒤에도** `bystander`(제3자)의 시야에서는 여전히
        // `isPlayer(bystander, afkTargetId) === true`인 순간이 존재했다 —
        // 서버가 같은 틱에 브로드캐스트한 패치라도 클라이언트마다 별도
        // WebSocket 프레임으로 도착·디코딩되므로 반영 시점이 클라이언트별로
        // 어긋날 수 있다(대기 술어 ①이 요구하는 "관측 대상 그 자체의" 단조
        // 안정 신호가 필요하다는 뜻 — 다른 클라이언트가 이미 안정됐다는
        // 사실이 이 클라이언트의 안정을 보장하지 않는다). 그래서 최종
        // `expect()`가 읽는 **모든** (room, 대상 조건) 쌍을 각각 그 room
        // 자신의 `waitForCondition`으로 명시적으로 기다린다 — "이 클라이언트
        // 시야에서 최종 상태에 도달했는가"를 관측 대상별로 전부 확인한
        // 뒤에만 동기 `expect()`로 넘어간다.
        const leftPromise = waitForLeave(afkTarget, KICK_OBSERVE_TIMEOUT_MS, 'RQ-43/GA-13: AFK 대상의 서버측 강제 퇴장(onLeave) 대기')
        const spectatorSeesFinalStatePromise = waitForCondition(
          spectator,
          () => isPlayer(spectator, spectatorId) && !isSpectator(spectator, spectatorId) && !isPlayer(spectator, afkTargetId),
          'RQ-43/GA-13: 관전자(spectator) 시야에서 자신의 승격 + AFK 대상 제거 모두 반영 대기',
          KICK_OBSERVE_TIMEOUT_MS,
        )
        const bystanderSeesFinalStatePromise = waitForCondition(
          bystander,
          () => !isPlayer(bystander, afkTargetId) && isPlayer(bystander, spectatorId),
          'RQ-43/GA-13: 제3자(bystander) 시야에서 AFK 대상 제거 + 관전자 승격 모두 반영 대기',
          KICK_OBSERVE_TIMEOUT_MS,
        )

        forceImmediateAfkDue(afkTarget, afkTargetId)

        await Promise.all([leftPromise, spectatorSeesFinalStatePromise, bystanderSeesFinalStatePromise])

        // then: A(afkTarget)는 더 이상 플레이어가 아니다 — 승격된 클라이언트
        // (spectator) 자신의 관측과 제3자(bystander) 관측 양쪽으로 재확인해
        // "승격 클라이언트만의 착시"가 아님을 보인다.
        expect(isPlayer(spectator, afkTargetId)).toBe(false)
        expect(isPlayer(bystander, afkTargetId)).toBe(false)
        // 대기 중이던 관전자(spectator)가 그 슬롯으로 전환됐다.
        expect(isPlayer(spectator, spectatorId)).toBe(true)
        expect(isSpectator(spectator, spectatorId)).toBe(false)
        // 정원 유지 — 한 명 빠지고 한 명 들어왔다.
        expect(playersCount(bystander)).toBe(CAPACITY.PLAYERS)
      } finally {
        // afkTarget은 이미 서버가 강제 퇴장시켰다 — 다시 leave()를 호출하면
        // 이미 닫힌 연결이라 reject할 수 있으므로 정리 대상에서 제외한다
        // (`rq-03-spectator-cap-reject.test.ts`의 방어적 정리 패턴과 동일).
        await Promise.all([
          ...players.slice(1).map((room) => leaveRoom(room).catch(() => undefined)),
          leaveRoom(spectator).catch(() => undefined),
        ])
      }
    },
    30_000,
  )

  it(
    'RQ-43: 대기 중인 관전자가 없어도 입력 없는 플레이어는 AFK로 자동 퇴장된다(승격은 슬롯 처리일 뿐 퇴장 자체의 전제조건이 아니다)',
    async () => {
      const bystander = await joinGame(newClient(server))
      const afkTarget = await joinGame(newClient(server))
      const afkTargetId = afkTarget.sessionId
      const bystanderId = bystander.sessionId

      try {
        await waitForCondition(bystander, () => isPlayer(bystander, afkTargetId), 'AFK 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)

        const leftPromise = waitForLeave(afkTarget, KICK_OBSERVE_TIMEOUT_MS, 'RQ-43: 관전자 없이도 AFK 대상이 강제 퇴장되는지(onLeave) 대기')
        const removedPromise = waitForCondition(
          bystander,
          () => !isPlayer(bystander, afkTargetId),
          'RQ-43: 관전자 없이도 players 컬렉션에서 AFK 대상 제거 대기',
          KICK_OBSERVE_TIMEOUT_MS,
        )

        forceImmediateAfkDue(afkTarget, afkTargetId)

        await Promise.all([leftPromise, removedPromise])

        expect(isPlayer(bystander, afkTargetId)).toBe(false)
        expect(isPlayer(bystander, bystanderId)).toBe(true) // 방관자 자신은 영향받지 않는다
      } finally {
        await leaveRoom(bystander).catch(() => undefined)
      }
    },
    15_000,
  )

  it(
    "RQ-43: 'move' 입력은 AFK 타이머를 리셋한다",
    async () => {
      const bystander = await joinGame(newClient(server))
      const room = await joinGame(newClient(server))
      try {
        // F2 수정 — 생존 확인을 bystander 시야로 하므로, 그 시야가 room의
        // 최초 상태를 이미 관측했는지 먼저 확인한다(`assertInputResetsAfkTimer`
        // 전제).
        await waitForCondition(bystander, () => isPlayer(bystander, room.sessionId), '입력 리셋 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)
        await assertInputResetsAfkTimer(room, bystander, () => {
          room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
        })
      } finally {
        await Promise.all([leaveRoom(room).catch(() => undefined), leaveRoom(bystander).catch(() => undefined)])
      }
    },
    15_000,
  )

  it(
    "RQ-43: 'fire' 입력은 AFK 타이머를 리셋한다",
    async () => {
      const bystander = await joinGame(newClient(server))
      const room = await joinGame(newClient(server))
      try {
        await waitForCondition(bystander, () => isPlayer(bystander, room.sessionId), '입력 리셋 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)
        await assertInputResetsAfkTimer(room, bystander, () => {
          room.send('fire', { dirX: 0, dirY: 1, dirZ: 0 }) // 항상 빗나가는 방향(수직 위) — 명중 여부는 이 테스트의 관심사가 아니다
        })
      } finally {
        await Promise.all([leaveRoom(room).catch(() => undefined), leaveRoom(bystander).catch(() => undefined)])
      }
    },
    15_000,
  )

  it(
    "RQ-43: 'chat' 입력은 AFK 타이머를 리셋한다",
    async () => {
      const bystander = await joinGame(newClient(server))
      const room = await joinGame(newClient(server))
      try {
        await waitForCondition(bystander, () => isPlayer(bystander, room.sessionId), '입력 리셋 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)
        await assertInputResetsAfkTimer(room, bystander, () => {
          room.send('chat', { text: 'still here' })
        })
      } finally {
        await Promise.all([leaveRoom(room).catch(() => undefined), leaveRoom(bystander).catch(() => undefined)])
      }
    },
    15_000,
  )

  it(
    "RQ-43: 'reload' 입력은 AFK 타이머를 리셋한다",
    async () => {
      const bystander = await joinGame(newClient(server))
      const room = await joinGame(newClient(server))
      try {
        await waitForCondition(bystander, () => isPlayer(bystander, room.sessionId), '입력 리셋 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)
        await assertInputResetsAfkTimer(room, bystander, () => {
          room.send('reload', {})
        })
      } finally {
        await Promise.all([leaveRoom(room).catch(() => undefined), leaveRoom(bystander).catch(() => undefined)])
      }
    },
    15_000,
  )

  // ---------------------------------------------------------------------
  // F1 회귀 가드(평가 보고서 §7, 설계 쟁점 4) — AFK 킥의 멱등성.
  // `src/`는 이 세션이 건드리지 않는다(팀리드 지시) — coder가 별도로
  // 수정한다. 아래 두 케이스는 현재 코드에서 **반드시 Red**여야 한다.
  // ---------------------------------------------------------------------

  it(
    'RQ-43 F1 회귀 가드(정원 시나리오): 같은 세션에 AFK 킥이 onLeave 처리 전 다시 판정돼도 정원(CAPACITY.PLAYERS)을 넘지 않고 슬롯당 승격은 최대 1명이다',
    async () => {
      const players: Room[] = []
      for (let i = 0; i < CAPACITY.PLAYERS; i += 1) {
        players.push(await joinGame(newClient(server)))
      }
      const afkTarget = players[0]
      const bystander = players[1]
      if (!afkTarget || !bystander) throw new Error('플레이어 정원 채우기 실패 — players가 비어 있다')

      const spectators: Room[] = []
      for (let i = 0; i < F1_CAPACITY_SPECTATOR_COUNT; i += 1) {
        spectators.push(await joinGame(newClient(server)))
      }

      try {
        const afkTargetId = afkTarget.sessionId

        await waitForCondition(bystander, () => isPlayer(bystander, afkTargetId), 'AFK 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)
        await waitForCondition(
          bystander,
          () => spectatorsCount(bystander) === F1_CAPACITY_SPECTATOR_COUNT,
          '관전자 최초 상태(spectators 전원 반영) 확인',
          STATE_TIMEOUT_MS,
        )
        const initialSpectatorCount = spectatorsCount(bystander)

        const leftPromise = waitForLeave(afkTarget, KICK_OBSERVE_TIMEOUT_MS, 'RQ-43 F1: AFK 대상의 서버측 강제 퇴장(onLeave) 대기')

        // 화이트박스 — 실 소켓 close 타이밍(비결정론)에 기대지 않고, "onLeave가
        // 아직 처리되기 전에 같은 세션이 다시 AFK로 판정됐다"는 상황을
        // 결정론적으로 직접 재현한다(설계 쟁점 4). 두 호출 사이에 `await`가
        // 없으므로 첫 번째 `.leave()`가 촉발한 비동기 close가 개입할 여지가
        // 없다.
        const seam = getServerRoom(afkTarget)
        seam.kickAfkPlayer(afkTargetId)
        seam.kickAfkPlayer(afkTargetId)

        await leftPromise
        await waitForCondition(bystander, () => !isPlayer(bystander, afkTargetId), 'RQ-43 F1: AFK 대상 제거 반영 대기', KICK_OBSERVE_TIMEOUT_MS)

        const finalPlayerCount = playersCount(bystander)
        const finalSpectatorCount = spectatorsCount(bystander)

        // 핵심 불변식(팀리드 지시, 평가 보고서 §7) — 현재 코드에서는 반드시
        // Red다: 2회 호출이 승격을 2회 유발해 players.size가
        // CAPACITY.PLAYERS+1이 되고, spectators는 2명 소진된다.
        expect(finalPlayerCount).toBeLessThanOrEqual(CAPACITY.PLAYERS)
        expect(initialSpectatorCount - finalSpectatorCount).toBeLessThanOrEqual(1)
      } finally {
        await Promise.all([
          ...players.slice(1).map((room) => leaveRoom(room).catch(() => undefined)),
          ...spectators.map((room) => leaveRoom(room).catch(() => undefined)),
        ])
      }
    },
    20_000,
  )

  it(
    'RQ-43 F1 회귀 가드(정원 무관): 정원보다 훨씬 적은 인원에서도 같은 세션의 이중 AFK 판정은 승격을 최대 1명으로 제한해야 한다(정원 클램프의 부수효과가 아니라 킥 자체의 멱등성)',
    async () => {
      // 관전자는 RQ-03에 따라 플레이어 정원이 찬 상태에서만 생긴다 —
      // 그래서 먼저 정원(10)을 채운 뒤 관전자를 확보한다.
      //
      // **셋업 갱신(RQ-41 개정 2026-07-27, 원장 22n,
      // `_workspace/RQ-41/03_test-writer_f1-setup.md` §1 "새 셋업의
      // 근거"가 정본)**: 예전 절차는 필러를 `leaveRoom()`으로 자발
      // 퇴장시켜 "정원보다 훨씬 적은" 상태를 만들었다 — 그 전제("자발적
      // 퇴장은 승격을 유발하지 않는다, `promoteWaitingSpectator`는
      // `kickAfkPlayer`에서만 호출된다")를 이번 개정이 뒤집었다:
      // `onLeave`도 이제 `promoteWaitingSpectator()`를 호출한다
      // (`GameRoom.ts` `onLeave`). 그 결과 spectators.size>0인 한 어떤
      // 실 퇴장이든(정상이든 AFK든) `state.players.delete()` 직후 같은
      // 동기 호출 스택 안에서 즉시 재승격이 일어나 players가 다시
      // 채워진다 — "players가 정원보다 훨씬 적으면서 spectators는 손대지
      // 않은" 상태는 이제 실 접속/퇴장 흐름만으로는 **구조적으로 도달
      // 불가능**하다(증명: spectators가 남아있는 한 퇴장 1건의 players
      // 순변화는 항상 0이고 spectators만 -1이다 — spectators가 전부
      // 소진된 뒤에야 추가 퇴장이 players를 실제로 줄이는데, 그 시점엔
      // 이미 spectators=0이라 "손대지 않은 spectators"가 존재하지
      // 않는다. 중간 상태를 관측할 틈도 없다 — delete와 재승격이 같은
      // 동기 구간에서 즉시 이어진다).
      //
      // 그래서 이 케이스는 화이트박스로 그 전제를 직접 구성한다 —
      // `evictFillerWithoutPromotion`(위)이 `onLeave`와 동일한 세션별
      // 부기 정리를 하되 승격 호출만 생략해, 필러를 승격 유발 없이
      // 조용히 제거한다. 이 테스트가 검증하는 불변식("players가 정원보다
      // 훨씬 적을 때도 같은 세션의 이중 AFK 판정은 승격을 최대 1명으로
      // 제한한다")은 필러가 어떻게 사라졌는지와 무관하다 — 실제로 검증
      // 대상인 `kickAfkPlayer`/`promoteWaitingSpectator` 코드 경로,
      // AFK 대상·bystander·spectator 3명의 실 연결은 전부 그대로다.
      // 화이트박스는 오직 "정원 미만" 전제를 만드는 데만 쓰인다.
      const players: Room[] = []
      for (let i = 0; i < CAPACITY.PLAYERS; i += 1) {
        players.push(await joinGame(newClient(server)))
      }
      const afkTarget = players[0]
      const bystander = players[1]
      if (!afkTarget || !bystander) throw new Error('플레이어 정원 채우기 실패 — players가 비어 있다')

      const spectators: Room[] = []
      for (let i = 0; i < F1_UNDER_CAPACITY_SPECTATOR_COUNT; i += 1) {
        spectators.push(await joinGame(newClient(server)))
      }

      try {
        const afkTargetId = afkTarget.sessionId

        await waitForCondition(bystander, () => isPlayer(bystander, afkTargetId), 'AFK 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)
        await waitForCondition(
          bystander,
          () => spectatorsCount(bystander) === F1_UNDER_CAPACITY_SPECTATOR_COUNT,
          '관전자 최초 상태(spectators 전원 반영) 확인',
          STATE_TIMEOUT_MS,
        )

        // 필러(players[2..]) 전원을 화이트박스로 제거해 정원보다 훨씬
        // 적은 상태를 만든다(위 "셋업 갱신" 참고 — 실 leaveRoom()을 쓰면
        // spectators가 즉시 재소진돼 이 전제에 구조적으로 도달할 수
        // 없다). 남는 것은 afkTarget·bystander 둘뿐이다.
        for (const filler of players.slice(2)) {
          evictFillerWithoutPromotion(bystander, filler.sessionId)
        }
        await waitForCondition(
          bystander,
          () => playersCount(bystander) === F1_UNDER_CAPACITY_REMAINING_PLAYERS,
          '필러 화이트박스 제거 반영(정원보다 훨씬 적은 상태, spectators 손대지 않음) 확인',
          STATE_TIMEOUT_MS,
        )

        const initialPlayerCount = playersCount(bystander)
        const initialSpectatorCount = spectatorsCount(bystander)
        expect(initialPlayerCount).toBe(F1_UNDER_CAPACITY_REMAINING_PLAYERS)
        expect(initialSpectatorCount).toBe(F1_UNDER_CAPACITY_SPECTATOR_COUNT)

        const leftPromise = waitForLeave(afkTarget, KICK_OBSERVE_TIMEOUT_MS, 'RQ-43 F1(정원 무관): AFK 대상의 서버측 강제 퇴장(onLeave) 대기')

        const seam = getServerRoom(afkTarget)
        seam.kickAfkPlayer(afkTargetId)
        seam.kickAfkPlayer(afkTargetId)

        await leftPromise
        await waitForCondition(
          bystander,
          () => !isPlayer(bystander, afkTargetId),
          'RQ-43 F1(정원 무관): AFK 대상 제거 반영 대기',
          KICK_OBSERVE_TIMEOUT_MS,
        )

        const finalPlayerCount = playersCount(bystander)
        const finalSpectatorCount = spectatorsCount(bystander)

        // 핵심 불변식(일반형) — players.size는 CAPACITY.PLAYERS 근처에도
        // 가지 않으므로(initialPlayerCount=2 ≪ CAPACITY.PLAYERS=10), 정원
        // 클램프(`promoteWaitingSpectator`의 `players.size >=
        // CAPACITY.PLAYERS` 가드)만으로는 이 단언을 통과시킬 수 없다 —
        // 킥 자체(`kickAfkPlayer`의 `state.players.delete()` 반환값
        // 멱등 가드)가 멱등해야만 통과한다. 변이 검증으로 확인
        // (`_workspace/RQ-41/03_test-writer_f1-setup.md` §3 "가드의
        // 이빨 재확인"): 그 멱등 가드만 제거하면(정원 가드는 그대로
        // 둬도) 이 단언이 실제로 깨진다 — 형제 케이스(F1 정원 시나리오)는
        // 같은 변이에서도 살아남는다(첫 승격이 players를 정원까지 이미
        // 채워, 두 번째 시도가 정원 가드에 걸린다 — 이 케이스는 애초에
        // 정원 근처에 가지 않으므로 그 대비가 통하지 않는다).
        expect(finalPlayerCount).toBe(initialPlayerCount)
        expect(finalSpectatorCount).toBe(initialSpectatorCount - 1)
      } finally {
        await Promise.all([
          leaveRoom(bystander).catch(() => undefined),
          ...players.slice(2).map((room) => leaveRoom(room).catch(() => undefined)),
          ...spectators.map((room) => leaveRoom(room).catch(() => undefined)),
        ])
      }
    },
    25_000,
  )

  // ---------------------------------------------------------------------
  // 리뷰 blocker 재현(`_workspace/review/feat-RQ-43-afk-kick.md`, 설계
  // 쟁점 5) — 유휴 move 하트비트가 AFK를 무력화했던 결함의 회귀 가드다.
  // 수정 커밋(`07499e1`, `isMoveActivity` 게이트)으로 이미 고쳐졌다 —
  // 아래 재현 케이스는 이제 **Green**이어야 하고(고쳐진 계약이 유지되는
  // 한), 대조군도 **Green**이어야 한다(과잉 수정으로 되돌아가지 않은
  // 한). 작성 당시(수정 전) 재현 케이스는 반드시 Red였다 — 그 실행
  // 증거는 `_workspace/RQ-43/08_test-writer_idle-heartbeat.md` §3·§4에
  // 있다.
  // ---------------------------------------------------------------------

  it(
    'RQ-43 리뷰 blocker 재현: 유휴 move 하트비트(실 PlayerControls와 동일 주기·payload)를 계속 보내도 AFK 킥이 일어나야 한다',
    async () => {
      const bystander = await joinGame(newClient(server))
      const room = await joinGame(newClient(server))
      const sessionId = room.sessionId

      // 실 PlayerControls는 조작 여부와 무관하게 이 주기로 계속 보낸다 —
      // 여기서도 test가 끝날 때까지(finally에서 정지) 멈추지 않는다.
      const stopHeartbeat = startIdleHeartbeat(room, { dirX: 0, dirZ: 0, mode: 'run', jump: false })

      try {
        await waitForCondition(bystander, () => isPlayer(bystander, sessionId), '재현 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)

        // 대기 술어 ② — 리스너를 먼저 등록한 다음에만 화이트박스 주입한다.
        const leftPromise = waitForLeave(
          room,
          IDLE_HEARTBEAT_KICK_TIMEOUT_MS,
          'RQ-43 리뷰 blocker 재현: 유휴 하트비트가 계속 흘러도 AFK 킥이 실제로 발생하는지(onLeave) 대기',
        )

        forceAfkRemaining(room, sessionId, IDLE_HEARTBEAT_MARGIN_TICKS)

        // 하트비트를 멈추지 않은 채로 기다린다 — 수정된 계약
        // (`isMoveActivity`, § "설계 쟁점 5")에서는 유휴 payload가 더
        // 이상 타이머를 리셋하지 않으므로, 주입된 여유(≈2000ms)가 실제로
        // 지나 킥된다. 수정 전에는 하트비트가 매 도착마다 무조건 타이머를
        // 리셋해 이 대기가 타임아웃됐다(당시 재현 증거는 위 보고서 참고).
        await leftPromise

        // 자기 시야가 아니라 제3자(bystander) 시야로 최종 상태를
        // 확인한다(F2에서 배운 원칙 — 끊긴 세션의 자기 시야는 무효).
        await waitForCondition(
          bystander,
          () => !isPlayer(bystander, sessionId),
          'RQ-43 리뷰 blocker 재현: 재현 대상 제거 반영(제3자 시야) 대기',
          KICK_OBSERVE_TIMEOUT_MS,
        )
        expect(isPlayer(bystander, sessionId)).toBe(false)
      } finally {
        stopHeartbeat()
        await Promise.all([leaveRoom(room).catch(() => undefined), leaveRoom(bystander).catch(() => undefined)])
      }
    },
    IDLE_HEARTBEAT_KICK_TIMEOUT_MS + 10_000,
  )

  it(
    'RQ-43 리뷰 blocker 대조군: 실제 조작이 담긴 move 하트비트(dirZ=1)를 계속 보내는 세션은 AFK로 킥되지 않는다',
    async () => {
      const bystander = await joinGame(newClient(server))
      const room = await joinGame(newClient(server))
      const sessionId = room.sessionId

      // 유휴값이 아니라 실제 조작(전진)이 담긴 payload를 같은 주기로
      // 계속 보낸다 — 과잉 수정("move를 전부 무시") 방지용 대조군.
      const stopHeartbeat = startIdleHeartbeat(room, { dirX: 0, dirZ: 1, mode: 'run', jump: false })

      try {
        await waitForCondition(bystander, () => isPlayer(bystander, sessionId), '대조군 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)

        forceAfkRemaining(room, sessionId, IDLE_HEARTBEAT_MARGIN_TICKS)

        // 여유(≈2000ms)를 명백히 지난 뒤에도 여전히 접속 중이어야 한다 —
        // 실제 조작은 지금도, 고쳐진 뒤에도 AFK를 리셋해야 정상이다.
        await sleep(IDLE_HEARTBEAT_SURVIVE_MS)

        expect(isPlayer(bystander, sessionId)).toBe(true)
      } finally {
        stopHeartbeat()
        await Promise.all([leaveRoom(room).catch(() => undefined), leaveRoom(bystander).catch(() => undefined)])
      }
    },
    IDLE_HEARTBEAT_SURVIVE_MS + 10_000,
  )
})
