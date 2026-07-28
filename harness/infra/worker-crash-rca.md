> **상태: 조사 스냅샷 (2026-07-27~28 작성분 그대로 보존).**
> 이 문서는 원인 규명 **당시의 기록**이며 이후 확정된 사실로 갱신하지 않는다 —
> 조사 기록은 쓰인 그대로 남아야 "무엇을 근거로 그렇게 판단했는가"를 검증할 수 있다.
> **이후 정정된 것**(정본은 원장 28a · `harness/adr/0008-test-strategy.md` §5 ·
> `scripts/check.sh` 주석):
> - 본문의 `(≈10 → 30)`은 **`2 → 30`**이 맞다. `0.0008%` 문장이 도입된 시점의 통합
>   파일은 2개였다(git 이력 확인). 따라서 "모형이 처음부터 틀렸다"가 아니라 **파일이
>   늘면서 어긋났다** — 당시 3연속 확률은 0.0172%로 구주장 대비 21.5배였다.
> - 이 문서가 §7에서 **권장 3순위**로 둔 런타임 A/B(R3)가 실제로는 **원인을 확정**했다:
>   같은 Windows 머신·같은 코드에서 v24는 누적 12런 중 6런 실패, v22.23.1은 12런 전부
>   통과(Fisher 런 p=0.0137). 대응은 `.nvmrc`(22.23.1) + `engines`
>   `"^20.19.0 || ^22.13.0"` + `check.sh` 런타임 가드다.
> - **이후 RQ-81이 하한을 `"^22.13.0"`으로 다시 올렸다**(원장 26a) — `node:sqlite`
>   (Node 22.5+ 내장)를 쓰면서 Node 20 계열이 런타임 요구를 못 채우게 됐다.
> - **결론의 범위는 Windows 실측 기준**이다. `Linux + v24`는 미검증이고 abort를
>   호출하는 네이티브 프레임도 미특정이다 — 이 문서 §5·§6의 유보가 유효하다.

# 통합 테스트 워커 크래시 — 근본 원인 분석 (RCA)

- 작성: 2026-07-27~28, 격리 조사 세션(`rca-worker`)
- 브랜치: `chore/integration-worker-stability` (커밋 `f3b6eed`, 워크트리 1개뿐)
- 환경: Windows 11 Pro 26200, CPU 20코어 / RAM 51GB, node **v24.15.0**, vitest **4.1.10**
- **레포 코드 변경 없음.** 진단은 전부 `NODE_OPTIONS=--require <레포 밖 프리로드>`로
  주입했고, 합성 프로브(`tests/_rca_tmp/`)는 측정 후 삭제했다. `git status` 청결
  (§9).
- 총 측정량: **런 116회 · 워커 프로세스 3,514개 · 워커 누적 9,300초 · abort 29건.**

> 결론을 먼저 적고 실험별 표본·수치로 뒷받침한다. 재현하지 못한 가설은
> "미확인"으로 명시한다.

---

## 1. 결론 요약

### (1) 확정 — 워커는 예외로 죽지 않는다. **네이티브 abort**로 죽는다

vitest 메인 프로세스 측에서 관측한 죽는 자식의 종료 코드는 **예외 없이
`3221226505` = `0xC0000409` (STATUS_STACK_BUFFER_OVERRUN)** 이다. Windows에서
`abort()` / `__fastfail()`이 내는 코드 — Linux의 SIGABRT(exit 134)에 해당한다.
`signal`은 `null`(외부 kill이 아님), stderr는 **완전히 비어 있다**(§4-2 양성
대조로 캡처 경로가 살아 있음을 증명함).

워커 내부 계측으로 다음을 **전부 배제**했다: uncaught exception ·
unhandled rejection · `process.exit()` · `process.abort()`.
→ 팀 리드가 제시한 (a)처리되지 않은 예외/거부 (b)`process.exit` (c)네이티브
크래시 중 **(c)로 판정**한다.

### (2) 확정 — 최소 재현자를 만들었다: **살아 있는 Colyseus 클라이언트 세션**

