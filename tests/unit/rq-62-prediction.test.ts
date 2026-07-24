import { describe, expect, it } from 'vitest'
import { stepMovement, type MoveInput, type MoveState } from '@shared/sim/movement'
import {
  createClientPredictor,
  type AuthoritativeMoveState,
  type ClientPredictor,
} from '@client/net/prediction'

/**
 * RQ-62 클라이언트 예측 + 재조정(reconciliation) — 순수 로직 단위 테스트
 * (ADR-0008: 순수 함수, 결정론. fe.md netcode 레이어 "로컬 입력 예측" 책임).
 *
 * 매핑된 골든 케이스: GA-34~36 (`harness/evals/golden/track-a-product.jsonl`).
 * - GA-34: "이동 입력 발생 → 서버 응답 없이 로컬 예측 위치가 즉시 반영된다"
 * - GA-35: "서버 스냅샷(처리된 마지막 입력 시퀀스 포함) 도착 → 그 시퀀스 이전
 *   예측은 서버 값으로 교체되고 이후 미확인 입력은 재생으로 재구성된다 —
 *   입력 중단 후 서버 값에 오차 0 수렴 (ADR-0003 재조정)"
 * - GA-36: "같은 입력 시퀀스에 대해 클라 예측과 서버 시뮬레이션을 각각
 *   실행하면 두 궤적이 일치한다 (shared stepMovement 재사용)"
 *
 * RQ-62 전문: "클라이언트는 자신의 입력을 즉시 로컬에 반영(Client Prediction)
 * 해야 하며, 서버 상태가 도착하면 차이를 조정(reconciliation)해야 한다."
 *
 * **레벨 분리(ADR-0008)**: 이 파일은 예측 모듈 자체의 순수 로직만 다룬다 —
 * Colyseus 룸 경계(서버가 실제로 seq를 어떻게 소비해 스냅샷에
 * `lastProcessedInputSeq`를 반영하는지, 스푸핑 좌표가 여전히 무시되는지)는
 * 별도 통합 테스트(`tests/integration/rq-62-input-sequence-authority.test.ts`)의
 * 책임이다. 그래서 이 파일은 실 서버·colyseus.js·GameState 스키마를 전혀
 * 임포트하지 않는다 — `@shared/sim/movement`(이미 존재)와 이 RQ가 신설하는
 * 예측 모듈만 임포트하는 블랙박스 순수 함수 테스트다.
 *
 * **가정(coder에게 — 이 모듈은 아직 없다. 이 테스트가 계약을 정의한다.
 * `src/shared/sim/movement.ts`가 원장 17e 계약처럼 이미 있던 모듈이 아니라
 * 신규 모듈이므로 `tests/unit/sim-movement.test.ts` 선례와 동일하게
 * test-writer가 shape을 지정한다)**:
 *
 * 배치 위치: `src/client/net/prediction.ts` — `harness/workflow/fe.md`의
 * 레이어 표가 "로컬 입력 예측(RQ-62/63)"을 netcode 레이어(`src/client/net/`)
 * 책임으로 명시하기 때문이다. `src/client/net/connection.ts`(Colyseus 배선,
 * 비순수·비동기)와 달리 이 모듈은 DOM·네트워크에 의존하지 않는 순수 로직이다
 * (node 환경에서 임포트만으로 크래시하지 않아야 한다 — vitest `environment:
 * 'node'`).
 *
 * ```ts
 * // MoveState·MoveInput은 @shared/sim/movement의 기존 7필드 계약을 그대로
 * // 재사용한다(새로 정의하지 않는다 — GA-36 "shared stepMovement 재사용"의
 * // 전제).
 *
 * export interface AuthoritativeMoveState extends MoveState {
 *   // 서버가 처리를 반영한 마지막 입력 시퀀스 번호(ADR-0003). 재조정 시 이
 *   // 값 이하의 로컬 예측·버퍼 입력은 폐기되고, 그보다 큰(미확인) 입력만
 *   // 이 상태 위에서 재생된다.
 *   lastProcessedInputSeq: number
 * }
 *
 * export interface PredictedInput {
 *   seq: number          // 이 입력에 부여된 시퀀스 번호(서버로 함께 전송할 값)
 *   predicted: MoveState // 이 입력을 반영한 직후의 예측 상태(GA-34: 즉시 반영)
 * }
 *
 * export interface ClientPredictor {
 *   // 로컬 입력을 즉시 예측에 반영한다(GA-34). 내부적으로 (1) 시퀀스 번호를
 *   // 부여하고 (2) 그 입력을 버퍼에 쌓아두며(재조정 시 재생 대상) (3) 현재
 *   // 예측 상태에 stepMovement를 적용해 새 예측 상태로 갱신한다.
 *   applyInput(input: MoveInput): PredictedInput
 *
 *   // 서버 스냅샷 도착 시 재조정한다(GA-35, ADR-0003). seq <=
 *   // serverState.lastProcessedInputSeq인 버퍼 입력은 전부 폐기하고,
 *   // serverState(MoveState 부분)를 새 기준값으로 삼은 뒤, 남은(미확인)
 *   // 버퍼 입력을 시퀀스 순서대로 stepMovement로 재생해 예측 상태를
 *   // 재구성한다. 재생할 입력이 없으면(모두 확인됨) 예측은 serverState와
 *   // 완전히 같아진다(오차 0 수렴).
 *   reconcile(serverState: AuthoritativeMoveState): MoveState
 *
 *   // 가장 최근 예측 상태(렌더링·다음 applyInput의 기준값).
 *   getPredictedState(): MoveState
 * }
 *
 * export function createClientPredictor(initialState: MoveState): ClientPredictor
 * ```
 *
 * **시퀀스 번호 규칙**: 1부터 시작해 `applyInput` 호출마다 1씩 증가하는
 * 단조 카운터다. `Math.random()`·`Date.now()` 등 실시간 API에 의존하지
 * 않는 순수 카운터라야 한다(ADR-0008 결정론 — `src/client`는 eslint
 * `no-restricted-properties`가 강제하는 `src/shared`와 달리 도구적으로
 * 막혀 있진 않지만, 예측 로직 자체가 시뮬레이션 코드라는 설계 원칙은
 * 동일하게 적용된다. team-lead 지시).
 *
 * **`stepMovement` 재사용(GA-36)**: 이 모듈은 이동 산술을 독자적으로 다시
 * 구현하지 않고 `@shared/sim/movement`의 `stepMovement`를 그대로 호출해야
 * 한다. 아래 테스트는 이를 스파이·모킹으로 확인하지 않는다 — 구현 방식이
 * 아니라 동작(같은 입력 시퀀스 → 완전히 같은 궤적)만 확인한다. 스파이를
 * 쓰면 "내부적으로 정확히 이 함수를 호출했는가"라는 구현 세부에 결합되어
 * 리팩토링을 막는다.
 *
 * **REV 2026-07-24(RQ-20) 계약과의 정합**: `MoveState`는 이미 7필드
 * (x·y·z·vx·vy·vz·grounded)로 확장되어 "값만으로 완전히 표현되는 스냅샷"
 * 계약을 만족한다(`sim-movement.test.ts` REV 절 참고). 이 예측 모듈의
 * `reconcile`이 요구하는 `AuthoritativeMoveState`는 그 7필드를 그대로
 * 상속해 재사용한다 — 별도의 축약된 필드 집합을 새로 정의하지 않는다.
 *
 * **스코프 밖(과잉 결합 금지 — 이 파일이 테스트하지 않는 것)**:
 * - 실제 Colyseus `GameState`/`Player` 스키마 연동(`vx`·`vy`·`vz`·
 *   `lastProcessedInputSeq` 필드가 와이어에 실제로 존재하는지) — 통합
 *   테스트(`rq-62-input-sequence-authority.test.ts`)의 책임.
 * - `src/client/net/connection.ts`가 이 예측 모듈을 실제로 호출·배선하는지
 *   (room.send로 seq를 실어 보내는지 등) — 이 RQ의 통합 배선 자체가
 *   스코프에 포함되는지는 coder·리뷰 단계 판단(team-lead 지시 참고). 이
 *   단위 테스트는 예측 모듈 자체의 계약만 검증한다.
 * - `src/client/store/gameStore.ts` 연동, 렌더링, 포인터 락·키 입력 캡처
 *   (DOM) — 전부 이 RQ의 스코프 밖이거나 렌더 게이트(fe.md)가 대신한다.
 * - `Player` 스키마에 `grounded` 필드를 실제로 추가할지 여부 — 아래 참고.
 *
 * **참고(보고서에도 기록 — coder·리뷰어가 알아야 할 잠재적 취약점)**:
 * team-lead가 확정한 21a-2 스키마 확장은 `vx`·`vy`·`vz`·
 * `lastProcessedInputSeq` 4개 필드만 추가한다(`grounded`는 포함되지 않음).
 * 이 예측 모듈의 `reconcile`은 `MoveState`의 `grounded` 필드까지 포함한
 * 완전한 7필드를 요구하므로, 실제 `GameState.Player`(x·y·z·vx·vy·vz·
 * lastProcessedInputSeq)로부터 `AuthoritativeMoveState`를 구성하는 배선
 * 코드(coder의 연동 책임)는 `grounded`를 명시 필드 없이 파생시켜야 한다.
 * 현재 `@shared/sim/movement`의 구현(`groundedOutcome`이 항상 y=0을 쓰고
 * `airborneOutcome`은 height>0일 때만 grounded=false를 반환)에서는
 * `grounded === (y === 0)`이 항상 성립하므로 이 파생은 **오늘 기준으로는
 * 안전**하다 — 하지만 이는 movement.ts 내부 구현에 대한 암묵적 의존이며,
 * RQ-20 REV 2026-07-24가 경계했던 "상태는 값으로 완전히 표현돼야 한다"는
 * 원칙(은닉 상태 금지)과 정확히 같은 종류의 리스크다. 이 파일은 그 파생을
 * 강제하거나 금지하지 않는다(스키마 결정은 이미 21a-2에서 확정됐고, 이
 * 파일이 재론할 권한 밖이다) — 다만 이 취약점을 기록해 향후 movement.ts가
 * 바뀔 때 조용히 깨지지 않도록 남긴다.
 */

