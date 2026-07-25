#!/usr/bin/env node
// RQ-80 스모크 — GA-42 검증 헬퍼(harness/evals/golden/track-a-product.jsonl).
//
// `scripts/smoke-deploy.sh`가 호출한다. 두 클라이언트가 Nginx가 노출한
// 포트로 WebSocket 접속해(colyseus.js) 같은 'game' 룸에 들어가고 서로를
// 상태 스냅샷에서 관측하는지 확인한다 — Nginx의 WS 업그레이드 프록시(RQ-80)
// 가 실제로 동작함을 컨테이너 밖(호스트)에서 실측하는 것이 목적이다.
//
// colyseus.js는 이미 프로젝트 의존성(package.json)이라 호스트 node에서
// 이 저장소의 node_modules를 그대로 쓴다 — 별도 설치가 필요 없다.
//
// ADR-0008 정신(무한 대기 금지): 모든 비동기 대기에 타임아웃 상한을 건다.
// 이 파일은 인프라 스모크 도구이지 src/shared 시뮬레이션 코드가 아니므로
// ADR-0008의 결정론 lint(Math.random/Date.now 금지) 대상은 아니다.

import { Client } from 'colyseus.js'

const ENDPOINT = process.argv[2]
const TIMEOUT_MS = Number(process.argv[3] ?? 15000)

if (!ENDPOINT) {
  console.error('usage: node smoke-ws-check.mjs <ws-endpoint> [timeoutMs]')
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

async function main() {
  const clientA = new Client(ENDPOINT)
  const clientB = new Client(ENDPOINT)

  console.log(`[smoke-ws] client A joinOrCreate('game') -> ${ENDPOINT}`)
  const roomA = await withTimeout(
    clientA.joinOrCreate('game', { nickname: 'smoke-a' }),
    TIMEOUT_MS,
    "client A joinOrCreate('game')",
  )
  console.log(`[smoke-ws] client A joined — sessionId=${roomA.sessionId} roomId=${roomA.roomId}`)

  console.log(`[smoke-ws] client B joinOrCreate('game') -> ${ENDPOINT}`)
  const roomB = await withTimeout(
    clientB.joinOrCreate('game', { nickname: 'smoke-b' }),
    TIMEOUT_MS,
    "client B joinOrCreate('game')",
  )
  console.log(`[smoke-ws] client B joined — sessionId=${roomB.sessionId} roomId=${roomB.roomId}`)

  if (roomA.roomId !== roomB.roomId) {
    throw new Error(`같은 룸이 아닙니다 — roomA.roomId=${roomA.roomId}, roomB.roomId=${roomB.roomId} (RQ-04 위반 가능성)`)
  }

  await waitForPlayerCount(roomA, 2, TIMEOUT_MS, 'A가 2명(A+B)을 관측하길 대기')
  await waitForPlayerCount(roomB, 2, TIMEOUT_MS, 'B가 2명(A+B)을 관측하길 대기')

  const aSeesB = roomA.state.players.has(roomB.sessionId)
  const bSeesA = roomB.state.players.has(roomA.sessionId)

  if (!aSeesB || !bSeesA) {
    throw new Error(
      `상호 관측 실패 — A sees B=${aSeesB}, B sees A=${bSeesA} ` +
        `(roomA.players=${JSON.stringify([...roomA.state.players.keys()])}, ` +
        `roomB.players=${JSON.stringify([...roomB.state.players.keys()])})`,
    )
  }

  console.log("[smoke-ws] OK — 두 클라이언트가 같은 룸에서 서로를 관측했다 (GA-42)")

  await withTimeout(roomA.leave(true), TIMEOUT_MS, 'client A leave')
  await withTimeout(roomB.leave(true), TIMEOUT_MS, 'client B leave')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[smoke-ws] FAIL: ${err.message}`)
    process.exit(1)
  })