게임 테스트 로직을 전부 걷어내고 남긴 30개 파일 —
`buildServer()` → `listen(0)` → **colyseus.js 클라 2개 join** → **3초간 30Hz 상태
패치 수신** → `leave` → `close` — 만으로 **같은 abort가 재현된다**(8런 중 2런,
코드 동일 `0xC0000409`).

반대로 **클라이언트가 없으면 재현되지 않는다**:

| 그룹 | 워커 | 워커-초 | abort |
|---|---:|---:|---:|
| 클라 없음 (idle · buildServer만 · listen만 · 순수 `ws` · `tests/unit`) | 1,204 | 2,126 | **0** |
| Colyseus 클라 세션 있음 (합성) | 480 | 1,073 | **2** |
| 실제 `tests/integration` | 780 | 4,354 | **22** |

모듈 임포트·포트 바인딩·vitest 워커 churn 자체로는 나지 않는다. **실 소켓 위의
Colyseus 클라이언트 세션이 필요조건**이다(이번에 얻은 모든 재현에서 그렇다).

### (3) 확정 — 풀(pool) 계층 조정으로는 해결되지 않는다

| 조정 | 결과 |
|---|---|
| `--no-file-parallelism` (직렬화) | 2/6 런 실패. **소요 40s → 161s (4배)** 인데도 남는다 |
| `--no-isolate` (프로세스 수 30→19.5/런) | 5/8 런 실패. **워커당 발생률 2.8% → 5.1%로 상승** |
| `pool:'threads'` · `maxWorkers:1` | 과거 세션에서 무효/악화 확인 — 이번 결과와 정합 |

위험이 **프로세스 개수가 아니라 한 프로세스가 수행한 Colyseus 작업량**에
비례한다. isolate를 끄면 워커가 줄어드는 만큼 워커 하나가 더 많은 일을 하므로
총 위험은 그대로다. 과거 `maxWorkers:1`이 더 나빴던 것도 같은 원리로 설명된다.

### (4) 확정 — "왜 지금 무너지는가"는 확률 모형의 오류다

워커당 abort 확률 **p = 22/780 = 2.82%** 는 예전과 같다. 바뀐 것은 **통합 파일 수
(≈10 → 30)** 다. 런 실패 확률 = 1-(1-p)ⁿ 이므로:

| 통합 파일 수 n | 예측 런 실패율 | 실측 |
|---:|---:|---|
| 10 (`--shard=1/3`) | 24.8% | **16.7%** (2/12) |
| 30 (현재 전체) | 57.6% | **52.5%** (21/40) |

`check.sh` 주석과 ADR-0008 §5의 **"~2% 독립 크래시가 3회 연속일 확률
≈ 0.0008%"는 틀렸다** — 그 2%는 런 단위가 아니라 **워커 단위**였다. 실제
3연속 소진 확률은 0.525³ ≈ **14.5%** 로, 문서가 약 **2만 배 과소평가**하고 있다.
최근 라운드에서 한도 초과가 세 번 난 것은 이상 현상이 아니라 모형이 처음부터
틀렸던 것이다.

### (5) 미확인 — abort를 부르는 정확한 네이티브 프레임

abort가 **아무 메시지도 남기지 않는다.** Node/V8의 자체 치명 오류 경로는 전부
abort 직전 stderr에 문구를 찍는데(힙 OOM, `CHECK` 실패, libuv assertion) 하나도
없고, Node 진단 리포트도 Windows 이벤트 로그 항목도 생기지 않는다.
**어느 코드가 abort를 호출하는지는 크래시 덤프 없이 특정할 수 없다** — 규명
실패로 남긴다(§6).

---

## 2. 증상 재현 절차

```bash
cd D:/workspace/bvcounterchat
npx vitest run tests/integration      # 40초, 2회 중 1회꼴로 재현
```

```
⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-pool]: Worker forks emitted error.
 ❯ ChildProcess.emitUnexpectedExit .../cli-api.BK8pd4xc.js:3025:22
Caused by: Error: Worker exited unexpectedly
 Test Files  29 passed (30)
      Tests  107 passed (111)
```

