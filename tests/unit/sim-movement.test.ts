import { describe, expect, it } from 'vitest'
import { stepMovement, type MoveInput, type MoveState } from '@shared/sim/movement'
import { MOVEMENT, NET } from '@shared/constants'

/**
 * RQ-20 이동 — 평지 순수 산술 단위 테스트 (ADR-0008: 순수 함수, 결정론).
 *
 * 매핑된 골든 케이스: GA-30~32 (`harness/evals/golden/track-a-product.jsonl`).
 * RQ-20 전문: "시스템은 걷기·달리기·점프·앉기·천천히 걷기(조용한 이동)를
 * 지원해야 한다. 앉기와 천천히 걷기는 이동 속도를 감소시켜야 한다."
 * RQ-92(수치): 기본 6m/s · 앉기 50%(3m/s) · 천천히 걷기 70%(4.2m/s) ·
 * 점프 높이 1.0m · 공중 가속 미허용.
 *
 * **범위(오케스트레이터·team-lead 지시)**: Rapier 없음. 지면 y=0의 평지
 * 순수 산술만 다룬다. 사다리(RQ-21)·박스(RQ-22)·낙하 데미지(RQ-18)는
 * 스코프 밖 — 이 파일에서 테스트하지 않는다. 클라이언트 좌표 스푸핑 무시
 * (RQ-61, GA-33)는 통합 레벨이라 별도 파일
 * (`tests/integration/rq-20-movement-authority.test.ts`)이 맡는다.
 *
 * **가정(coder에게 — 이 shape으로 구현할 것. `src/shared/sim/movement.ts`는
 * 원장 17e 계약에 없는 신규 모듈이라 test-writer가 지정한다)**:
 *
 * ```ts
 * export interface MoveState {
 *   x: number; y: number; z: number
 *   vy: number       // 수직 속도(m/s, 상승 +) — 중력 적용 대상
 *   grounded: boolean
 * }
 * export interface MoveInput {
 *   dirX: number; dirZ: number  // 정규화된 수평 방향(단위 벡터), 무입력은 0
 *   mode: 'run' | 'walk' | 'crouch'
 *   jump: boolean                // 이번 틱의 점프 시도(엣지 트리거)
 * }
 * export function stepMovement(state: MoveState, input: MoveInput): MoveState
 * ```
 *
 * `stepMovement`는 **정확히 1틱(`NET.TICK_MS`) 전진**한다 — clock/scheduler
 * (원장 17e 계약)와 동일하게, 벌크가 아니라 틱 단위 호출을 반복하는 것이
 * 호출자(서버 틱 루프·이 테스트) 책임이다.
 *
 * **mode 매핑(왜 3종뿐인가)**: RQ-92는 "기본 이동 속도" 하나만 정하고
 * 걷기·달리기를 별도 수치로 구분하지 않는다(interview 질문 5 답변 — 표에
 * "기본 이동 속도" 항목이 하나뿐이다). 따라서 `mode: 'run'`이 걷기·달리기
 * 공통의 기본 6m/s를 담당하고, `'walk'`는 RQ-20 원문의 "천천히 걷기(조용한
 * 이동)"(4.2m/s, GA-31), `'crouch'`는 "앉기"(3m/s, GA-31)에 대응한다 —
 * `'walk'`라는 이름이 흔히 연상시키는 "보통 걷기"가 아니라 "천천히 걷기"란
 * 점에 주의(오케스트레이터가 지정한 이름 그대로 사용).
 *
 * **점프 궤적 유도(오케스트레이터 지시)**: 중력·초기 수직 속도는 코드
 * 상수가 아니라 `MOVEMENT.JUMP_HEIGHT`(1.0m)로부터 구현이 역산한다 —
 * 도달 높이만 스펙이 정하므로 구체적 중력값·소요 시간은 구현 자유다. 이
 * 파일은 그래서 특정 틱 수(예: "N틱째에 최고점")에 결합하지 않고 "언젠가
 * 최고점 ≈1.0m", "언젠가 y=0·grounded로 복귀"만 단언한다.
 *
 * **결정론·환경 중립**: 이 모듈은 `src/shared/sim/`에 위치하므로
 * ADR-0008/ADR-0010 lint 대상이다 — `Math.random()`·`Date.now()`·실타이머
 * 직접 호출 금지(`harness/sim/README.md` 제약과 동일). 순수 산술이라
 * 난수·시간이 아예 필요 없지만, 아래 "결정론" 테스트로 "같은 입력 → 같은
 * 출력"을 직접 확인한다.
 */

function createGroundedState(): MoveState {
  return { x: 0, y: 0, z: 0, vy: 0, grounded: true }
}

/** input을 유지한 채 n틱 전진시킨 최종 상태. */
function runTicks(input: MoveInput, ticks: number, initial: MoveState = createGroundedState()): MoveState {
  let state = initial
  for (let i = 0; i < ticks; i += 1) {
    state = stepMovement(state, input)
  }
  return state
}