function createGroundedState(): MoveState {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true }
}

describe('RQ-62 클라이언트 예측 — GA-34: 로컬 입력 즉시 반영(서버 응답 대기 없음)', () => {
  it('RQ-62/GA-34: 입력을 적용하면 서버 응답 없이 즉시 예측 위치가 stepMovement 결과와 동일하게 반영된다', () => {
    const initial = createGroundedState()
    const predictor: ClientPredictor = createClientPredictor(initial)
    const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
    const expected = stepMovement(initial, input)

    const { predicted } = predictor.applyInput(input)

    expect(predicted).toEqual(expected)
    expect(predictor.getPredictedState()).toEqual(expected)
  })

  it('RQ-62/GA-34: 연속 입력마다 매번 동기적으로 예측이 즉시 갱신된다(폴링·대기 없이 매 호출 직후 확인)', () => {
    const predictor: ClientPredictor = createClientPredictor(createGroundedState())
    const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }

    let expected = createGroundedState()
    for (let i = 0; i < 5; i += 1) {
      expected = stepMovement(expected, input)
      const { predicted } = predictor.applyInput(input)
      expect(predicted).toEqual(expected)
      expect(predictor.getPredictedState()).toEqual(expected)
    }
  })

  it('RQ-62/ADR-0003: 입력마다 시퀀스 번호가 1부터 단조 증가로 부여된다(재조정이 식별할 수 있어야 한다)', () => {
    const predictor: ClientPredictor = createClientPredictor(createGroundedState())
    const input: MoveInput = { dirX: 0, dirZ: 0, mode: 'run', jump: false }

    const seqs = [
      predictor.applyInput(input).seq,
      predictor.applyInput(input).seq,
      predictor.applyInput(input).seq,
    ]

    expect(seqs).toEqual([1, 2, 3])
  })
})

