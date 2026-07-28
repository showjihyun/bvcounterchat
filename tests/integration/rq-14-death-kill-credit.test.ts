import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'
import { escapeSafeZone, getSafeZoneSeam, releaseSpawnProtectionAndEscape } from '../support/safe-zone'

/**
 * RQ-14 HP·사망·킬 기록 — 서버 권위(RQ-61) 통합 테스트 (ADR-0008: Colyseus
 * 룸 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-08** (`harness/evals/golden/track-a-product.jsonl`).
 * GA-08: "given: 플레이어 B의 HP가 100(RQ-14 시작값)이며, 플레이어 A로부터
 * 바디샷(각 25데미지, RQ-90) 3회를 맞아 HP 25가 남은 상태 / when: A의
 * 4번째 바디샷이 B에게 명중해 HP가 0 이하가 됨 / then: B는 사망 처리되고,
 * 가해자 A에게 킬이 1 기록된다." `verify` 필드가 이 파일 경로를 정확히
 * 지정한다.
 *
 * **스코프 제외**: 리스폰(RQ-15)·스폰 보호(RQ-16)는 이 RQ의 범위 밖 —
 * "사망 처리" 이후 B에게 일어나는 일(재배치 등)은 이 파일이 검증하지
 * 않는다. GA-08이 관측 가능하다고 규정하는 것은 딱 둘 — B의 HP가 0(이하)
 * 이 되는 것과 A의 킬 수가 1 오르는 것뿐이다.
 *
 * **레벨 분리(ADR-0008)**: "바디샷 4회 = 정확히 사망"이라는 산술 자체는
 * `tests/unit/sim-combat.test.ts`의 "GA-08: 바디샷 3회는 생존..." 테스트가
 * 이미 고정했다. 이 파일은 그 산술이 실제 Colyseus 룸에서 4회의 실제
 * `'fire'` 메시지로 재현되고, 사망 시 가해자의 `kills` 필드가 실제로
 * 갱신되는가를 블랙박스로 확인한다.
 *
 * **가정(coder에게)**: `rq-12-server-hitscan.test.ts`의 가정 1~4와 동일
 * (`Player.hp`·`Player.kills` 필드, `'fire'` 메시지, 즉시 판정,
 * `DEFAULT_HITBOX`). **킬 크레딧 갱신 시점**: 피해자의 `hp`가 0(이하)이
 * 되는 그 사격의 처리 안에서, 가해자(사수)의 `kills`를 정확히 1 증가시킨다.
 *
 * **rate-limit과의 상호작용**: 4회 연속 사격은 매 사격 사이에 rate-limit
 * (ADR-0005, 150ms)이 확실히 풀릴 만큼 기다린 뒤 보낸다(각 사격이 실제로
 * 명중 처리됐는지를 HP 변화로 직접 확인하므로, 만약 rate-limit에 걸려
 * 무시된 사격이 있다면 뒤이은 `waitForHpCondition`이 타임아웃으로 실패해
 * 즉시 드러난다).
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존(ADR-0008
 * 허용 예외). 모든 대기에 `withTimeout()` 상한.
 *
 * **REV — 리뷰 major 재현(`_workspace/review/feat-RQ-12-14-combat-core.md`)**:
 * 최초 버전의 "가정" 절은 "이미 사망한 대상에 대한 추가 사격이 킬을
 * 중복 기록하지 않는다는 것까지는 이 RQ가 규정하지 않는다(스코프 밖)"고
 * 적었다 — 이는 **잘못된 스코프 판단이었다**. RQ-15(리스폰) 미구현으로
 * 시신이 사라지지 않는 것은 사실이지만, 그로 인해 "이미 죽은 대상을
 * rate-limit 간격으로 계속 쏴 킬을 무제한 파밍할 수 있다"는 것은 스코프
 * 밖 사안이 아니라 RQ-14 자체의 결함(죽음은 1회의 사건이어야 하는데
 * 반복 기록된다)이다 — 리뷰가 이 미검증 라이브 경로를 지적했다(major).
 * 아래 두 번째 `it()`가 이 결함을 재현한다. **킬 크레딧 갱신 규칙 정정**:
 * 피해자의 `hp`가 "생존(>0) → 사망(<=0)"으로 **전이**하는 그 사격에서만
 * `kills`를 1 증가시킨다 — 이미 hp<=0인 대상에 대한 추가 사격은 몇 번을
 * 맞아도 `kills`를 다시 올리지 않는다.
 *
 * **REV(구현 후 셋업 적응, RQ-15~16 라운드, team-lead 지시)**: RQ-15/16이
 * 이 파일이 "스코프 제외"라 적었던 리스폰·스폰 보호를 실제로 구현하면서
 * (위 스코프 제외 문구는 "이 파일이 그 사후 상태를 검증하지 않는다"는
 * 의미로 여전히 유효하다 — 사망 **이후**의 재배치·보호는 여전히 이 파일의
 * 관측 대상이 아니다), 두 전제가 깨졌다: B는 접속 직후 3초간 보호돼
 * 킬-셋업의 첫 발이 무효화됐고, A는 더 이상 원점에 고정되지 않는다
 * (`_workspace/RQ-15-16/02_coder_green.md` §3.3). 대응은 다른 legacy 파일과
 * 동일: B가 킬 시퀀스 전에 스스로(빗나가는 방향으로) 한 발 쏴 자신의
 * 최초 입장 보호를 즉시 해제하고, `aimAtBody`가 A의 실제 위치를 읽어
 * 상대 오프셋을 계산하도록 일반화했다. 두 `it()`의 단언(HP 감소량·킬
 * 크레딧·재사격 킬 불변)은 전혀 손대지 않았다.
 *
 * **REV3(RQ-31 Safe Zone 회귀 대응, `_workspace/RQ-31/03_test-writer_regression
 * .md`)**: RQ-31 Safe Zone 배선(GA-19·GA-11, `86fddf1`) 이후 B의 RQ-16
 * 해제 자기 사격은 B 자신의 Safe Zone(거리 0)에 막힐 수 있어
 * 화이트박스(`firedSinceSpawn`)로 대체한다. A도 두 `it()` 전체에서 한
 * 번도 움직이지 않아 A 자신의 스폰 지점(Safe Zone 내부)에 그대로 있다 —
 * GA-19가 A의 킬 시퀀스 사격 자체를 막는다. 기존 `travelAndSettle`(고정
 * +X, 900ms≈5.4m)은 15개 스폰 지점 중 4개에서 다른 스폰 지점의 Safe
 * Zone에 새로 들어가는 것이 실측됐다(`rq-31-safe-zone.test.ts` §반경-방사
 * 기하 참고) — B의 이동도 반경-방사 화이트박스 텔레포트로 대체한다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
/** RQ-31 회귀 대응 — 화이트박스 Safe Zone 탈출 텔레포트가 스키마
 * (`player.x/y/z`)에 정착할 시간(서버 틱 ≈33ms의 몇 배 여유). */