단언 실패는 **0건**이다(전 실험 116런 · 3,514워커에서 한 건도 없다).
크래시 1건당 테스트 파일 정확히 1개가 집계에서 통째로 빠진다.

### vitest 쪽 기전 (소스 확인)

`node_modules/vitest/dist/chunks/cli-api.BK8pd4xc.js`:

- L2903 `this.worker.on("exit", this.emitUnexpectedExit)` — 워커 시작 시 등록
- L2958 `this.worker.off("exit", this.emitUnexpectedExit)` — 정상 `stop()`에서 해제
- L3022 `emitUnexpectedExit = () => new Error("Worker exited unexpectedly")`

즉 **정상 `stop()` 경로 밖에서 fork가 종료되면 종료 코드와 무관하게** 이 오류가
난다. 정상 경로에서 vitest는 `fork.kill()`(Windows에선 TerminateProcess)로
워커를 죽이므로 건강한 워커는 `code=null, signal=SIGTERM`으로 보인다. 문제
워커만 `code=0xC0000409, signal=null` — 이 구분이 이번 분석의 축이다.

부수 확인: vitest 워커 fork는 `stdio:'pipe'`, `serialization:'advanced'`이고
`env: { ...process.env, ... }`(L3651)이므로 **NODE_OPTIONS가 워커에 상속된다**.
그래서 레포를 건드리지 않고 워커 내부를 계측할 수 있었다.

---

## 3. 계측 방법

레포 밖 스크래치패드의 CJS 프리로드 1개를 `NODE_OPTIONS=--require`로 주입했다.
CJS 프리로드에서 `child_process.fork`를 교체하면 vitest의
`import { fork } from 'node:child_process'`에도 반영된다(실측: `fork.name ===
'patchedFork'`).

| 계층 | 관측 항목 |
|---|---|
| 워커(자식) | `uncaughtExceptionMonitor`(비침습) · `exit` 이벤트 · `process.exit` 래핑 · `process.abort` 래핑 · `process.dlopen`(네이티브 애드온 적재) |
| 부모(vitest 메인) | fork별 **종료 코드·시그널·생존 시간**, 담당 테스트 파일(첫 IPC 메시지에서 추출), **자식 stdout/stderr 원본 캡처** |

계측 자체의 함정 하나를 먼저 제거했다: 처음엔 `process.on('uncaughtException')`을
썼는데 그것이 **예외를 삼켜 프로세스 동작을 바꾼다**는 것을 대조 실험(고의
throw가 죽지 않음)으로 확인하고 `uncaughtExceptionMonitor`로 교체했다.
아래 수치는 전부 비침습 버전 기준이다.

---

## 4. 실험별 표본과 수치

### 4-1. 계측이 원인이 아님 (대조)

| 실험 | 런 | 크래시 런 |
|---|---:|---:|
| 계측 있음 | 10 | 5 |
| **계측 없음 (NODE_OPTIONS 미설정)** | 8 | **3** |

계측 유무로 발생률이 유의하게 달라지지 않는다.

### 4-2. 죽는 워커의 실제 종료 신호 — 핵심 증거

부모 측에서 관측한 **비정상 종료 29건 전부**(전 실험 합산):

- 종료 코드 `3221226505`(`0xC0000409`) — **29/29, 예외 없음**
- `signal = null` (외부 kill 아님)
- stderr **빈 문자열 — 29/29**
- 워커 내부: `uncaughtException` · `unhandledRejection` · `process.exit` ·
  `process.abort` **전부 0건**
- Node 진단 리포트(`--report-on-fatalerror --report-uncaught-exception`): **0개 생성**
- Windows 이벤트 로그(Application, 최근 3시간): node.exe 항목 **0건**

**stderr 캡처의 양성 대조**(이 결론이 서려면 반드시 필요하다): 프리로드가
워커마다 `fs.writeSync(2, 'DIAGPROBE <pid>')` 한 줄을 쓰게 했다. 6런/180워커에서
**모든 워커**(죽은 5개 포함)의 캡처에 `DIAGPROBE`가 잡혔고, 죽은 워커의
stderr는 **정확히 그 한 줄뿐**이었다.
→ 캡처 경로는 동작한다. abort는 **정말로 아무 메시지도 남기지 않는다.**

