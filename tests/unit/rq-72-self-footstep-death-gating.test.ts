import { describe, expect, it } from 'vitest'
import { AUDIO, PLAYER } from '@shared/constants'
import { RESPAWN_TICKS } from '@shared/sim/lifecycle'
import { createSelfFootstepTracker, type SelfFootstepTrackerTickInput } from '@client/audio/selfFootstepTracker'

/**
 * RQ-72 — `src/client/audio/selfFootstepTracker.ts` 결함 재현 회귀 테스트
 * (ADR-0011 결정 1 "결함 수정 라운드의 재현 테스트" — Red-first 영역,
 * team-lead 지시로 이 세션이 담당).
 *
 * **결함(원장 28ab 평가 FAIL F1, `_workspace/RQ-72c/03_evaluator_report.md`)**:
 * 사망 중(hp=0)에도 클라이언트 예측이 서버 미확인(unacked) 입력을 계속
 * 재생해 전진하고, 자기 발소리 누적이 그 예측 위치를 그대로 입력으로 써서
 * **죽은 채로 이동 키를 누르고 있으면 부활할 때까지 발소리가 울렸다**
 * (실측: 사망 90틱(`PLAYER.RESPAWN_MS`=3000ms) 동안 7회, 최종 예측 x=14.7).
 * 같은 창에서 원격 경로는 서버가 시신 위치를 고정하므로 구조적으로 0회다
 * — 사용자 결정(PR #74)인 "자기·원격에 같은 누적 규칙"이 사망 창에서만
 * 깨졌던 문제.
 *
 * **수정**(커밋 `40c4298`, 이 테스트보다 코드 시간상 먼저 존재하지만 이
 * 축을 잠그는 테스트는 지금까지 없었다 — `04_coder_fix.md` "F1 잠금
 * 테스트를 쓰지 않은 이유" 참고): `canAct(input.hp)`(`@shared/sim/lifecycle`)로
 * 누적만 게이팅하고, `previous`(직전 위치·hp)는 게이팅과 무관하게 매 틱
 * 갱신한다. 갱신을 멈추면 부활 순간 `previous.hp`가 사망 전의 값(>0)에
 * 멈춰 있어 `discontinuous` 판정(`previous.hp===0 && input.hp===MAX_HP`)이
 * 성립하지 않고, 사망 지점부터 스폰 지점까지의 순간이동 변위가 통째로
 * `stepFootstepAccumulator`에 먹혀 부활 즉시 큰 누적이 한꺼번에 샌다.
 *
 * **골든 케이스 매핑 — 없음**. 이 게이팅 축(자기 예측 경로의 사망 중 누적
 * 억제)은 `harness/evals/golden/track-a-product.jsonl`에 전용 GA-*가
 * 없다(GA-77~89 검색 완료, RQ-72 골든은 순수 판정 로직·원격 경로만 다룬다
 * — `sim-footsteps.test.ts`·`rq-72-remote-footsteps.test.ts`). 가장 가까운
 * 골든은 GA-89(리스폰 20m 순간이동이 누적되지 않는다)이지만 그 골든은
 * 원격 경로 대상이고, 이 결함은 **자기 경로에만 있던 예측 소스 문제**라
 * 별개다 — 임의로 GA-ID를 만들지 않고 F1로만 추적한다.
 *
 * **레벨**: `createSelfFootstepTracker`는 DOM·네트워크·실시간 API에
 * 의존하지 않는 순수 함수 팩토리라 단위 테스트 대상이다(ADR-0014 결정 5 면제는
 * 소비자인 `PlayerControls.tsx` 배선에만 적용된다 — 이 모듈 자체는 면제
 * 대상이 아니다, F1 원인 분석과 동일 논거).
 *
 * **이 파일이 다루지 않는 것(스코프 밖)**: eligible 판정 자체(grounded·
 * mode·walk/crouch 무음·이함 배제 등, GA-77~79/84/85/88)는
 * `stepFootstepAccumulator`를 그대로 위임 호출하므로 `sim-footsteps.test.ts`가
 * 이미 덮는다 — 여기서 재검증하지 않는다. 이 파일은 이 모듈이 **추가로
 * 얹는 것**(hp 게이팅 + previous 상시 갱신)만 검증한다.
 *
 * | 축 | 검증 |
 * |---|---|
 * | 사망 중 무음(F1 재현) | describe 1 |
 * | previous 상시 갱신 → 부활 시 변위 미누출 | describe 2 |
 * | 생존 중 정상 누적(과잉 게이팅 없음) | describe 3 |
 * | 부활 후 누적 재개 | describe 4 |
 *
 * **Red 증거**: 이 결함은 이미 수정 커밋(`40c4298`)이 이 테스트보다 먼저
 * 존재하는 상태라 메인 트리에서 그대로 실행하면 바로 GREEN이다(정상 —
 * `04_coder_fix.md`가 설명하는 순서 역전, ADR-0011 위반 아님, team-lead
 * 지시). 이 테스트가 실제로 결함을 잡는지는 **격리 워크트리**에서
 * `canAct` 게이팅을 제거한 변이와 `previous` 상시 갱신을 되돌린 변이 각각을
 * 심어 확인했다 — `_workspace/RQ-72c/05_test-writer_regression.md` 참고.
 */