const SETTLE_MS = 200
/** 연속 사격 사이의 여유 — ADR-0005 rate-limit(150ms)을 명백히 초과한다. */
const BETWEEN_SHOTS_MS = 300
/** "변화 없음"을 확인하기 위한 관찰 구간(여러 상태 갱신을 거치기 충분한 여유). */
const NO_CHANGE_OBSERVATION_MS = 500


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

interface VictimFields {
  x: number
  z: number
  hp: number
}

interface KillerFields {
  kills: number
}

/** REV: `z` 필드를 추가했다 — A가 더 이상 원점에 고정되지 않아(RQ-31
 * onJoin 로테이션) 조준 벡터 계산에 두 플레이어의 z좌표가 모두 필요하다
 * (파일 상단 REV 참고). 이 함수는 "피해자"뿐 아니라 사수 A의 위치를 읽는
 * 데도 재사용한다(구조적으로 x·z·hp만 필요하면 되므로 `readKiller`와
 * 별도로 새 헬퍼를 만들지 않았다). */
function readVictim(room: Room, sessionId: string): VictimFields | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { x?: unknown; z?: unknown; hp?: unknown } | undefined }
  } | null
  const player = state?.players?.get?.(sessionId)
  if (typeof player?.x === 'number' && typeof player?.z === 'number' && typeof player?.hp === 'number') {
    return { x: player.x, z: player.z, hp: player.hp }
  }
  return undefined
}