### 4-3. 워크로드 A/B — 무엇이 있어야 재현되는가

합성 스위트는 전부 **파일 30개 = 워커 30개**로 실제 통합과 같은 형태다.
기대치는 실제 통합의 실측 발생률(1,000 워커-초당 5.05건)을 그 노출량에 적용한 값.

| # | 워크로드 | 런 | 워커 | 워커-초 | abort | 기대치 |
|---|---|---:|---:|---:|---:|---:|
| — | **`tests/integration` (실제, 기준선)** | 32 | 780 | 4,354 | **22** | — |
| E-D | `tests/unit` (23파일, 순수 로직) | 8 | 184 | 52 | 0 | 0.3 |
| S1 | 2초 idle만 (임포트·소켓 없음) | 10 | 300 | 664 | 0 | 3.4 |
| S2a | `buildServer()` + `close()` — **listen 안 함** | 8 | 240 | 529 | 0 | 2.7 |
| S2b | `listen(port:0)` + `close()` — 클라 없음 | 8 | 240 | 528 | 0 | 2.7 |
| S2d | 순수 `ws` 서버/클라 (Colyseus 없음) | 8 | 240 | 352 | 0 | 1.8 |
| S2c | colyseus.js 1회 join/leave (짧음) | 8 | 240 | 179 | 0 | 0.9 |
| **S2e** | **colyseus.js 클라 2개 + 3초 30Hz 패치 트래픽** | 8 | 240 | 894 | **2** | 4.5 |

**S2e가 최소 재현자다.** 게임 로직·단언·헬퍼가 하나도 없는데 같은 코드로 죽는다
(abort 시점 955ms · 1011ms).

통계적 강도(정직하게):

- 클라 없는 그룹 합산 **2,126 워커-초, abort 0**. S2e 발생률(2.24/1000초)로 보면
  기대 4.8건 → p ≈ 0.8%. 실제 통합 발생률(5.05/1000초)로 보면 기대 10.7건 →
  p ≈ 2×10⁻⁵. **"클라이언트 세션이 필요하다"는 유의하다.**
- 다만 **S2d(순수 `ws`) 단독은 노출량 352 워커-초로 부족하다**(기대 0.8건).
  "Colyseus 특유인가, WebSocket 일반인가"는 이 표본으로 가르지 못한다 —
  **미확인**으로 남긴다.
- S2e의 발생률(2.24/1000초)이 실제 통합(5.05/1000초)의 절반인 것은, 실제
  테스트가 클라 수·메시지 종류·룸 수에서 더 무겁기 때문으로 보인다(미검증).

### 4-4. 배제된 가설

| 가설 | 실험 | 결과 |
|---|---|---|
| **네이티브 msgpackr 가속(`@msgpackr-extract`)** | `MSGPACKR_NATIVE_ACCELERATION_DISABLED=true` × 8런 | **배제.** 5/8 런 크래시(240워커/abort 6). `dlopen` 추적으로 애드온이 **실제로 적재되지 않음**을 확인했는데도 그대로 났다 |
| 다른 네이티브 애드온(uWebSockets 등) | `process.dlopen` 추적 | 통합 워커가 적재하는 `.node`는 `@msgpackr-extract`(napi) **하나뿐**(180/180 워커). 그마저 위에서 배제 |
| 워커 간 동시성 경합 | `--no-file-parallelism` × 6런 | **배제.** 2/6 런 크래시. 40s→161s로 4배 느려지고도 남는다 |
| 프로세스 수(워커 churn) | `--no-isolate` × 8런 | **배제.** 5/8 런 크래시. 워커당 발생률은 오히려 2.8%→5.1% |
| 병렬 워크트리 `node_modules` 정션 공유 (원장 **17k** 가설) | `git worktree list` · 디렉터리 속성 확인 | **해당 없음.** 워크트리 1개, `node_modules`는 실제 디렉터리(정션 아님). 그런데도 발생률은 역대 최고. **17k의 정션 가설은 기각한다** |
| 계측 부작용 | 계측 없이 8런 | **배제** (§4-1) |
| permessage-deflate(zlib) 경로 | `WebSocketTransport.js:50-51` | 기본 `perMessageDeflate=false` — 애초에 안 탄다 |

