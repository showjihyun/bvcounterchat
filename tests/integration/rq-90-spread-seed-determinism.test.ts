import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { applySpread, eyeOrigin, raycastHitbox, type Vec3 } from '@shared/sim/combat'
import { createRng } from '@shared/sim/rng'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'

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
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * 허용 예외, `rq-12`와 동일). 모든 대기에 `withTimeout()` 상한을 건다.
 * hp 변화 관측은 `onStateChange` 이벤트 기반 폴링(고정 슬립 아님)이고,
 * "변화 없음"(오라클 'miss' 예측·(B)) 확인만 예외적으로 고정 슬립 뒤 값을
 * 읽는다(그 자체가 확인 대상이라 이벤트 기반 대기가 부적합 — `rq-12`의
 * "무관한 방향" 테스트와 동일한 필요성). 오프라인 오라클(`classifySpreadSeed`)
 * 은 순수 산술이라 실행마다 항상 같은 답을 낸다(플레이키 아님).
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

/** GA-06/GA-08/`rq-12`와 동일한 근거로 기하학적으로 항상 빗나가는 방향
 * (수직 위) — B가 자기 자신의 최초 입장 스폰 보호를 즉시 해제하는 용도로만
 * 쓴다(RQ-16 "사격하면 즉시 해제"). */
const UP_MISS_AIM = { dirX: 0, dirY: 1, dirZ: 0 }

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
/** 리뷰 blocker(2) 재현 — 조준 벡터를 이 배율만큼 부풀려 보낸다. 콘 반경이
 * 0이 아닐 때 `v = cross(direction, u)`가 정규화되지 않아 크기가
 * `|direction|`이 되므로(계약 위반), 벡터를 부풀리면 편차 분포가 왜곡된다
 * — 리뷰가 실측한 배율(1000)과 동일하게 맞췄다. */
const OVERSIZED_AIM_SCALE = 1000

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
 * 이 필드들도 당연히 없었다). `magazines`·`moveStates`는 그린필드가 아니다
 * — `AfkTestSeam`(`rq-43-afk-kick.test.ts`)이 `magazines`를, `FallDamageTestSeam`
 * (`rq-18-fall-damage.test.ts`)·`rq-92-fall-damage-curve.test.ts`가
 * `moveStates`를 이미 이 정확한 이름으로 화이트박스 접근하는 기존 private
 * 필드다. `magazines`는 F1 수정(§"오라클 일치 열" 참고)이 한 세션에서
 * 26발을 쏘아야 해서 RQ-10/11의 재장전(2초) 대기를 이 파일의 관심사로
 * 끌어들이지 않기 위해 미리 채운다. `moveStates`는 리뷰 blocker 재현
 * (§"REV(리뷰 blocker 재현)" 참고)이 자연 스폰 좌표로는 우연히 만들 수
 * 없는 정확한 퇴화 기하(사수·피격자가 같은 z, 같은 높이)를 직접 배치하는
 * 데 쓴다. */