function readKiller(room: Room, sessionId: string): KillerFields | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { kills?: unknown } | undefined }
  } | null
  const player = state?.players?.get?.(sessionId)
  if (typeof player?.kills === 'number') {
    return { kills: player.kills }
  }
  return undefined
}

function waitForDefinedVictim(room: Room, sessionId: string): Promise<VictimFields> {
  return withTimeout(
    new Promise<VictimFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readVictim(room, sessionId)
        if (current) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    HP_TIMEOUT_MS,
    `초기 스냅샷(x·hp 포함, sessionId=${sessionId}) 관측`,
  )
}

function waitForDefinedKiller(room: Room, sessionId: string): Promise<KillerFields> {
  return withTimeout(
    new Promise<KillerFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readKiller(room, sessionId)
        if (current) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    HP_TIMEOUT_MS,
    `초기 스냅샷(kills 포함, sessionId=${sessionId}) 관측`,
  )
}

function waitForHpCondition(
  room: Room,
  sessionId: string,
  predicate: (hp: number) => boolean,
  label: string,
): Promise<VictimFields> {
  return withTimeout(
    new Promise<VictimFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readVictim(room, sessionId)
        if (current && predicate(current.hp)) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    HP_TIMEOUT_MS,
    label,
  )
}

function waitForKillsCondition(
  room: Room,
  sessionId: string,
  predicate: (kills: number) => boolean,
  label: string,
): Promise<KillerFields> {
  return withTimeout(
    new Promise<KillerFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readKiller(room, sessionId)
        if (current && predicate(current.kills)) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    HP_TIMEOUT_MS,
    label,
  )
}


/** REV: A가 더 이상 원점에 고정되지 않으므로(RQ-31 onJoin 로테이션) 두
 * 위치 모두를 인자로 받는 일반형이다(`rq-15`·`rq-16`과 동일 패턴). */
function aimAtBody(
  shooter: { x: number; z: number },
  target: { x: number; z: number },
): { dirX: number; dirY: number; dirZ: number } {
  const bodyCenterM = (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
  const dx = target.x - shooter.x
  const dz = target.z - shooter.z
  const dy = bodyCenterM - DEFAULT_HITBOX.eyeHeightM
  const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: dz / magnitude }
}