### 4-5. abort 시점 — "teardown 잔여물" 가설 검증

죽은 워커의 생존 시간을 **같은 파일의 정상 생존 시간 중앙값**과 대조했다(발췌):

| 파일 | abort 시점 | 정상 중앙값 | 해석 |
|---|---:|---:|---|
| rq-40-chat-ordering | 504ms | 432ms | 정상 종료 직후 (teardown 부근) |
| rq-02-nickname-sanitize | 550 · 979ms | 471ms | teardown 부근 / 그 이후 |
| rq-41-slot-promotion | 3075 · 3109ms | 3030ms | teardown 부근 |
| rq-41-slot-promotion | 692 · 1299 · 1875ms | 3030ms | **테스트 진행 중** |
| rq-16-spawn-protection | 990ms | 21,690ms | **진행 중(4.5% 지점)** |
| rq-11-reload-corpse-respawn | 1002 · 5445ms | 9,905ms | **진행 중** |
| rq-64-lag-compensation | 3407 · 5554ms | 14,162ms | **진행 중** |
| rq-43-afk-kick | 29,058ms | 39,218ms | **진행 중** |

**판정: "teardown 이후 잔여 활동" 단독 원인 가설은 성립하지 않는다.**
다수가 파일의 정상 소요 시간 한참 전에 죽는다. 다만 22건 중 **17건이 워커 수명
1.5초 이내**(임포트 완료 ≈0.35~0.5초 직후)에 몰려 있어, 위험은 **소켓 활동 개시
직후 구간에 집중**된다.

파일별 상관도 없다 — 22건이 서로 다른 13개 파일에 흩어져 있다. 원장 17k가
"단일 파일 실행 7회는 크래시 0"이라고 적은 것은 **파일이 특별해서가 아니라
노출량(워커 7개, 몇십 워커-초)이 작아서**다: 그 노출량의 기대치는 0.2건이다.

`connection.ts` ping 타이머 누수(원장 25a)와 `@colyseus/core → @pm2/io`의 1초
타이머 4개는 실재하지만 **이번 abort와의 인과는 확인되지 않았다** — 타이머
누수는 프로세스를 abort시키지 않고, 같은 모듈을 임포트하는 S2a에서 529
워커-초 동안 0건이었다.

### 4-6. 파일 수 스케일링 검증

| 설정 | 런 | 실패 런 | 워커 | abort | 워커당 |
|---|---:|---:|---:|---:|---:|
| 전체 30파일 | 40 | 21 (52.5%) | 780 | 22 | 2.82% |
| `--shard=1/3` (10파일) | 12 | 2 (16.7%) | 120 | 3 | 2.50% |

워커당 발생률은 파일 수와 무관하게 ~2.5–2.8%로 일정하고, 런 실패율만 n에 따라
움직인다 → §1(4)의 모형이 맞다.

---

## 5. Windows 특성인가

**유력(확정은 아님).** 근거:

- `0xC0000409`는 **Windows 전용** 종료 코드다(Linux였다면 SIGABRT/134).
- 재현에 필요한 조건(실 소켓 + Colyseus 클라 세션 + 작업량)은 CI(Linux)에도
  그대로 있는데 **같은 커밋의 CI는 거의 항상 통과**한다.
- 애플리케이션 계층(msgpackr·타이머·teardown)과 하네스 계층(pool 토폴로지)을
  모두 배제하고 나면 남는 것은 런타임/OS 계층이다.

다만 **이 세션이 Linux에서 직접 대조 측정을 하지는 않았다**(CI 이력에 의존).
포트 `TIME_WAIT` 고갈은 별도로 확인하지 않았으나, 그 경로라면 `EADDRINUSE`
예외로 나타나야지 무성(無聲) abort가 되지 않으므로 **가능성이 낮다**.

---

## 6. 규명하지 못한 것 (정직하게)

**abort를 호출하는 네이티브 프레임을 특정하지 못했다.** 배제된 상태:

