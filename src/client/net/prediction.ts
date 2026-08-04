import { stepMovement, type MoveInput, type MoveState } from '@shared/sim/movement'
import { PRODUCTION_GEOMETRY } from '@shared/sim/geometry'

/**
 * RQ-62 클라이언트 예측 + 재조정(reconciliation) — 순수 로직 (ADR-0003 입력
 * 커맨드 버퍼, ADR-0008 결정론). `harness/workflow/fe.md`의 레이어 표가
 * "로컬 입력 예측(RQ-62/63)"을 netcode 레이어(`src/client/net/`) 책임으로
 * 명시하는 배치를 따른다.
 *
 * 이 모듈은 DOM·네트워크·실시간 API에 의존하지 않는다 — 시퀀스 번호는
 * `applyInput` 호출마다 1씩 증가하는 순수 카운터다(`Math.random()`·
 * `Date.now()` 등을 쓰지 않는다).
 *
 * 상세 계약·설계 근거는 `tests/unit/rq-62-prediction.test.ts` 상단 주석과
 * `_workspace/RQ-62/01_test-writer_red.md` §2를 참고.
 *
 * **REV(독립 평가 FAIL F3 대응, 원장 25a-2·25a-4) — `stepMovement` 호출
 * 두 곳(`applyInput`·`reconcile`의 재생 루프) 모두 `@shared/sim/geometry`의
 * `PRODUCTION_GEOMETRY`를 세 번째 인자로 주입한다.** RQ-30 벽 도입 전에는
 * 서버·클라 양쪽이 벽 없는 세계를 시뮬레이션해 일치했으나, 서버
 * (`GameRoom.ts`)만 벽을 주입하고 클라가 계속 구 계약 호출을 쓰면 예측이
 * 벽 앞에서 서버와 어긋나 재조정마다 수렴하지 않는 발산(고무줄 현상)이
 * 생긴다(RQ-61 서버 권위 위반은 아니다 — 최종 값은 항상 서버가 이긴다 —
 * 하지만 RQ-62 예측의 목적 자체가 깨진다). RQ-22 박스 점프도 같은 종류의
 * 결함이었다 — 서버만 박스를 보고 클라가 박스 없는 세계를 예측하면, 박스
 * 위에 선 플레이어를 클라가 계속 낙하시키다가 서버 스냅샷이 도착할 때마다
 * 다시 박스 높이로 되돌아가는 발산이 생긴다.
 *
 * **원장 25a-5(RQ-21 동시 회수) — 지오메트리 주입이 단일 값 계약으로
 * 바뀌었다.** 벽·박스를 세 번째·네 번째 위치 인자로 각각 주입하던 방식은
 * 하나를 빠뜨려도 타입이 통과해 위 발산이 이미 두 번 재발했다(25a-2 F3
 * 벽 · 25a-4 박스) — 사다리(RQ-21)를 세 번째 지오메트리 종류로 얹으며,
 * 위치 인자를 늘리는 대신 `StaticGeometry` 단일 객체(`@shared/sim
 * /movement`)로 묶었다. `@shared/sim/walls`·`@shared/sim/boxes`·
 * `@shared/sim/ladders`의 정본을 그대로 참조하므로 좌표 리터럴 복제가
 * 아니다(ADR-0010). `.glb` 확정으로 각 정본의 출처가 바뀌어도 이 파일은
 * 손대지 않아도 된다.
 */

export interface AuthoritativeMoveState extends MoveState {
  /** 서버가 처리를 반영한 마지막 입력 시퀀스 번호(ADR-0003). 재조정 시 이
   * 값 이하의 로컬 예측·버퍼 입력은 폐기되고, 그보다 큰(미확인) 입력만
   * 이 상태 위에서 재생된다. */
  lastProcessedInputSeq: number
}

export interface PredictedInput {
  /** 이 입력에 부여된 시퀀스 번호(서버로 함께 전송할 값). */
  seq: number
  /** 이 입력을 반영한 직후의 예측 상태(GA-34: 즉시 반영). */
  predicted: MoveState
}

export interface ClientPredictor {
  /** 로컬 입력을 즉시 예측에 반영한다(GA-34). */
  applyInput(input: MoveInput): PredictedInput
  /** 서버 스냅샷 도착 시 재조정한다(GA-35, ADR-0003). */
  reconcile(serverState: AuthoritativeMoveState): MoveState
  /** 가장 최근 예측 상태(렌더링·다음 applyInput의 기준값). */
  getPredictedState(): MoveState
}

interface BufferedInput {
  seq: number
  input: MoveInput
}

/** 미확인 입력 버퍼 상한(리뷰 minor 대응, `_workspace/review/feat-RQ-62-
 * client-prediction.md` "후속 이슈 권고"). 클라이언트가 서버 틱 레이트
 * (30Hz, `NET.TICK_HZ`)와 동일한 주기로 입력을 보낸다는 ADR-0003 전제
 * 하에 약 3.3초 분량이다 — 정상 왕복(수 틱)보다 훨씬 넉넉해 정상 플레이
 * 중 오탐(정당한 미확인 입력이 드롭됨) 위험이 없고, 스냅샷 기아(소켓은
 * 살아 있으나 패치가 오래 끊기는 병적 상황)에서도 재생 비용과 메모리를
 * 유한하게 묶는다. */
const BUFFER_CAP = 100

/** `AuthoritativeMoveState`에서 `lastProcessedInputSeq`를 뺀 순수
 * `MoveState` 부분만 뽑는다 — 재조정의 새 기준값이 된다. */
function toMoveState(state: AuthoritativeMoveState): MoveState {
  return {
    x: state.x,
    y: state.y,
    z: state.z,
    vx: state.vx,
    vy: state.vy,
    vz: state.vz,
    grounded: state.grounded,
  }
}

export function createClientPredictor(initialState: MoveState): ClientPredictor {
  let predicted: MoveState = initialState
  let nextSeq = 1
  let buffer: BufferedInput[] = []

  return {
    applyInput(input: MoveInput): PredictedInput {
      const seq = nextSeq
      nextSeq += 1
      buffer.push({ seq, input })
      // 상한 초과 시 가장 오래된(가장 작은 seq) 항목부터 드롭한다(스냅샷
      // 기아 시 무한 성장 방지) — buffer는 항상 seq 오름차순이라 맨 앞이
      // 가장 오래된 항목이다.
      if (buffer.length > BUFFER_CAP) {
        buffer.shift()
      }
      predicted = stepMovement(predicted, input, PRODUCTION_GEOMETRY)
      return { seq, predicted }
    },

    reconcile(serverState: AuthoritativeMoveState): MoveState {
      // seq <= lastProcessedInputSeq인 버퍼 입력은 서버가 이미 반영했으므로
      // 폐기하고, 남은(미확인) 입력만 새 기준값 위에서 재생한다.
      buffer = buffer.filter((entry) => entry.seq > serverState.lastProcessedInputSeq)

      let state = toMoveState(serverState)
      for (const entry of buffer) {
        state = stepMovement(state, entry.input, PRODUCTION_GEOMETRY)
      }

      predicted = state
      return state
    },

    getPredictedState(): MoveState {
      return predicted
    },
  }
}
