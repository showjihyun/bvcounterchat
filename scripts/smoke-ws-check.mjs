#!/usr/bin/env node
// RQ-80 스모크 — GA-42·GA-43 검증 헬퍼(harness/evals/golden/track-a-product.jsonl).
//
// `scripts/smoke-deploy.sh`가 호출한다. colyseus.js는 이미 프로젝트 의존성
// (package.json)이라 호스트 node에서 이 저장소의 node_modules를 그대로
// 쓴다 — 별도 설치가 필요 없다. 컨테이너 안이 아니라 호스트에서 "실제
// 사용자처럼" Nginx가 노출한 포트로 접속해야 프록시 경로(WS 업그레이드
// 포함)까지 실측된다.
//
// 두 모드:
//   pair    — GA-42. 두 클라이언트가 같은 'game' 룸에 접속해 서로를
//             상태 스냅샷에서 관측하는지 확인하고 정상 종료(leave)한다.
//   persist — GA-43(리뷰 major 4 대응). 골든 `given`("클라이언트가 접속해
//             세션이 생긴 상태")을 실제로 충족시키기 위해, 접속한 채
//             연결을 끊지 않고 대기하다가 `room.onLeave`(재시작으로 인한
//             연결 종료)가 발생하면 그 사실을 로그로 남기고 종료한다.
//             `smoke-deploy.sh`가 `docker compose restart app` **전**에
//             이 모드를 백그라운드로 띄우고, 재시작 **후** 로그에서
//             "LEFT"를 확인해 "세션이 실제로 소실됐다"를 단언한다.
//
// ADR-0008 정신(무한 대기 금지): 모든 비동기 대기에 타임아웃 상한을 건다.
// 이 파일은 인프라 스모크 도구이지 src/shared 시뮬레이션 코드가 아니므로
// ADR-0008의 결정론 lint(Math.random/Date.now 금지) 대상은 아니다.

import { Client } from 'colyseus.js'

const MODE = process.argv[2]
const ENDPOINT = process.argv[3]

if ((MODE !== 'pair' && MODE !== 'persist') || !ENDPOINT) {
  console.error('usage:')
  console.error('  node smoke-ws-check.mjs pair <ws-endpoint> [timeoutMs]')
  console.error('  node smoke-ws-check.mjs persist <ws-endpoint> [joinTimeoutMs] [maxLifetimeMs]')
  process.exit(2)
}