- Node/V8의 자체 치명 오류 경로 — 전부 abort 직전 stderr에 문구를 찍는데 없다
  (힙 OOM `JavaScript heap out of memory`, `CHECK` 실패, libuv `Assertion failed`)
- JS 계층 전부 (uncaught / unhandled rejection / `process.exit` / `process.abort`)
- 네이티브 애드온 (유일 후보 msgpackr-extract를 A/B로 배제)

남은 후보는 **메시지를 남기지 않는 `__fastfail` 계열**(/GS 스택 쿠키 위반,
Control Flow Guard 위반, CRT invalid-parameter 등) 또는 보안 소프트웨어에 의한
프로세스 종료다. **덤프 없이는 판별 불가.**

다음 수단(이번 세션 범위 밖 — 시스템 설정 변경·도구 설치·소스 패치 필요):

1. **WER LocalDumps 활성화**(`HKCU\...\Windows Error Reporting\LocalDumps`) 후
   WinDbg로 폴트 모듈·오프셋 확인. 가장 직접적이다.
2. **Node 버전 A/B**(v24.15 → v22 LTS). **비용 대비 효과가 가장 좋은 다음 실험**
   — S2e 재현자로 1시간 이내에 판정 가능하다.
3. Windows Defender 실시간 검사/ASR 예외 후 재측정.
4. V8 스레딩 플래그(`--predictable` / `--single-threaded`)로 GC·백그라운드 컴파일
   배제. **단 이 플래그들은 `NODE_OPTIONS`에서 거부되고**(실측) vitest는 워커
   `execArgv`에 프로파일링 플래그만 통과시키므로 vitest 소스 패치가 필요하다.

---

## 7. 처방 후보 — 근거와 리스크

### R1. (권장 1순위, 비용 0) `check.sh`·ADR-0008의 확률 계산 정정

`check.sh` L55와 ADR-0008 §5의 **"~2% 독립 크래시가 3회 연속일 확률
≈ 0.0008%"는 틀렸다**(§1-4). 실제 3연속 소진 확률 ≈ **14.5%**.

- 근거: 워커당 2.82% × 파일 30개 → 런 실패 52.5% (실측 21/40).
- 리스크: 없음. 오히려 이 문장이 남아 있는 한 다음 세션도 "재시도가 흡수할
  것"이라 잘못 기대한다. **게이트가 거짓 빨강을 낼 빈도를 문서가 2만 배
  과소평가하는 상태**를 방치하는 것이 진짜 위험이다.
- 함께: 원장 17k의 "정션 공유 가설"과 "단일 파일 실행은 크래시 0" 서술도
  정정 대상이다(§4-4, §4-5).

### R2. (권장 2순위) 재시도 단위를 **런 전체 → 결손 파일**로 바꾼다

지금은 크래시 1건 때문에 **40초짜리 런 전체**를 다시 돌린다. 크래시는 파일
1개만 잃으므로 빠진 파일만 다시 돌리면 된다.

- 근거: 워커당 실패율 2.82%가 상수이므로(§4-6), 재시도 대상이 30파일 → 1파일이
  되면 그 재시도가 또 실패할 확률은 57.6% → 2.8%. 2회 재시도만으로 잔여 실패
  ≈0.08%가 되고 **비용은 40초가 아니라 1~2초**다.
- 구현: `--reporter=json --outputFile`로 보고된 파일 목록을 받아 결손 파일을
  계산하고 그 파일들만 재실행. 이는 `check.sh` 주석 17h④가 이미 지적한
  "기본 리포터 출력 문자열 결합" 취약점도 함께 없앤다.
- 리스크: 스크립트가 복잡해진다. **단언 실패는 지금처럼 즉시 하드 실패**를
  유지해야 한다. 재시도 대상을 "결과를 보고하지 못한 파일"로만 한정하면
  게이팅은 지금보다 **더** 엄격해진다(현재는 크래시 시그니처가 보이면 같은 런의
  다른 파일까지 통째로 다시 돈다).
- **이것도 증상 완화지 원인 제거가 아니다.** 다만 §6 때문에 원인 제거 수단이
  지금 손에 없고, R5(예산 상향)와 달리 **비용을 20배 줄이면서 신뢰도를 올린다**.

