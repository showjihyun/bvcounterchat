# syntax=docker/dockerfile:1
# RQ-80 — 배포 이미지 (ADR-0009: Docker + Nginx, 단일 호스트).
#
# 멀티스테이지 + 멀티타깃 구성:
#   deps       — 전체 의존성(dev 포함) 설치. 빌드(vite)에 필요.
#   build      — 클라이언트(dist/client) + 서버(dist/server) 번들.
#   prod-deps  — 프로덕션 의존성만 설치(런타임 이미지 축소).
#   server     — 최종 런타임 이미지 (compose의 `app` 서비스). `npm start`가
#                실행하는 `dist/server/index.js`만 담는다.
#   web        — 최종 런타임 이미지 (compose의 `nginx` 서비스). `build` 스테이지의
#                `dist/client`를 nginx 베이스 이미지에 구워 넣는다 — 서버·클라
#                산출물이 같은 `build` 스테이지(=같은 커밋)에서 나오므로 배포
#                단위 간 산출물 불일치가 구조적으로 불가능하다. 컨테이너 간
#                런타임 볼륨 공유(정적 자산용)보다 이 편이 재현성이 높고
#                단순하다 — nginx 컨테이너가 뜨는 순간 이미 정적 자산이
#                이미지 안에 있다(부트 순서 경합 없음).
#
# node20 고정: package.json engines(">=20")·vite.server.config.ts의
# `target: 'node20'`와 정합.

FROM node:20-alpine AS base
WORKDIR /app

# ---- deps: 빌드에 필요한 전체 의존성 (devDependencies 포함) ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: 클라이언트 + 서버 번들 (vite) ----
FROM deps AS build
COPY . .
RUN npm run build

# ---- prod-deps: 런타임 전용 의존성 (레이어 캐시 분리 — 소스 변경이
#      이 레이어를 무효화하지 않는다) ----
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- server: 게임 서버 런타임 이미지 (compose `app`) ----
FROM base AS server
ENV NODE_ENV=production
# ESM 모듈 해석("type": "module")에 필요하다 — package.json 없이는
# node가 dist/server/index.js를 CommonJS로 잘못 해석한다.
COPY package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist/server ./dist/server

# 루트가 아닌 사용자로 실행 — node:*-alpine 베이스 이미지가 기본 제공하는
# 비특권 계정(uid 1000)을 그대로 쓴다(별도 useradd 불필요).
USER node

EXPOSE 2567

# ADR-0009: 이 헬스체크가 GA-41·GA-43(재시작 후 /health 200 복구)이 기대하는
# 컨테이너 상태 신호다. curl은 alpine 기본 이미지에 없어 busybox wget을 쓴다.
# retries=5는 docker-compose.yml의 app healthcheck와 같은 값이다(리뷰 minor
# 5) — compose가 이 이미지 기본값을 덮어쓰므로(compose 안에서 기동하는 한
# compose 쪽이 유효), 두 값이 갈리면 어느 쪽이 실제로 적용되는지 읽는
# 사람이 헷갈린다. 이 HEALTHCHECK 자체는 `docker run`으로 compose 없이
# 단독 기동할 때를 위해 남겨둔다.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -q -O /dev/null --spider http://127.0.0.1:2567/health || exit 1

CMD ["node", "dist/server/index.js"]

# ---- web: 정적 클라이언트 + 리버스 프록시 이미지 (compose `nginx`) ----
FROM nginx:1.27-alpine AS web
COPY --from=build /app/dist/client /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# nginx 자신의 생존만 확인한다(정적 index.html 응답) — 백엔드(app)
# 상태와 결합하지 않는다: app이 죽어도 nginx는 정적 자산을 계속 서빙할 수
# 있어야 하므로, 이 헬스체크가 app 프록시 경로(/health)에 의존하면
# 두 컨테이너의 장애가 뒤섞여 원인 파악이 어려워진다. app 자체의 헬스
# (GA-41·GA-43)은 스모크 스크립트가 nginx를 거쳐 /health를 직접 요청해
# 별도로 검증한다. retries=5는 docker-compose.yml의 nginx healthcheck와
# 같은 값이다(리뷰 minor 5, server 스테이지와 동일한 이유).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null --spider http://127.0.0.1/ || exit 1