describe('RQ-14/GA-08: 바디샷 4회 누적으로 사망 처리되고 가해자에게 킬이 1 기록된다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-14/GA-08: A의 바디샷 3회 후 B의 HP는 25(생존, 킬 미기록), 4번째 바디샷에서 B의 HP는 0이 되고 A의 킬 수는 1이 된다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      const baselineB = await waitForDefinedVictim(roomB, roomB.sessionId)
      const baselineAPosition = await waitForDefinedVictim(roomA, roomA.sessionId) // 위치 재사용(REV)
      const baselineA = await waitForDefinedKiller(roomA, roomA.sessionId)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)
      expect(baselineA.kills).toBe(0)

      // RQ-31 회귀 대응(파일 상단 REV3) — B의 RQ-16 해제는 화이트박스로,
      // A·B 둘 다 Safe Zone 밖으로 옮긴다(모든 스폰 지점은 y=0 평지).
      const seam = getSafeZoneSeam(roomA)
      const escapedA = escapeSafeZone(seam, roomA.sessionId, baselineAPosition)
      const escapedB = releaseSpawnProtectionAndEscape(seam, roomB.sessionId, baselineB)
      await sleep(SETTLE_MS)
      const aim = aimAtBody(escapedA, escapedB)

      let lastHp = baselineB.hp
      for (let shot = 1; shot <= 3; shot += 1) {
        roomA.send('fire', aim)
        const expectedHp = PLAYER.MAX_HP - WEAPON.DAMAGE_BODY * shot
        const afterShot = await waitForHpCondition(
          roomB,
          roomB.sessionId,
          (hp) => hp === expectedHp,
          `${shot}번째 바디샷 후 HP=${expectedHp} 대기`,
        )
        lastHp = afterShot.hp
        await sleep(BETWEEN_SHOTS_MS)
      }

      // GA-08 given 상태 — 3회 피격 후 HP 25, 아직 생존, 킬 미기록.
      expect(lastHp).toBe(25)
      const killsBeforeFourth = readKiller(roomA, roomA.sessionId)
      expect(killsBeforeFourth?.kills).toBe(0)

      // 4번째 바디샷 — 사망 처리 + 킬 크레딧.
      roomA.send('fire', aim)
      const afterFourth = await waitForHpCondition(
        roomB,
        roomB.sessionId,
        (hp) => hp <= 0,
        '4번째 바디샷 후 사망(HP<=0) 대기',
      )
      expect(afterFourth.hp).toBe(0)

      const afterKillCredit = await waitForKillsCondition(
        roomA,
        roomA.sessionId,
        (kills) => kills > 0,
        '사망 처리 후 가해자 킬 수 증가 대기',
      )
      expect(afterKillCredit.kills).toBe(1)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    40_000,
  )

  /**
   * REV — 리뷰 major 재현(`_workspace/review/feat-RQ-12-14-combat-core.md`
   * "이미 사망(hp=0)한 대상에 대한 재사격이 킬을 중복 기록한다",
   * `GameRoom.ts:226-230` 진단).
   *
   * RQ-15(리스폰)가 이 RQ의 스코프 밖이라 사망한 플레이어의 시신이 월드에서
   * 사라지지 않고 원위치·히트박스가 그대로 남는다 — 그래서 사수는
   * rate-limit(150ms) 간격만 지키며 시신을 계속 쏴 킬을 무제한 파밍할 수
   * 있다(리뷰가 지적한 실제 도달 가능한 라이브 경로). 이 테스트는 GA-08의
   * "최초 사망 시 킬 1 기록"에 이어, **그 뒤의 재사격이 킬 수를 더 올리지
   * 않는다**는 불변식만 추가로 확인한다(HP의 이후 진행치는 team-lead 지시대로
   * 관찰 범위 밖 — 킬 수 불변이 핵심 계약이다).
   *
   * **REV(RQ-15~16 라운드)**: 위 문단의 "RQ-15가 스코프 밖"은 이제
   * 사실이 아니다(RQ-15가 구현됐다) — 다만 사망→재사격→관찰까지의 총
   * 경과가 500~600ms 수준으로 `PLAYER.RESPAWN_MS`(3000ms)에 한참 못
   * 미쳐 리스폰이 이 테스트의 타이밍에 개입하지 않는다. 이 문단은 역사적
   * 맥락(리뷰가 왜 이 결함을 지적했는지)으로 그대로 남긴다.
   *
   * **REV2(델타 재리뷰 minor 대응 — 시신 통과 결정 이후 방어선 재정리)**:
   * 시신 통과(minor-3, `rq-15-corpse-bullet-passthrough.test.ts`) 결정
   * 이후 킬 파밍 방어는 **2층 구조**다 — ① `GameRoom.handleFire`의
   * hitscan 후보 수집이 `canAct(player.hp)`로 시신을 아예 걸러내(사망자는
   * `findClosestHit`의 후보 목록에 들어가지도 않는다), 재사격이 대상
   * 자체에 닿지 않는다. ② 설령 후보에 남더라도(이 필터가 없던 시절, 혹은
   * 향후 필터 정책이 바뀌는 경우를 대비한 두 번째 방어선) `applyDamage`의
   * "생존→사망 **전이**에서만 `died` true" 규칙(`tests/unit/
   * sim-combat.test.ts:420-429`가 A계층에서 직접 고정)이 막는다. 지금은
   * ①에서 이미 막히므로 아래 사격은 대상 히트박스에 도달조차 하지
   * 않는다 — `kills` 불변 단언은 여전히 참이지만, "여전히 히트박스에
   * 명중한다"던 원래 설명(아래 사격 직전 주석)은 더 이상 사실이 아니다
   * (정정 — 커버리지 구멍은 아니다, 방어가 ①로 옮겨갔을 뿐이다).
   */
  it(
    'RQ-14 리뷰 major 재현: B가 사망(킬 1 기록)한 뒤 A가 rate-limit 간격을 지켜 B의 시신을 재사격해도, A의 킬 수는 1로 불변이다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      const baselineAPosition = await waitForDefinedVictim(roomA, roomA.sessionId) // 위치 재사용(REV)
      const baselineB = await waitForDefinedVictim(roomB, roomB.sessionId)
      await waitForDefinedKiller(roomA, roomA.sessionId)

      // RQ-31 회귀 대응(파일 상단 REV3) — B의 RQ-16 해제는 화이트박스로,
      // A·B 둘 다 Safe Zone 밖으로 옮긴다.
      const seam = getSafeZoneSeam(roomA)
      const escapedA = escapeSafeZone(seam, roomA.sessionId, baselineAPosition)
      const escapedB = releaseSpawnProtectionAndEscape(seam, roomB.sessionId, baselineB)
      await sleep(SETTLE_MS)
      const aim = aimAtBody(escapedA, escapedB)

      // GA-08과 동일한 절차로 B를 사망시킨다(바디샷 4회, rate-limit 간격 준수).
      for (let shot = 1; shot <= 4; shot += 1) {
        roomA.send('fire', aim)
        const expectedHp = Math.max(0, PLAYER.MAX_HP - WEAPON.DAMAGE_BODY * shot)
        await waitForHpCondition(
          roomB,
          roomB.sessionId,
          (hp) => hp === expectedHp,
          `${shot}번째 바디샷 후 HP=${expectedHp} 대기`,
        )
        await sleep(BETWEEN_SHOTS_MS)
      }

      const afterDeath = await waitForKillsCondition(
        roomA,
        roomA.sessionId,
        (kills) => kills > 0,
        '사망 처리 후 가해자 킬 수 증가 대기',
      )
      expect(afterDeath.kills).toBe(1) // 최초 사망 — 정상 크레딧(전제 확인)

      // 핵심 재현(REV2 정정 — 위 docblock REV2 참고): 이 사격은 더 이상
      // B의 히트박스에 명중하지 않는다 — B(hp=0)가 handleFire의 후보 수집
      // 단계에서 canAct 가드에 걸러져 findClosestHit 후보 목록에 아예
      // 들어가지 않기 때문이다(①층 방어). 그래도 "재사격해도 kills가
      // 오르지 않는다"는 이 테스트의 계약 자체는 변하지 않는다(방어가
      // ①로 옮겨갔을 뿐 결과는 동일) — rate-limit(150ms)을 확실히 지켜
      // 재사격한다.
      roomA.send('fire', aim)

      // "변화 없음"은 순간 스냅샷으로 증명할 수 없다 — 여러 상태 갱신을
      // 거치는 동안에도 킬 수가 여전히 1인지 확인한다(rq-12-server-hitscan
      // "무관한 방향 사격 시 HP 불변" 테스트와 동일한 고정 대기 패턴).
      await sleep(NO_CHANGE_OBSERVATION_MS)
      const afterRefire = readKiller(roomA, roomA.sessionId)
      expect(afterRefire?.kills).toBe(1) // 현재 구현에서는 2로 관측돼 실패한다(Red)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    40_000,
  )
})
