# ADR-0001: 클라이언트 렌더링 스택 — React + React Three Fiber + Three.js

- 상태: 승인 (근거: docs/req/03, RQ-01 확정)
- 날짜: 2026-07-21
- 관련 스펙: RQ-01, RQ-50, RQ-51, RQ-52, RQ-53, RQ-54, RQ-55

## 맥락

브라우저에서 설치 없이 3D FPS를 실행해야 하고(RQ-01), 동시에 미니맵·킬피드·
HP/탄약·크로스헤어 등 2D HUD 오버레이(RQ-50~55)가 3D 씬 위에 겹쳐 보여야
한다. req/03이 스택(React, React Three Fiber, Three.js, TypeScript, Zustand,
Vite)을 이미 확정했다. Deep Interview(질문 35~37)로 RQ-01이 지원 대상을
**데스크톱 Chrome 단일 브라우저**, 렌더러를 **WebGL2 고정**(WebGPU 미사용)
으로 확정하고, 내장 GPU(Intel Iris Xe급) 환경에서 **30fps 이상**을 성능
하한으로 못박았다 — 이 ADR은 그 확정을 렌더러 설정 근거로 반영한다.

## 결정

클라이언트는 **React + TypeScript**로 구성하고, 3D 씬은 **Three.js**를
**React Three Fiber(R3F)**로 감싸 선언적 컴포넌트로 작성한다. 상태 관리는
**Zustand**, 빌드/개발 서버는 **Vite**. R3F `<Canvas>`는 **WebGL2 컨텍스트만
사용**하며(three.js `WebGPURenderer`는 채택하지 않는다), 크로스브라우저
분기 코드(폴리필, 브라우저별 셰이더 분기)는 만들지 않는다 — **Chrome
단일 지원**(RQ-01)이 그 필요를 없앤다.

## 근거

- R3F는 Three.js 씬 그래프를 React 컴포넌트 트리로 표현해, HUD(React DOM)와
  3D 씬(WebGL canvas)이 같은 컴포넌트 트리·같은 상태 소스에서 조합된다 —
  RQ-50~55의 오버레이 HUD가 3D 렌더링과 공존해야 하는 요구에 직접 맞는다.
- Zustand는 서버 스냅샷(위치·HP·탄약·킬피드 등 30Hz 갱신, RQ-60)을 selector
  기반 구독으로 다뤄, 값이 안 바뀐 컴포넌트의 불필요한 리렌더를 피한다 —
  Redux 대비 보일러플레이트 없이 고빈도 갱신을 감당한다.
- Vite는 ESM 네이티브 dev 서버로 R3F/Three.js 생태계와 마찰이 적고 HMR이
  빠르다.
- **WebGL2 고정 + Chrome 단일 지원(RQ-01)**: WebGPU는 이 시점 three.js
  지원이 아직 실험적이고 브라우저별 활성화 상태가 다르다 — 폭넓게 안정적인
  WebGL2가 이 규모 프로젝트의 리스크를 줄인다. 단일 브라우저 타겟은
  크로스브라우저 입력 API·셰이더 분기 코드를 없애 개발 속도를 높인다.
- 버린 대안:
  - **순수 Three.js(프레임워크 없음)**: HUD(React)와 3D 씬의 상태 동기화를
    수작업 이벤트 배선으로 해야 해 컴포넌트화 이득이 사라진다. req/03이
    React를 이미 지정.
  - **Babylon.js**: req/03이 Three.js/R3F를 명시. 굳이 비교해도 R3F가 React
    생태계 통합(`@react-three/drei` 헬퍼 등)이 더 성숙하다.
  - **Redux/Redux Toolkit**: 보일러플레이트(액션·리듀서·슬라이스)가 30Hz
    갱신 상태에 비해 과하다. req/03이 Zustand를 명시.
  - **CRA/webpack**: dev 서버 기동·HMR이 Vite 대비 느리다. req/03이 Vite를
    명시.
  - **WebGPU 렌더러(three.js `WebGPURenderer`)**: 최신 GPU에서 성능 이점이
    있으나 이 시점 성숙도가 낮고 브라우저 지원이 고르지 않다 — RQ-01이
    WebGL2를 확정했으므로 채택하지 않는다.

## 결과

- React Three Fiber 버전이 Three.js 버전에 종속 — 호환 매트릭스를 계속
  관리해야 한다.
- Zustand 스토어는 서버 권위 상태([ADR-0003](0003-netcode-authority.md))의 **클라이언트
  측 캐시**일 뿐 진실 공급원이 아니다 — 이 경계를 흐려 Zustand에 게임 로직을
  얹으면 클라이언트-서버 상태가 어긋난다.
- React 리컨실리에이션 오버헤드가 프레임 예산을 잠식할 위험이 있다. R3F는
  `useFrame`으로 렌더 루프를 React 트리 밖에서 돌리지만, HUD 리렌더가
  과도하면 여전히 프레임 드랍 요인이 된다. 후회 지점: 총구 이펙트·파티클처럼
  고빈도 갱신 요소는 나중에 순수 imperative Three.js 루프로 빼야 할 수 있다.
- **iGPU 30fps 하한(RQ-01)이 렌더링 예산의 실질 기준선이다** — 인스턴싱
  상한(RQ-70/71 탄흔·혈흔), 드로우콜 수, 스프레이 아틀라스([ADR-0007](0007-map-asset-pipeline.md))
  같은 성능 결정을 이 하한을 기준으로 튜닝해야 한다. 상위 GPU에서는 여유가
  생기지만, 30fps 미만으로 떨어지는 것은 명시적 스펙 위반이다.
- Chrome 단일 지원은 브라우저 호환성 테스트 매트릭스를 없애지만, 사용자가
  다른 브라우저로 접속을 시도할 경우의 동작(차단? 경고? 무대응?)은 이
  ADR이 정하지 않는다 — 구현 시 결정할 세부 사항으로 남는다.