/** @template T @param {Promise<T>} promise @param {number} ms @param {string} label @returns {Promise<T>} */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[timeout ${ms}ms] ${label}`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/** room.state.players에 최소 count명이 관측될 때까지 상태 변경을 구독해 기다린다. */
function waitForPlayerCount(room, count, ms, label) {
  return withTimeout(
    new Promise((resolve) => {
      const check = () => {
        if (room.state.players.size >= count) {
          room.onStateChange.remove(check)
          resolve(undefined)
        }
      }
      room.onStateChange(check)
      check()
    }),
    ms,
    label,
  )
}

/** GA-42: 두 클라이언트가 같은 룸에서 서로를 관측하는지 확인하고 정상 leave한다. */
async function runPair() {
  const timeoutMs = Number(process.argv[4] ?? 15000)

  const clientA = new Client(ENDPOINT)
  const clientB = new Client(ENDPOINT)

  console.log(`[smoke-ws:pair] client A joinOrCreate('game') -> ${ENDPOINT}`)
  const roomA = await withTimeout(
    clientA.joinOrCreate('game', { nickname: 'smoke-a' }),
    timeoutMs,
    "client A joinOrCreate('game')",
  )
  console.log(`[smoke-ws:pair] client A joined — sessionId=${roomA.sessionId} roomId=${roomA.roomId}`)

  console.log(`[smoke-ws:pair] client B joinOrCreate('game') -> ${ENDPOINT}`)
  const roomB = await withTimeout(
    clientB.joinOrCreate('game', { nickname: 'smoke-b' }),
    timeoutMs,
    "client B joinOrCreate('game')",
  )
  console.log(`[smoke-ws:pair] client B joined — sessionId=${roomB.sessionId} roomId=${roomB.roomId}`)

  if (roomA.roomId !== roomB.roomId) {
    throw new Error(`같은 룸이 아닙니다 — roomA.roomId=${roomA.roomId}, roomB.roomId=${roomB.roomId} (RQ-04 위반 가능성)`)
  }

  await waitForPlayerCount(roomA, 2, timeoutMs, 'A가 2명(A+B)을 관측하길 대기')
  await waitForPlayerCount(roomB, 2, timeoutMs, 'B가 2명(A+B)을 관측하길 대기')

  const aSeesB = roomA.state.players.has(roomB.sessionId)
  const bSeesA = roomB.state.players.has(roomA.sessionId)

  if (!aSeesB || !bSeesA) {
    throw new Error(
      `상호 관측 실패 — A sees B=${aSeesB}, B sees A=${bSeesA} ` +
        `(roomA.players=${JSON.stringify([...roomA.state.players.keys()])}, ` +
        `roomB.players=${JSON.stringify([...roomB.state.players.keys()])})`,
    )
  }

  console.log('[smoke-ws:pair] OK — 두 클라이언트가 같은 룸에서 서로를 관측했다 (GA-42)')

  await withTimeout(roomA.leave(true), timeoutMs, 'client A leave')
  await withTimeout(roomB.leave(true), timeoutMs, 'client B leave')
}

/**
 * GA-43(리뷰 major 4): 접속을 유지한 채 대기하다가 `onLeave`(재시작으로
 * 인한 연결 종료)가 발생하면 "LEFT"를 stdout에 남기고 종료 코드 0으로
 * 끝난다. `joinTimeoutMs` 안에 접속에 성공하면 즉시 "JOINED" 한 줄을
 * 출력해 호출자(smoke-deploy.sh)가 접속 완료를 로그 폴링으로 확인할 수
 * 있게 한다. `maxLifetimeMs` 안에 leave가 감지되지 않으면(= 재시작이 이
 * 클라이언트를 끊지 못했다는 뜻) 타임아웃 에러로 실패 종료한다.
 *
 * 실제 종료 경로 확인(review 특별 요청과 동일한 실측 근거): app 컨테이너가
 * 재시작되면 프로세스가 죽어 nginx↔app 백엔드 TCP 연결이 끊기고, nginx는
 * 이를 그대로 클라이언트 쪽 WS 연결 종료로 전파한다 — colyseus.js
 * `Room.connect()`의 `connection.events.onclose`가 (정상/비정상 무관하게)
 * `room.onLeave.invoke(e.code, e.reason)`을 호출한다(node_modules/
 * colyseus.js/build/cjs/Room.js:41-53 실측).
 */
async function runPersist() {
  const joinTimeoutMs = Number(process.argv[4] ?? 15000)
  const maxLifetimeMs = Number(process.argv[5] ?? 120000)

  const client = new Client(ENDPOINT)
  console.log(`[smoke-ws:persist] joinOrCreate('game') -> ${ENDPOINT}`)
  const room = await withTimeout(
    client.joinOrCreate('game', { nickname: 'smoke-persist' }),
    joinTimeoutMs,
    "persist client joinOrCreate('game')",
  )
  // 호출자가 "접속 완료"를 로그 폴링으로 확인하는 유일한 신호 — 형식을
  // 바꾸면 smoke-deploy.sh의 grep도 함께 바꿔야 한다.
  console.log(`[smoke-ws:persist] JOINED sessionId=${room.sessionId} roomId=${room.roomId}`)

  await withTimeout(
    new Promise((resolve) => {
      room.onLeave((code, reason) => {
        console.log(`[smoke-ws:persist] LEFT code=${code} reason=${reason ?? ''}`)
        resolve(undefined)
      })
    }),
    maxLifetimeMs,
    '재시작으로 인한 연결 종료(onLeave)가 감지되지 않음',
  )
}

async function main() {
  if (MODE === 'pair') {
    await runPair()
  } else {
    await runPersist()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[smoke-ws:${MODE}] FAIL: ${err.message}`)
    process.exit(1)
  })
