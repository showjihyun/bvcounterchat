# ADR 목록

2026-07-21 초안 9건 작성 → 같은 날 Deep Interview(37문항)로 RQ-90~95가
확정되어 **9건 전부 승인** 상태가 됐다. 이후 로드맵 1단계(프로젝트 초기화)
착수 시 레이아웃 결정이 없다는 것이 드러나 ADR-0010을 신설했다. 답변 근거는
`harness/specs/interview/answers.md`, 요구사항은
`harness/specs/requirements.md`(v1.0, 🟡 0개).

| 번호 | 갈림길 | 결정 | 상태 |
|---|---|---|---|
| [ADR-0001](0001-client-rendering-stack.md) | 클라이언트 렌더링 스택 | React + React Three Fiber + Three.js + TS + Zustand + Vite, WebGL2 고정·Chrome 전용 | 승인 |
| [ADR-0002](0002-realtime-transport.md) | 실시간 전송 계층 | Colyseus(WebSocket) on Node.js + Fastify | 승인 |
| [ADR-0003](0003-netcode-authority.md) | 넷코드 권위 모델 | 30Hz 고정 틱, 서버 권위, 클라이언트 예측+보간 | 승인 |
| [ADR-0004](0004-physics-collision.md) | 물리·충돌 | Rapier — 서버 권위 + 클라이언트 예측 사본, kinematic 캐릭터 컨트롤러, 공중 가속 없음 | 승인 |
| [ADR-0005](0005-hit-registration.md) | 히트 판정 | 서버 hitscan + 랙보상 되감기 상한 200ms, 킬 이벤트 `headshot` 플래그 | 승인 |
| [ADR-0006](0006-identity-and-persistence.md) | 신원·영속성 | 닉네임(표시용) + 익명 UUID(통계 키) + Redis 세션 + SQLite 통계 | 승인 |
| [ADR-0007](0007-map-asset-pipeline.md) | 맵 에셋 파이프라인 | 60×60m 오리지널 맵(색조만 Dust2류), glTF, 충돌/시각 메시 분리, 스프레이 아틀라스(AI 생성) | 승인 |
| [ADR-0008](0008-test-strategy.md) | 테스트 전략 | TDD, Vitest, 순수 tick 함수 결정론, 렌더링 비단위테스트 | 승인 |
| [ADR-0009](0009-deployment.md) | 배포 | Docker(서버 이미지) + Nginx(HTTP/WS, TLS 불요) + Redis, 멀티 컨테이너 단일 호스트 | 승인 |
| [ADR-0010](0010-project-layout.md) | 프로젝트 레이아웃 | 단일 package.json + `src/{client,server,shared}`, `@shared/*` 별칭 | 승인 |

> ADR-0001·0002·0003·0006·0009는 `docs/req/03_Technical_Architecture.md`가
> 스택을 이미 확정해 승인. ADR-0004·0005·0007은 req가 침묵한 세부(물리
> 실행 위치, 랙보상 파라미터, 에셋 파이프라인)라 처음엔 "제안"이었고,
> 각 ADR `## 결과`에 명시한 확인 조건(RQ-90/92/94 확정)이 Deep Interview로
> 충족되어 승인으로 전환됐다. ADR-0008(테스트 전략)은 이 하네스의 TDD
> 규칙을 게임 도메인(결정론적 헤드리스 시뮬레이션)에 맞춰 확정한다.
>
> **재검토 트리거**: ADR-0002(Colyseus/TCP)는 "사내망 전용"(RQ-80)이라는
> 전제 위에서만 성립한다 — 인터넷 공개로 전환하면 head-of-line blocking이
> 되살아나므로 이 ADR을 먼저 재검토해야 한다.
>
> **승인 ≠ 전면 검증**: ADR-0004는 서버 Rapier가 30Hz 틱 예산 안에서 10인
> 규모를 처리하는지 아직 실측하지 않았고, ADR-0005는 캐릭터 모델 에셋이
> 없어 히트박스 정확 치수가 미정이다 — 두 잔존 사항은 `## 결과`에 남겨둔
> 채로 승인했다(RQ-92/RQ-90/RQ-64 확정이 승인 조건이었지 전면 검증이
> 조건은 아니었다). 남은 개별 튜닝값(콘 반경, 박스 정확 치수, 재연결 유예
> 초, 아틀라스 셀 해상도 등 — req가 수치를 정하지 않은 세부)은 코드가
> 아닌 설정 파일 값으로 구현 시 정한다.

HUD 배치(RQ-50~55)는 `docs/req/05_UI_UX.md`가 진실 공급원이며, 레이아웃
자체를 재결정하는 ADR은 두지 않는다. 시각 디자인 산출물(색상·타이포·
비주얼 스타일 등)이 별도로 생기면 bvwebchat 패턴을 따라 `docs/design/`
아래 배치하고 ADR과 분리한다 — 현재 이 프로젝트에는 해당 문서가 없다.

규칙: ADR과 모순되는 코드 변경 금지. 바꾸려면 새 ADR로 기존 것을 대체.