describe('RQ-62 클라이언트 예측 — GA-36: 클라 예측 궤적과 서버 시뮬레이션 궤적이 일치한다(shared stepMovement 재사용)', () => {
  it('RQ-62/GA-36: 같은 입력 시퀀스를 적용하면 예측 모듈의 최종 상태가 stepMovement를 직접 반복 호출한 결과와 완전히 같다', () => {
    const inputs: MoveInput[] = [
      { dirX: 1, dirZ: 0, mode: 'run', jump: false },
      { dirX: 0, dirZ: 1, mode: 'walk', jump: false },
      { dirX: -1, dirZ: 0, mode: 'crouch', jump: false },
      { dirX: 0, dirZ: 0, mode: 'run', jump: true }, // 점프 포함 — 공중 상태(vy 등) 궤적까지 확인
      { dirX: 1, dirZ: 0, mode: 'run', jump: false },
    ]

    const predictor: ClientPredictor = createClientPredictor(createGroundedState())
    // "서버" 역할 — 예측 모듈과 독립적으로 같은 입력을 stepMovement로 직접 재생한다.
    let serverState = createGroundedState()

    for (const input of inputs) {
      predictor.applyInput(input)
      serverState = stepMovement(serverState, input)
    }

    expect(predictor.getPredictedState()).toEqual(serverState)
  })

  it('RQ-62/GA-36: 중간 궤적(각 스텝)도 서버 시뮬레이션과 일치한다 — 최종값만 우연히 같아지는 구현을 배제한다', () => {
    const inputs: MoveInput[] = [
      { dirX: 1, dirZ: 0, mode: 'run', jump: false },
      { dirX: 1, dirZ: 0, mode: 'run', jump: true },
      { dirX: -1, dirZ: 1, mode: 'run', jump: false },
      { dirX: -1, dirZ: 1, mode: 'run', jump: false },
    ]

    const predictor: ClientPredictor = createClientPredictor(createGroundedState())
    let serverState = createGroundedState()

    for (const input of inputs) {
      const { predicted } = predictor.applyInput(input)
      serverState = stepMovement(serverState, input)
      expect(predicted).toEqual(serverState)
    }
  })
})