/**
 * N틱 동안 유지 이동 시 이론적 총 변위(m) — "총 경과시간 기반" 계산이다.
 * 틱마다 `speed * NET.TICK_MS / 1000`을 단순 합산하는 구현과 비교했을 때
 * 실질적 드리프트가 없음을 실측 확인했다(2026-07-24, node): 100틱 합산
 * 차이는 약 4e-14 — `tickDriver`의 올림/내림 경계 로직과 달리 이 계산은
 * 단순 반복 덧셈이라 부동소수점 오차가 무시 가능한 수준이다. 그래서 아래
 * 단언은 `toBeCloseTo(..., 3)`(공차 5e-4m)처럼 여유 있게 잡는다 —
 * 오케스트레이터 지시대로 "과도한 정밀도(1e-12)"는 걸지 않는다.
 */
function expectedDistance(speed: number, ticks: number): number {
  return speed * ((ticks * NET.TICK_MS) / 1000)
}

describe('RQ-20 이동 — 평지 순수 산술 (GA-30~32)', () => {
  /** N틱 동안 방향 입력을 유지 — GA-30/31의 "N틱 동안 유지된다"에 대응. */
  const TICKS = 100

  describe('GA-30: 달리기(run) — 위치 변화량이 정확히 6m/s × 경과시간이다', () => {
    it('RQ-20/GA-30: 정면 방향(dirX=1)으로 달리면 변위가 SPEED × 경과시간과 같다', () => {
      const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
      const state = runTicks(input, TICKS)

      expect(state.x).toBeCloseTo(expectedDistance(MOVEMENT.SPEED, TICKS), 3)
      expect(state.z).toBeCloseTo(0, 6)
      expect(state.y).toBeCloseTo(0, 6)
      expect(state.grounded).toBe(true)
    })

    it('RQ-20/GA-30: 대각(정규화된) 방향으로 달려도 변위의 크기(magnitude)가 같은 공식을 따른다', () => {
      // 0.6² + 0.8² = 1 — 이미 정규화된 대각 방향. 축별로 속도를 독립
      // 클램프하는 잘못된 구현(정규화 무시)을 잡아내기 위한 보강 테스트.
      const input: MoveInput = { dirX: 0.6, dirZ: 0.8, mode: 'run', jump: false }
      const state = runTicks(input, TICKS)
      const magnitude = Math.sqrt(state.x ** 2 + state.z ** 2)

      expect(magnitude).toBeCloseTo(expectedDistance(MOVEMENT.SPEED, TICKS), 3)
    })

    it('RQ-20: 순수 함수는 결정론적이다 — 같은 입력을 두 번 시뮬레이션해도 완전히 같은 결과를 낸다', () => {
      const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
      expect(runTicks(input, TICKS)).toEqual(runTicks(input, TICKS))
    })

    it('RQ-20: 무입력(dirX=dirZ=0)이면 접지 상태에서 위치가 표류하지 않는다', () => {
      const input: MoveInput = { dirX: 0, dirZ: 0, mode: 'run', jump: false }
      const state = runTicks(input, TICKS)

      expect(state).toEqual(createGroundedState())
    })
  })

  describe('GA-31: 앉기·천천히 걷기 — 이동 속도 배율 감소', () => {
    it('RQ-20/GA-31: 앉기(crouch) 상태로 이동하면 변위가 3m/s(SPEED×50%) 공식을 따른다', () => {
      const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'crouch', jump: false }
      const state = runTicks(input, TICKS)
      const crouchSpeed = MOVEMENT.SPEED * MOVEMENT.CROUCH_MULTIPLIER

      expect(crouchSpeed).toBe(3)
      expect(state.x).toBeCloseTo(expectedDistance(crouchSpeed, TICKS), 3)
    })

    it('RQ-20/GA-31: 천천히 걷기(walk) 상태로 이동하면 변위가 4.2m/s(SPEED×70%) 공식을 따른다', () => {
      const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'walk', jump: false }
      const state = runTicks(input, TICKS)
      const walkSpeed = MOVEMENT.SPEED * MOVEMENT.WALK_MULTIPLIER

      expect(walkSpeed).toBeCloseTo(4.2, 5)
      expect(state.x).toBeCloseTo(expectedDistance(walkSpeed, TICKS), 3)
    })

    it('RQ-20/GA-31: 앉기가 천천히 걷기보다 느리고, 천천히 걷기는 달리기보다 느리다 — 배율 대소 관계가 실제 변위에도 반영된다', () => {
      const crouchDistance = runTicks({ dirX: 1, dirZ: 0, mode: 'crouch', jump: false }, TICKS).x
      const walkDistance = runTicks({ dirX: 1, dirZ: 0, mode: 'walk', jump: false }, TICKS).x

      expect(crouchDistance).toBeLessThan(walkDistance)
      expect(walkDistance).toBeLessThan(expectedDistance(MOVEMENT.SPEED, TICKS))
    })
  })

  describe('GA-32: 점프 — 최고점 1.0m 도달, 착지 후 y=0 복귀, 공중 가속 미허용', () => {
    // 순수 계산이라 실시간 소요가 없다 — 20초 상당(600틱)의 넉넉한 안전
    // 상한이며 "무한 대기 금지"(하네스 §1) 취지의 유한 루프 가드다. 어떤
    // 중력 선택(구현 자유, 위 "점프 궤적 유도" 참고)이어도 이 범위 안에서
    // 이착륙이 끝난다 — 실측(2026-07-24, node): 비현실적으로 완만한
    // g=0.5m/s²조차 착지까지 약 170틱.
    const MAX_TICKS = 600

    it('RQ-20/GA-32: 점프하면 최고점이 JUMP_HEIGHT(1.0m)에 근접하고, 착지 후 y=0·grounded로 복귀한다', () => {
      let state = createGroundedState()
      let input: MoveInput = { dirX: 0, dirZ: 0, mode: 'run', jump: true }
      let maxY = 0
      let wasAirborne = false
      let landed = false

      for (let i = 0; i < MAX_TICKS; i += 1) {
        state = stepMovement(state, input)
        input = { ...input, jump: false } // 점프는 엣지 트리거 — 이후 틱은 유지 입력만 보낸다
        if (state.y > maxY) maxY = state.y
        if (!state.grounded) wasAirborne = true
        if (wasAirborne && state.grounded) {
          landed = true
          break
        }
      }

      expect(wasAirborne).toBe(true) // 점프 입력이 실제로 공중 상태를 만들었다
      // 공차 ±0.05m(5%) — 이산 틱 적분의 정당한 오차 범위. 실측(2026-07-24,
      // node, 30Hz 기준): "해석적 궤적(경과 시각을 매 틱 직접 대입)" 방식은
      // 어떤 중력을 골라도 오차 1% 미만이지만, "연속식으로 구한 초기 속도를
      // 그대로 속도-오일러 적분(vy -= g·dt; y += vy·dt)에 대입"하는 순진한
      // 구현은 5~20% 미달로 실측됐다 — 후자는 RQ-92의 "1.0m"(RQ-32 박스
      // 점프의 물리적 전제) 요구를 실질적으로 못 지키는 것이므로 이 공차
      // 안에서 정당하게 걸러져야 한다.
      expect(maxY).toBeCloseTo(MOVEMENT.JUMP_HEIGHT, 1)
      expect(landed).toBe(true) // 언젠가 접지로 복귀한다 — 특정 틱 수에는 결합하지 않는다
      expect(state.y).toBeCloseTo(0, 4)
      expect(state.vy).toBe(0)
    })

    it('RQ-20/GA-32/RQ-92: 공중에서 반대 방향 입력을 넣어도 착지 시점의 수평 위치가 바뀌지 않는다(공중 가속 미허용)', () => {
      // 접지 구간(점프가 실제로 발동해 grounded=false가 되기 전까지)에는
      // 두 시뮬레이션 모두 동일하게 dirX=1을 유지한다 — 접지가 정확히 몇
      // 틱만에 풀리는지(구현 자유)와 무관하게 두 시뮬레이션을 공정하게
      // 비교하기 위함이다. 공중에 진입한 뒤에만 `airInputDirX`로 분기한다.
      const landingX = (airInputDirX: number): { x: number; landed: boolean } => {
        let state = createGroundedState()
        let jumped = false
        let wasAirborne = false
        let landed = false

        for (let i = 0; i < MAX_TICKS; i += 1) {
          if (wasAirborne && state.grounded) {
            landed = true
            break
          }
          const dirX = state.grounded ? 1 : airInputDirX
          const jump = state.grounded && !jumped
          state = stepMovement(state, { dirX, dirZ: 0, mode: 'run', jump })
          if (jump) jumped = true
          if (!state.grounded) wasAirborne = true
        }

        return { x: state.x, landed }
      }

      const sameDirection = landingX(1) // 공중에서도 계속 앞 방향 입력
      const reversedDirection = landingX(-1) // 공중에서 반대 방향 입력(에어 스트레이프 시도)

      expect(sameDirection.landed).toBe(true)
      expect(reversedDirection.landed).toBe(true)
      // 실제로 전진했다는 근거 — 둘 다 0으로 트리비얼하게 같은 게 아니다.
      // (달리며 뛰면 점프 시점의 수평 관성이 이후 궤적에 반영돼야 한다는
      // RQ-92 "공중에서는 점프 시점의 수평 관성만 유지된다" 요구 그 자체.)
      expect(sameDirection.x).toBeGreaterThan(0)
      // 핵심 단언(RQ-92): 공중에서 입력이 반대여도 착지 위치는 동일하다.
      expect(reversedDirection.x).toBeCloseTo(sameDirection.x, 6)
    })
  })
})