interface SpreadTestSeam {
  spreadTuningOverride?: { coneRadiusRad: number }
  forcedSpreadSeed?: number
  magazines: Map<string, number>
  moveStates: Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number; grounded: boolean }>
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

      // RQ-16: B 자신의 최초 입장 스폰 보호를 즉시 해제(`rq-12`와 동일 패턴)
      // — 해제하지 않으면 아래 사격이 전부 무효화되어 스프레드 여부와
      // 무관하게 hp가 그대로일 것이다(공허함의 또 다른 경로).
      roomB.send('fire', UP_MISS_AIM)
      await sleep(SHOT_GAP_MS)

      const origin = eyeOrigin({ x: baselineA.x, y: baselineA.y, z: baselineA.z }, DEFAULT_HITBOX.eyeHeightM)
      const targetFoot: Vec3 = { x: baselineB.x, y: baselineB.y, z: baselineB.z }
      const { aim, distance } = aimAtBodyWithDistance(baselineA, baselineB)

      const coneRadiusRad = Math.atan(DEFAULT_HITBOX.bodyRadiusM / distance) * SPREAD_CONE_MULTIPLIER
      const seedMiss = findSeedWithBucket(origin, aim, targetFoot, coneRadiusRad, 'miss', SEARCH_LIMIT)

      const seam = getServerRoom(roomA)
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
      const afterSecond = { hp: hpAfterPass2 }
      expect(afterSecond.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY * 2) // 2 pass 합쳐 바디 명중 정확히 2회 — 기존 (B)/(C) 기준값과 동일

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
      expect(afterDifferentSeed?.hp).toBe(afterSecond.hp) // 변화 없음 — 실제로 빗나갔다(다른 시드 -> 다른 결과)

      await sleep(SHOT_GAP_MS)

      // --- (C) 구조 확인(양성, 부록) — 같은(빗나가는) `seedMiss`를 유지한
      // 채 콘 반경만 0(출하 기본값)으로 되돌리면, `applySpread`의 계약
      // (coneRadiusRad===0 -> 편차 없음, `tests/unit/sim-combat.test.ts`가
      // 이미 고정)에 따라 다시 정조준 명중이어야 한다 — 콘 반경 오버라이드
      // 자체가 실제로 스프레드를 켜고 끈다는 것을 보여준다(우연한 seed
      // 궁합이 아니라).
      seam.spreadTuningOverride = { coneRadiusRad: 0 }
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      const afterRadiusZero = await waitForHpChange(roomB, roomB.sessionId, afterSecond.hp, 'RQ-90 콘 반경 0 복귀 후 hp 변화 대기')
      expect(afterRadiusZero.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY * 3) // 50 -> 25, 다시 명중

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    60_000, // F1 수정 이후 26발(12*2 + 2) — 이전(30_000ms, 4발)보다 넉넉히 늘렸다.
  )

  it(
    'RQ-90 리뷰 blocker 재현: handleFire가 정규화되지 않은 클라 조준 벡터를 applySpread에 그대로 넘겨, (1) 콘 반경 0에서도 특정 방향에서 NaN으로 확정 미스가 나고 (2) 콘 반경이 0이 아니면 벡터 크기가 편차 분포를 왜곡한다',
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수
      const roomB = await joinGame(newClient(server)) // 피격자

      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      // RQ-16: B 자신의 최초 입장 스폰 보호를 즉시 해제.
      roomB.send('fire', UP_MISS_AIM)
      await sleep(SHOT_GAP_MS)

      const seam = getServerRoom(roomA)
      // 이 `it()`은 이전 `it()`이 룸에 남긴 상태(`spreadTuningOverride`·
      // `forcedSpreadSeed`)에 기대지 않는다 — 자기 완결적으로 명시한다.
      seam.spreadTuningOverride = { coneRadiusRad: 0 } // (1)은 출하 기본값(반경 0)에서도 재현된다.

      // --- (1) NaN 회귀 — 화이트박스로 B를 A와 정확히 같은 z·같은 높이,
      // +X로 `DEGENERATE_DISTANCE`만큼 떨어진 지점에 배치한다(자연 스폰
      // 좌표는 이 정확한 퇴화 조건을 우연히 만족하지 않는다). `handleFire`
      // 의 대상 후보 위치는 `moveStates`를 동기적으로 읽으므로(되감기
      // 버퍼가 비어 있으면 즉시 반영) 틱 경과를 기다릴 필요가 없다.
      seam.moveStates.set(roomB.sessionId, {
        x: baselineA.x + DEGENERATE_DISTANCE,
        y: baselineA.y,
        z: baselineA.z,
        vx: 0,
        vy: 0,
        vz: 0,
        grounded: true,
      })

      // 사전 확인(오프라인, 네트워크 없음) — 이 기하에서 "정규화된" 방향은
      // 실제로 헤드에 명중해야 한다(그렇지 않다면 아래 실패가 이 blocker가
      // 아니라 테스트 기하 자체의 결함일 수 있다).
      const origin1 = eyeOrigin({ x: baselineA.x, y: baselineA.y, z: baselineA.z }, DEFAULT_HITBOX.eyeHeightM)
      const targetFoot1: Vec3 = { x: baselineA.x + DEGENERATE_DISTANCE, y: baselineA.y, z: baselineA.z }
      const normalizedDegenerateAim: Vec3 = { x: 1, y: 0, z: 0 }
      const sanityResult = raycastHitbox({ origin: origin1, direction: normalizedDegenerateAim }, { position: targetFoot1 }, DEFAULT_HITBOX)
      if (!sanityResult.hit || sanityResult.region !== 'head') {
        throw new Error(
          `RQ-90 리뷰 blocker 재현 셋업 실패 — 정규화된 방향 (1,0,0)이 이 기하에서 헤드에 명중해야 하는데 실제로는 ${JSON.stringify(sanityResult)}였다(DEGENERATE_DISTANCE 조정 필요).`,
        )
      }

      // 퇴화 벡터(단위가 아님, |dirX|=0.5<0.9 → helper={1,0,0} → cross=0
      // → NaN) — 정규화됐다면(위 사전 확인) 헤드에 명중해 데미지가
      // 줄어야 한다. **이 단언이 오늘 Red다**: 실제로는 NaN이 전파돼
      // `raycastHitbox`가 걸러 무조건 빗나가고, hp가 그대로다.
      const hpBeforeDegenerate = baselineB.hp
      roomA.send('fire', { dirX: 0.5, dirY: 0, dirZ: 0 })
      await sleep(SHOT_GAP_MS)
      const afterDegenerate = readPlayer(roomB, roomB.sessionId)
      expect(afterDegenerate?.hp).toBe(hpBeforeDegenerate - WEAPON.DAMAGE_BODY * WEAPON.HEADSHOT_MULTIPLIER)

      await sleep(SHOT_GAP_MS)

      // 대조군(양성) — 같은 방향의 단위 벡터(|dirX|=1>=0.9 → helper=
      // {0,1,0} → 퇴화 아님)는 이 리뷰 blocker와 무관하게 이전에도 정상
      // 동작했다. 이 단언이 실패하면 기하 자체가 잘못된 것이지 blocker와
      // 무관하다 — (1)의 실패가 "빗나가는 기하" 때문이 아니라 진짜
      // NaN 회귀 때문임을 보증한다. hp는 (1)의 실제 결과와 무관하게
      // "직전 관측값에서 정확히 헤드 데미지만큼" 줄어야 하므로 절대값이
      // 아니라 직전 관측값 기준으로 단언한다.
      const hpBeforeUnitControl = afterDegenerate?.hp ?? hpBeforeDegenerate
      roomA.send('fire', { dirX: 1, dirY: 0, dirZ: 0 })
      await sleep(SHOT_GAP_MS)
      const afterUnitControl = readPlayer(roomB, roomB.sessionId)
      expect(afterUnitControl?.hp).toBe(hpBeforeUnitControl - WEAPON.DAMAGE_BODY * WEAPON.HEADSHOT_MULTIPLIER)

      await sleep(SHOT_GAP_MS)

      // --- (2) 벡터 크기가 콘 형태를 왜곡 — 콘 반경을 0이 아닌 값으로
      // 주입한다(반경 0에서는 이 결함이 관측 불가, 리뷰 minor 2와 동일
      // 트리거). B는 (1)에서 배치한 위치(A + DEGENERATE_DISTANCE·X)를
      // 그대로 유지한다 — 좌표는 실측값을 그대로 재사용하므로 하드코딩이
      // 아니다.
      const currentB = readPlayer(roomB, roomB.sessionId)
      if (!currentB) throw new Error('RQ-90 리뷰 blocker 재현 — (2) 시작 전 B 상태 관측 실패')
      const origin2 = origin1 // A는 이동하지 않았다.
      const targetFoot2: Vec3 = { x: currentB.x, y: currentB.y, z: currentB.z }
      const { aim: aim2, distance: distance2 } = aimAtBodyWithDistance(baselineA, currentB)
      const coneRadiusRad2 = Math.atan(DEFAULT_HITBOX.bodyRadiusM / distance2) * SPREAD_CONE_MULTIPLIER
      // 오프라인 오라클 — "정규화된(단위) 벡터라면 반드시 빗나간다"로
      // 분류한 시드를 찾는다. 실제로 보낼 때는 이 벡터를
      // `OVERSIZED_AIM_SCALE`배로 부풀린다 — 정규화됐다면(계약대로) 결과가
      // 같아야 하므로, 부풀린 벡터도 여전히 빗나가야 한다.
      const seedForScaleTest = findSeedWithBucket(origin2, aim2, targetFoot2, coneRadiusRad2, 'miss', SEARCH_LIMIT)

      seam.spreadTuningOverride = { coneRadiusRad: coneRadiusRad2 }
      seam.forcedSpreadSeed = seedForScaleTest

      const hpBeforeOversized = currentB.hp
      roomA.send('fire', {
        dirX: aim2.x * OVERSIZED_AIM_SCALE,
        dirY: aim2.y * OVERSIZED_AIM_SCALE,
        dirZ: aim2.z * OVERSIZED_AIM_SCALE,
      })
      await sleep(SHOT_GAP_MS)
      const afterOversized = readPlayer(roomB, roomB.sessionId)
      // **이 단언도 오늘 Red다**: 오프라인 오라클(단위 벡터 기준)은
      // '빗나감'을 예측했지만, 벡터 크기가 실제 콘 모양을 왜곡해 명중으로
      // 뒤집힐 수 있다(이 정확한 시드·기하 조합에서 사전에 확인됨,
      // `_workspace/RQ-90/07_test-writer_blocker-red.md` §2 참고) — hp가
      // 오라클 예측대로 그대로여야 한다.
      expect(afterOversized?.hp).toBe(hpBeforeOversized)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    30_000,
  )
})