/**
 * GA-35 재조정 시나리오 준비물. 클라는 4개 입력(seq 1~4)을 전부 낙관적으로
 * 즉시 반영했지만(GA-34), seq 2(input2)는 서버에 도달하지 못했다고
 * 가정한다(네트워크 유실). 서버는 자신이 실제로 받은 입력만으로 독자
 * 시뮬레이션했으므로(seq2를 건너뛰고 seq1의 입력을 한 틱 더 유지 — 서버
 * 측 "최근 수신 입력을 다음 입력이 올 때까지 유지" 모델, `GameRoom`의
 * 실제 pendingInputs 동작과 동일한 정신) 클라의 낙관적 예측과 다른 값에
 * 도달한다.
 *
 * 이 어긋남이 반드시 있어야 재조정(서버 기준으로 교체)이 실제로 "무언가를
 * 고친다"는 것을 증명할 수 있다 — 어긋남이 없으면 재생 결과가 우연히
 * 원래 로컬 예측과 같아져서, 재조정 로직이 실제로 동작하는지 아니면
 * 그냥 기존 값을 그대로 둔 것인지 테스트로 구분할 수 없다.
 *
 * seq 4(input4)는 이 시나리오에서 서버가 "아직" 처리하지 못한 미확인
 * 입력으로 남는다 — 재생(replay) 대상이다.
 */
function buildLostPacketScenario(): {
  predictor: ClientPredictor
  serverStateAfterSeq3: MoveState
  input4: MoveInput
} {
  const initial = createGroundedState()
  const input1: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
  const input2: MoveInput = { dirX: 0, dirZ: 1, mode: 'run', jump: false } // 서버에 도달하지 못한다(유실)
  const input3: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
  const input4: MoveInput = { dirX: 0, dirZ: -1, mode: 'run', jump: false } // 아직 서버 미확인

  const predictor: ClientPredictor = createClientPredictor(initial)
  predictor.applyInput(input1) // seq 1
  predictor.applyInput(input2) // seq 2 — 서버에는 끝내 도달하지 않는다
  predictor.applyInput(input3) // seq 3
  predictor.applyInput(input4) // seq 4 — 스냅샷 도착 시점에 아직 미확인

  // 서버의 실제 궤적을 예측 모듈과 독립적으로 재현한다: seq2가 유실됐으므로
  // input1을 한 틱 더 유지하고(연속 재적용 모델), 다음으로 실제 도달한
  // input3을 적용한다.
  let serverState = stepMovement(initial, input1) // 서버 틱1: input1
  serverState = stepMovement(serverState, input1) // 서버 틱2: input2 유실 → input1 유지
  serverState = stepMovement(serverState, input3) // 서버 틱3: input3 도달

  return { predictor, serverStateAfterSeq3: serverState, input4 }
}