### R3. (권장 3순위, 원인 제거 유일 실마리) Node 버전 A/B

- 근거: 무성 abort가 Windows에서만 나고, 애플리케이션·풀 계층 조정이 전부
  무효였다. 런타임 자체가 유력 용의자인데 **아직 한 번도 바꿔보지 않았다.**
  §8의 S2e 재현자를 쓰면 8~10런(약 2분)으로 판정된다.
- 리스크: 낮다. `engines: node >=20`이라 v22 LTS는 스펙 내다. 효과가 있으면
  ADR로 런타임 버전을 고정하면 되고, 그것이 **원인 제거에 가장 가깝다**.
- 순서 주의: R5 같은 은폐책을 이 실험보다 먼저 쓰지 말 것.

### R4. 하지 말 것 — pool / poolOptions 계층 조정

`pool:'threads'`(과거, 270회) · `maxWorkers:1`(과거) ·
`--no-file-parallelism`(이번, 6런) · `--no-isolate`(이번, 8런) **전부 무효이거나
악화**다. `vitest.config.ts`의 기존 주석("forks 유지가 최선")은 이번 측정으로도
유지된다. **이 방향에 더 시간을 쓰지 말 것** — 위험이 프로세스 토폴로지가 아니라
작업량에 붙어 있다.

### R5. (최후 수단) 재시도 예산 상향

- 3 → 6회면 소진 확률 0.525⁶ ≈ 2.1%, 7회면 1.1%.
- 리스크: 최악의 경우 **게이트 1회에 통합만 4~5분** — ADR-0008 §7의 3분 예산
  초과. 원인은 그대로 남고 파일이 더 늘면 다시 무너진다(현재 추세로 파일 45개면
  런 실패율 72%, 3연속 37%).
- R2가 같은 목표를 20배 싼 비용으로 달성하므로 **R2가 실패했을 때만** 쓴다.

### 권장 순서

**R1(문서 정정, 즉시) → R2(파일 단위 재시도) → R3(Node 버전 A/B)** →
R3도 무효면 §6-1(WER 덤프 + WinDbg)로 프레임 특정. 그때까지 원인은 "무성
네이티브 abort, 프레임 미특정"으로 문서에 그대로 남긴다.

---

## 8. 최소 재현자 (재현 코드)

`tests/_rca_tmp/s2e-01..30.test.ts` 30개 파일에 아래를 넣고
`npx vitest run tests/_rca_tmp/s2e`를 반복하면 8런 중 2런에서 재현된다
(240워커 / 894 워커-초 / abort 2건, 코드 `0xC0000409`). Node 버전 A/B나 업스트림
이슈 제보에 그대로 쓸 수 있다.

```ts
import { describe, expect, it } from 'vitest'
import { Client } from 'colyseus.js'
import { buildServer } from '@server/index'

describe('rca-s2e-NN', () => {
  it('holds two joined clients through sustained tick traffic', async () => {
    const app = buildServer({ logger: false })
    const address = await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = new URL(address)
    const endpoint = `ws://127.0.0.1:${port}`
    const a = await new Client(endpoint).joinOrCreate('game')
    const b = await new Client(endpoint).joinOrCreate('game')
    let patches = 0
    a.onStateChange(() => { patches += 1 })
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await a.leave(true)
    await b.leave(true)
    await app.close()
    expect(patches).toBeGreaterThan(0)
  })
})
```

관측에 쓴 프리로드(레포 밖)와 실행 로그는 세션 스크래치패드
`.../scratchpad/rca-worker/`에 실험별 `run-N.txt`(vitest 원본 출력) ·
`diag-N.log`(JSONL 관측 로그)로 남아 있다.

---

## 9. 워크스페이스 상태

- 합성 프로브 `tests/_rca_tmp/` **삭제 완료**.
- 진단 코드는 전부 레포 밖(스크래치패드)에 있었고 `NODE_OPTIONS`로만 주입했다.
- `git status`: clean (이 문서가 있는 `_workspace/`는 `.gitignore:16`으로 제외).