const STRIDE_M = AUDIO.FOOTSTEP_STRIDE_M

function tick(
  overrides: Partial<SelfFootstepTrackerTickInput> = {},
): SelfFootstepTrackerTickInput {
  return { x: 0, z: 0, grounded: true, mode: 'run', hp: PLAYER.MAX_HP, ...overrides }
}

describe('RQ-72 F1 회귀: 사망 중(hp=0)에는 계속 "이동"해도 자기 발소리가 누적되지 않는다', () => {
  it('평가 보고서 실측 형태 재현 — 사망 전이 틱부터 RESPAWN_TICKS(90틱) 동안 매 틱 전진해도 누적이 0회로 고정된다', () => {
    const tracker = createSelfFootstepTracker(STRIDE_M)

    // 생존 중 기준점 확보(최초 관측 — 항상 무음).
    tracker.step(tick({ x: 0, hp: PLAYER.MAX_HP }))

    // 사망 전이 틱(hp: 100 → 0). 이 틱도 canAct(0)=false라 게이팅 대상.
    let count = tracker.step(tick({ x: 0.2, hp: 0 }))
    expect(count).toBe(0)

    // 사망 중 서버가 거부한 예측이 계속 전진한다고 가정하고, 정확히
    // RESPAWN_TICKS만큼 매 틱 0.2m씩(반증용으로 보폭 2.0m를 여러 번 채우고도
    // 남을 만큼) "이동"시킨다. 게이팅이 없었다면 누적이 90 × 0.2m = 18.0m →
    // floor(18.0 / 2.0) = 9회가 났을 것이다.
    let x = 0.2
    for (let i = 0; i < RESPAWN_TICKS; i++) {
      x += 0.2
      count = tracker.step(tick({ x, hp: 0 }))
    }

    expect(count).toBe(0)
  })

  it('사망 순간 이전에 이미 쌓여 있던 누적도 사망 중에는 늘지 않는다(게이팅이 사망 "직후"가 아니라 hp<=0인 모든 틱에 적용된다)', () => {
    const tracker = createSelfFootstepTracker(STRIDE_M)

    tracker.step(tick({ x: 0, hp: PLAYER.MAX_HP }))
    // 생존 중 1.8m만 이동(2.0m 미만 — 아직 무음).
    let count = tracker.step(tick({ x: 1.8, hp: PLAYER.MAX_HP }))
    expect(count).toBe(0)

    // 사망 — 남은 0.2m를 채울 만한 변위를 계속 흘려보내도 게이팅되어야 한다.
    for (let i = 0; i < 10; i++) {
      count = tracker.step(tick({ x: 1.8 + (i + 1) * 0.2, hp: 0 }))
    }
    expect(count).toBe(0)
  })
})