describe('RQ-62 클라이언트 예측 — GA-35: 재조정(reconciliation) + 미확인 입력 재생', () => {
  it('RQ-62/GA-35/ADR-0003: 서버 스냅샷 도착 시 처리된 시퀀스(seq 3) 이전 예측은 서버 값으로 교체되고, 미확인 입력(seq 4)은 그 기준값 위에서 재생된다', () => {
    const { predictor, serverStateAfterSeq3, input4 } = buildLostPacketScenario()
    const expectedAfterReplay = stepMovement(serverStateAfterSeq3, input4)

    // 전제 확인 — 재조정 전 클라의 낙관적 예측(input2 유실을 몰랐다)은 서버
    // 기준으로 교정된 결과와 다르다. 다르지 않으면 이 테스트가 재조정의
    // 효과를 증명하지 못한다(우연의 일치와 구분 불가).
    expect(predictor.getPredictedState()).not.toEqual(expectedAfterReplay)

    const serverSnapshot: AuthoritativeMoveState = { ...serverStateAfterSeq3, lastProcessedInputSeq: 3 }
    const reconciled = predictor.reconcile(serverSnapshot)

    expect(reconciled).toEqual(expectedAfterReplay)
    expect(predictor.getPredictedState()).toEqual(expectedAfterReplay)
  })

  it('RQ-62/GA-35: 입력 중단 후 서버가 마지막 입력(seq 4)까지 따라잡으면, 예측은 서버 값과 완전히 일치한다(오차 0 수렴)', () => {
    const { predictor, serverStateAfterSeq3, input4 } = buildLostPacketScenario()
    const firstSnapshot: AuthoritativeMoveState = { ...serverStateAfterSeq3, lastProcessedInputSeq: 3 }
    predictor.reconcile(firstSnapshot) // 1차 재조정 — seq 4는 아직 미확인으로 남는다

    // 서버가 이후 input4까지 정상적으로(유실 없이) 반영했다고 가정한다 —
    // 클라가 1차 재조정에서 이미 재생한 것과 같은 입력이므로, 서버·클라
    // 모두 stepMovement로 같은 결과에 도달해야 한다(GA-36과 같은 정신).
    const serverStateAfterSeq4 = stepMovement(serverStateAfterSeq3, input4)
    const secondSnapshot: AuthoritativeMoveState = { ...serverStateAfterSeq4, lastProcessedInputSeq: 4 }

    // 입력 중단 — 이 시점 이후 predictor.applyInput을 더 호출하지 않는다.
    const reconciled = predictor.reconcile(secondSnapshot)

    // 오차 0: seq 4까지 전부 lastProcessedInputSeq 이하이므로 재생할 미확인
    // 입력이 남지 않는다 — 예측은 서버 값과 완전히 같아야 한다.
    expect(reconciled).toEqual(serverStateAfterSeq4)
    expect(predictor.getPredictedState()).toEqual(serverStateAfterSeq4)
  })

  it('RQ-62/GA-35: 재조정 시점에 미확인 입력이 전혀 없으면(모두 확인됨) 예측은 서버 값을 그대로 채택한다', () => {
    const initial = createGroundedState()
    const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
    const predictor: ClientPredictor = createClientPredictor(initial)

    predictor.applyInput(input) // seq 1
    predictor.applyInput(input) // seq 2

    const serverState = stepMovement(stepMovement(initial, input), input)
    const snapshot: AuthoritativeMoveState = { ...serverState, lastProcessedInputSeq: 2 }

    const reconciled = predictor.reconcile(snapshot)

    expect(reconciled).toEqual(serverState)
    expect(predictor.getPredictedState()).toEqual(serverState)
  })
})