describe('RQ-72 F1 근본 원인 회귀: previous는 사망 중에도 매 틱 갱신되어, 부활 순간 큰 변위가 한꺼번에 새지 않는다', () => {
  it('사망 중 previous가 얼어붙으면(오탐 시나리오) 부활 시 discontinuous 판정이 깨져 사망 지점→스폰 지점 거리가 통째로 누적된다 — 이 트래커는 그렇게 되지 않는다', () => {
    const tracker = createSelfFootstepTracker(STRIDE_M)

    // ⚠️ 생존 중 관측을 **두 번** 거친다 — 첫 호출은 `hasPrevious`가 없어
    // previous가 아직 초기 기본값(우연히 hp=0)이다. 두 번째 생존 호출을
    // 거쳐야 previous.hp가 실제 생존 값(MAX_HP)으로 확정되므로, 사망 중
    // previous가 "얼어붙는" 변이를 이 테스트가 실제로 가를 수 있다 —
    // 한 번만 거치면 얼어붙은 값도 우연히 0이라 변이가 들키지 않는다.
    tracker.step(tick({ x: 0, hp: PLAYER.MAX_HP }))
    tracker.step(tick({ x: 0, hp: PLAYER.MAX_HP }))
    let count = tracker.step(tick({ x: 0, hp: 0 })) // 사망(같은 자리)
    expect(count).toBe(0)

    // 사망 중 예측이 계속 전진 — 게이팅되어 count는 0을 유지해야 한다.
    for (let i = 1; i <= RESPAWN_TICKS; i++) {
      count = tracker.step(tick({ x: i * 0.2, hp: 0 }))
    }
    expect(count).toBe(0)

    // 부활 — 서버가 20m 떨어진 스폰 지점으로 순간이동시키고 hp를 MAX_HP로
    // 되돌린다. previous가 매 틱 갱신돼 previous.hp가 정확히 0이어야
    // discontinuous(previous.hp===0 && input.hp===MAX_HP)가 성립해 이번
    // 20m 변위가 무시되고 누적이 0으로 리셋된다. previous가 얼어붙어
    // previous.hp가 사망 전 값(>0)에 머물렀다면 discontinuous가 거짓이 되어
    // horizontalDeltaM=20이 그대로 먹혀 floor(20/2.0)=10회가 한꺼번에 샌다.
    count = tracker.step(tick({ x: 20, hp: PLAYER.MAX_HP }))
    expect(count).toBe(0)
  })

  it('부활 틱 자체의 z축 변위(사망 중 옆으로도 "이동"한 경우)도 discontinuous로 함께 무시된다', () => {
    const tracker = createSelfFootstepTracker(STRIDE_M)

    // 위 테스트와 동일한 이유로 생존 관측을 두 번 거쳐 previous.hp를
    // MAX_HP로 확정한 뒤 사망시킨다.
    tracker.step(tick({ x: 0, z: 0, hp: PLAYER.MAX_HP }))
    tracker.step(tick({ x: 0, z: 0, hp: PLAYER.MAX_HP }))
    let count = tracker.step(tick({ x: 0, z: 0, hp: 0 }))
    expect(count).toBe(0)

    for (let i = 1; i <= RESPAWN_TICKS; i++) {
      count = tracker.step(tick({ x: i * 0.1, z: i * 0.1, hp: 0 }))
    }
    expect(count).toBe(0)

    // 스폰 지점이 대각선으로도 멀리 떨어진 경우.
    count = tracker.step(tick({ x: 15, z: 8, hp: PLAYER.MAX_HP }))
    expect(count).toBe(0)
  })
})

describe('RQ-72 F1 대조군: 생존 중에는 게이팅이 과하지 않다 — 정상 누적은 그대로다', () => {
  it('hp가 계속 만피(canAct 항상 true)인 동안 4.0m 직선 이동하면 정확히 2회 누적된다(GA-77과 동일한 형태, 게이팅 경로를 우회하지 않는지 확인)', () => {
    const tracker = createSelfFootstepTracker(STRIDE_M)

    tracker.step(tick({ x: 0, hp: PLAYER.MAX_HP }))
    let count = 0
    for (let i = 1; i <= 20; i++) {
      count = tracker.step(tick({ x: i * 0.2, hp: PLAYER.MAX_HP }))
    }

    expect(count).toBe(2)
  })

  it('hp가 낮아도(예: 1) 죽지 않은 이상(canAct(1)=true) 누적이 정상적으로 진행된다 — 게이팅 기준은 hp<=0이지 hp가 낮음이 아니다', () => {
    const tracker = createSelfFootstepTracker(STRIDE_M)

    tracker.step(tick({ x: 0, hp: 1 }))
    let count = 0
    for (let i = 1; i <= 20; i++) {
      count = tracker.step(tick({ x: i * 0.2, hp: 1 }))
    }

    expect(count).toBe(2)
  })
})

describe('RQ-72 F1 대조군: 부활 이후에는 발소리 누적이 다시 정상적으로 진행된다(게이팅이 영구 정지가 아니다)', () => {
  it('부활 직후 리셋된 누적 위에서 새 이동은 정상적으로 발소리를 낸다', () => {
    const tracker = createSelfFootstepTracker(STRIDE_M)

    tracker.step(tick({ x: 0, hp: PLAYER.MAX_HP }))
    tracker.step(tick({ x: 0, hp: 0 })) // 사망
    for (let i = 1; i <= RESPAWN_TICKS; i++) {
      tracker.step(tick({ x: i * 0.2, hp: 0 })) // 사망 중 예측 전진(게이팅됨)
    }

    let count = tracker.step(tick({ x: 20, hp: PLAYER.MAX_HP })) // 부활, discontinuous 리셋
    expect(count).toBe(0)

    // 부활 후 정상 이동 4.0m → 2회.
    for (let i = 1; i <= 20; i++) {
      count = tracker.step(tick({ x: 20 + i * 0.2, hp: PLAYER.MAX_HP }))
    }
    expect(count).toBe(2)
  })
})
