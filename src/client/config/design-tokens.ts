/**
 * 원장 24a — `docs/design/DESIGN.md` §2의 **정본**. 그 문서의 표는 미러이고
 * 어긋나면 **이 파일이 이긴다**(ADR-0010 값 복제 금지와 같은 원리 — 사용자
 * 결정 2026-08-05 "토큰을 코드 상수로").
 *
 * **쓰는 법**: `applyDesignTokens()`가 `:root`에 CSS 커스텀 프로퍼티를 심고,
 * `index.css`는 `var(--hud-fg)`처럼 그 이름만 참조한다. 즉 색·간격 리터럴이
 * CSS에 다시 등장하면 그것은 드리프트다 — 리뷰가 볼 지점이다.
 *
 * ⚠️ **여기 없는 값**:
 * - **탄퍼짐 배율**(크로스헤어 확장)은 `@shared/config/combat-tuning`의
 *   `DEFAULT_SPREAD`가 정본이다. 여기 복제하지 않는다 — RQ-90의 값이지 디자인
 *   값이 아니다.
 * - **상태 지속 시간**(재장전·리스폰·스폰 보호)은 `@shared/constants`가 정본이다.
 */

/** 색 — 대부분 기존 `index.css`에 있던 값을 정본으로 승격한 것이다. */
export const COLOR = {
  /** 캔버스 밖 배경(입장 화면). */
  bgApp: '#1a1713',
  /** 기본 텍스트. */
  fg: '#e8e0d4',
  /** 크로스헤어·강조 수치. */
  fgStrong: '#f2f2f2',
  /** 보조 텍스트 — 기존 `opacity: 0.6`을 색으로 고정한 것이다. */
  fgMuted: 'rgb(232 224 212 / 60%)',
  /** 읽기 전용 패널(채팅 로그·킬 피드·미니맵). */
  panel: 'rgb(0 0 0 / 35%)',
  /** 입력 요소 배경. */
  panelStrong: 'rgb(0 0 0 / 45%)',
  /** 패널·입력 테두리. */
  border: 'rgb(255 255 255 / 20%)',
  /** 오류·저HP·헤드샷. */
  danger: '#e07a7a',
  /** 자신 관련 강조(미니맵 자기 표시·킬 피드 자기 관여). **이 라운드 신규** —
   * `danger`의 보색 축에서 골라 두 강조가 서로 섞이지 않게 했다. */
  accent: '#7ab8e0',
} as const

/** 배경 없는 텍스트(크로스헤어 등)의 가독성 보조. */
export const TEXT_SHADOW = '0 0 2px rgb(0 0 0 / 80%)'

/** 타이포 — 2단계 + 강조 하나. HUD는 읽는 문서가 아니라 곁눈질하는 계기판이라
 * 위계가 얕을수록 낫다(DESIGN.md §2.2). */
export const TYPO = {
  family: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  sizeSm: '0.8rem',
  sizeMd: '0.85rem',
  sizeLg: '1.5rem',
  weightStrong: '600',
} as const

/** 간격 — 4px 배수. 기존 CSS가 이미 쓰던 값을 규칙으로 승격했다. */
export const SPACE = {
  s1: '0.25rem',
  s2: '0.5rem',
  s3: '1rem',
  s4: '1.5rem',
  radius: '4px',
} as const

/** 화면 가장자리 여백 — 모든 HUD 요소가 이 값을 쓴다(기존 `1rem`과 같다). */
export const EDGE_INSET = SPACE.s3

/** 크로스헤어 기하(DESIGN.md §3.1).
 *
 * `gapPx`는 **정지·앉기(콘 ×1)일 때의 값**이다. 실제 간격은
 * `gapPx × (현재 콘 배율)`이고 그 배율의 정본은 `DEFAULT_SPREAD`다 —
 * 여기 복제하지 않는다. 계산은 `@client/hud/crosshairSpread`가 하고(원장 24e)
 * 결과를 `--crosshair-gap-live`로 심는다.
 *
 * ⚠️ **크로스헤어는 예측 표시다.** 실제 편차는 서버가 시드로 정하고 클라는 그
 * 시드를 알 수 없다(RQ-90 / 원장 22v) — 간격은 "이만큼 퍼질 수 있다"는 안내이지
 * 탄착점이 아니다. */
export const CROSSHAIR = {
  lengthPx: 6,
  thicknessPx: 2,
  gapPx: 4,
} as const

/** 미니맵(DESIGN.md §3.5). 축척은 `WORLD.SIZE_M`에서 유도한다 —
 * `sizePx / WORLD.SIZE_M`이 px/m다. 여기에 60을 적지 않는 이유는 맵 크기가
 * 바뀌면 축척이 따라 바뀌어야 하기 때문이다. */
export const MINIMAP = { sizePx: 160 } as const

/** 채팅 패널(DESIGN.md §3.3) — RQ-52가 정한 **좌하단**을 유지하되 바닥에서
 * 얼마나 띄울지(원장 24m, 사용자 요구). 가장자리 여백(`EDGE_INSET`)에 **더해지는**
 * 값이라 0이면 종전 위치다.
 *
 * ⚠️ 사분면을 바꾸는 값이 아니다 — 우하단으로 옮기는 것은 RQ-52·RQ-53을 동시에
 * 뒤집는 일이라 스펙 개정이 선행이다(PR #61 델타 리뷰 minor). 이 값을 화면 높이에
 * 근접하게 키우면 그 선을 넘으므로, 바꿀 때 사분면이 유지되는지 함께 본다. */
export const CHAT = { bottomOffsetPx: 100 } as const

/**
 * **3D 씬 정본**(원장 24c — 착수 트리거 "맵 지오메트리 렌더가 클라이언트에 처음
 * 들어오는 PR"이 원장 24f에서 도래했다). 이전엔 `GameScene.tsx`·`PlayerMeshes.tsx`가
 * 색 리터럴을 직접 갖고 **코드 정본이 없어** `DESIGN.md` §2.1의 표만 값을 가졌다 —
 * 24a 1차 리뷰 blocker가 정확히 그 구멍에서 나왔다(문서가 하늘을 바닥이라 적었고,
 * 렌더되지도 않는 벽·박스·사다리에 색을 배정했는데 **대조할 코드 상수가 없었다**).
 *
 * 24c가 이 지점을 트리거로 고른 이유가 그대로 적중했다 — 벽·박스·사다리에 **새
 * 머티리얼 색을 정해야 하는 PR**이 곧 이 PR이고, 24c가 경고한 "벽 색이 바닥 색과
 * 같아지는 사고"를 막는 자리도 여기다. 아래 세 색은 바닥(`ground`)과 명도가
 * 뚜렷이 갈리도록 골랐다 — 벽은 더 밝게, 박스는 더 어둡게, 사다리는 색상 자체를
 * 분리한다(사암 계열 안에서 채도만 다르면 역광에서 뭉친다).
 *
 * **이관이지 재도색이 아니다**: 기존 5개(`sky`·`ground`·`groundLight`·`self`·`other`)는
 * 값이 그대로다. 신규는 벽·박스·사다리 3색과 `wallRenderHeightM`뿐이다.
 */
export const SCENE = {
  /** 하늘 = 캔버스 배경(`<color attach="background">`). ⚠️ 바닥이 아니다. */
  sky: '#c2b49a',
  /** 바닥 평면. */
  ground: '#8a7a5c',
  /** 반구광 `groundColor` — 바닥에서 올라오는 반사광이라 바닥과 같은 값이다. */
  groundLight: '#8a7a5c',
  /** 자기 자신(1인칭이라 평소엔 안 보인다 — 관전·리플레이용). */
  self: '#5b8dd6',
  /** 다른 플레이어. */
  other: '#c65b5b',
  /** 벽(RQ-30) — 바닥보다 밝게. */
  wall: '#b9ac91',
  /** 박스(RQ-32) — 바닥보다 어둡게. */
  box: '#6b5d45',
  /** 사다리(RQ-32) — 유일하게 색상을 뗀 값. 등반 지점은 즉시 식별돼야 한다. */
  ladder: '#4a4640',
  /** 고지대 플랫폼(RQ-33) — 벽보다 어둡고 바닥보다 밝다. 넷(벽·플랫폼·바닥·박스)이
   * 명도로 갈라져야 어느 것이 오를 수 있는 구조물인지 한눈에 읽힌다. */
  platform: '#a89574',
  /**
   * 사다리 뼈대 치수(m, 원장 24t) — 볼륨을 통짜로 그리지 않고 **등반면에
   * 세로 레일 2개 + 가로대**로 그린다. 산술은 `@client/scene/ladderGeometry`가
   * 하고 이 값들이 그 인자다.
   *
   * ⚠️ **스펙에 근거가 없는 렌더 선택값이다** — RQ-21/RQ-32는 사다리의 위치와
   * 이동 규칙만 정하고 생김새를 정하지 않는다. 값의 근거는 사람 몸 치수다:
   * 가로대 간격 0.3m는 한 발씩 딛는 보폭이고(너무 좁으면 격자처럼 뭉치고
   * 너무 넓으면 사다리로 안 읽힌다), 굵기 0.06/0.05m는 4m 거리에서 선으로
   * 뭉개지지 않는 최소 굵기다.
   */
  ladderRailThicknessM: 0.06,
  ladderRungThicknessM: 0.05,
  ladderRungSpacingM: 0.3,
  /**
   * 벽 렌더 높이(m). **판정은 무한 높이**이고(`@shared/sim/walls` — ADR-0013)
   * 이 값은 **표현 전용**이라 서버·예측 어디에도 들어가지 않는다.
   *
   * **원장 24g 처분(사용자 결정 2026-08-12)**: 유한 높이 판정으로 바꾸는
   * 대신(ADR-0013의 "벽=무한 기둥 / 박스=유한" 어휘와 이동 충돌 계층을
   * 그대로 두고) 렌더 높이만 올린다. 옛 값 4m는 사다리 발 높이
   * (`highestReachableFootY`, `LADDER_ALPHA.maxY`)만 기준으로 삼았는데,
   * 카메라는 발이 아니라 **눈**에 있다(`PlayerControls`가 발 +
   * `DEFAULT_HITBOX.eyeHeightM`으로 카메라를 둔다) — 사다리 꼭대기에 선
   * 플레이어의 시점은 4 + 1.7(`eyeHeightM`) = 5.7m로, 그려진 벽 윗면(4m)보다
   * 1.7m 위다. 점프(`MOVEMENT.JUMP_HEIGHT` 1.0m)를 더하면 6.7m — 그 방향으로
   * 수평 사격하면 서버는 5.7~6.7m 높이의 벽 명중을 내는데(판정은 무한 기둥)
   * 화면에는 **벽 위 허공에 탄흔이 뜬다**(ADR-0016 결정 후속 2). 렌더를
   * 처음 켜는 이 라운드(RQ-70·71 2/2)가 그 괴리를 화면에 드러내므로 여기서
   * 정리한다.
   *
   * 유도식: `highestReachableFootY`(4, 사다리 꼭대기) + `DEFAULT_HITBOX
   * .eyeHeightM`(1.7) + `MOVEMENT.JUMP_HEIGHT`(1.0) = **6.7**. 이 유도의
   * 정본 상수 기준식은 `tests/unit/24f-map-render-geometry.test.ts`가 값으로
   * 잠갔다(사다리가 높아지거나 눈높이가 바뀌면 그 테스트가 먼저 실패한다) —
   * 이 값 자체는 디자인 토큰의 성격상 리터럴로 둔다.
   *
   * ⚠️ **스펙에 근거가 없는 렌더 선택값이다**(PR #61 리뷰 major 원문 그대로
   * 유효) — RQ-30은 플레이 면적만 규정하고 벽 높이를 정하지 않는다.
   */
  wallRenderHeightM: 6.7,
} as const

/**
 * 명중 피드백 데칼(RQ-70 탄흔·RQ-71 피격 효과, ADR-0016) — 원장 24ce/24cf
 * 렌더 라운드(RQ-70·71 2/2) 신규. 판정·수집(`@client/effects/hitFeedback`)이
 * 정한 좌표·법선을 `@client/scene/decalLayout`이 인스턴스 행렬로 환산하고,
 * `HitDecals.tsx`가 이 토큰으로 지오메트리·머티리얼을 만든다.
 *
 * ⚠️ 탄흔과 피격 효과는 **같은 코드 경로**(법선 정렬 원형 데칼)를 쓰고
 * 색·크기만 다르다(사용자 결정) — 제거 규칙(개수 상한 vs TTL)이 다를 뿐
 * 그리는 방식은 대칭이다(`harness/workflow/fe.md` "효과 처리").
 *
 * ⚠️ **개수 상한(탄흔 64)·GPU 버퍼 용량(피격 효과)은 여기 없다** — 그건
 * 디자인 값이 아니라 제거 규칙/버퍼 크기이고, 정본은 각각
 * `EFFECTS.BULLET_HOLE_CAP`(`@shared/constants`)와 `HitDecals.tsx` 자신의
 * 상수다(ADR-0016 결정 2 — 피격 효과에 개수 상한을 두면 위반이므로 그
 * 상수는 "제거 규칙"이 아니라 "버퍼 보호"임을 그 파일이 스스로 밝힌다).
 */
/**
 * 히트마커(RQ-57, 원장 24cv) — 크로스헤어(RQ-54) 위에 겹치는 일시적 X 표시.
 * `Crosshair.tsx`의 4선(`hud__crosshair-line`)과 대칭인 형태 — 두 짧은
 * 대각선을 겹쳐 X를 만든다. 지속 시간은 **디자인 값이 아니라 튜닝값**이라
 * 여기 없다 — 정본은 `@shared/config/effects-tuning`의
 * `EFFECTS_TUNING.HIT_MARKER_DURATION_MS`(ADR-0016 결정 3, "지속 시간은
 * 스펙이 규정하지 않은 구현 세부").
 */
export const HIT_MARKER = {
  /** 대각선 한 변 길이(px) — 크로스헤어 선 길이(6px)보다 살짝 커서 겹쳐도
   * 구분된다. */
  sizePx: 14,
  thicknessPx: 3,
  /** `--danger`(빨강 계열) 재사용 — "명중=피해 확인"이라는 의미가
   * 저HP·헤드샷과 같은 색 계열이라 새 색을 발명하지 않는다. */
  color: COLOR.danger,
} as const

/**
 * 피격 방향(RQ-58, 원장 24cv) — 화면 가장자리 방향성 그라데이션. 지속
 * 시간은 튜닝값이라 여기 없다(정본은
 * `EFFECTS_TUNING.HIT_DIRECTION_DURATION_MS`).
 */
export const HIT_DIRECTION = {
  /** 가장자리에서 안쪽으로 번지는 폭 — 화면 짧은 변 대비 비율(%). 정밀
   * 좌표가 아니라 "가장자리가 물든다"는 느낌만 준다(RQ-58 "정밀 각도·
   * 좌표를 주지 않는다"). */
  spreadPercent: 35,
  color: COLOR.danger,
  maxOpacity: 0.45,
} as const

export const DECAL = {
  /** 표면에서 띄우는 거리(m) — z-fighting 방지. `syncDecalInstances`의
   * `offsetM` 인자로 그대로 넘어간다. 탄흔·피격 효과 공용(같은 코드 경로). */
  offsetM: 0.01,
  /** 탄흔(RQ-70) — 총알 구멍이라 작고 어둡다. */
  bulletHoleRadiusM: 0.05,
  bulletHoleColor: '#1a1613',
  /** 피격 효과(RQ-71, 혈흔) — "순간의 신호"라 탄흔보다 크고 눈에 띄는
   * 색으로 골랐다(짧은 TTL 동안 한눈에 "방금 맞았다"가 읽혀야 한다). */
  hitEffectRadiusM: 0.12,
  hitEffectColor: '#7a1414',
} as const

/** 상위 스코어러 표시 인원(DESIGN.md §3.6).
 *
 * ⚠️ **RQ-51은 인원을 정하지 않는다** — 이 값은 **디자인 결정**이다(정원 10명의
 * 상위 30%). 스펙 값이 되어야 한다고 판단되면 **RQ-51 개정이 먼저**다. */
export const TOP_SCORER_COUNT = 3

/** 저HP 경고 임계는 `WEAPON.DAMAGE_BODY`에서 **유도한다** — "바디 한 발 더
 * 맞으면 죽는다"가 경고의 뜻이지 임의의 백분율이 아니다(DESIGN.md §3.2).
 * 그래서 상수를 여기 두지 않고 소비처가 `DAMAGE_BODY`를 읽는다. */

/** 토큰을 `:root`의 CSS 커스텀 프로퍼티로 심는다. 앱 부팅 시 1회 호출한다. */
export function applyDesignTokens(root: HTMLElement): void {
  const vars: Record<string, string> = {
    '--bg-app': COLOR.bgApp,
    '--fg': COLOR.fg,
    '--fg-strong': COLOR.fgStrong,
    '--fg-muted': COLOR.fgMuted,
    '--panel': COLOR.panel,
    '--panel-strong': COLOR.panelStrong,
    '--border': COLOR.border,
    '--danger': COLOR.danger,
    '--accent': COLOR.accent,
    '--shadow-text': TEXT_SHADOW,
    '--font': TYPO.family,
    '--size-sm': TYPO.sizeSm,
    '--size-md': TYPO.sizeMd,
    '--size-lg': TYPO.sizeLg,
    '--weight-strong': TYPO.weightStrong,
    '--space-1': SPACE.s1,
    '--space-2': SPACE.s2,
    '--space-3': SPACE.s3,
    '--space-4': SPACE.s4,
    '--radius': SPACE.radius,
    '--edge-inset': EDGE_INSET,
    '--crosshair-length': `${CROSSHAIR.lengthPx}px`,
    '--crosshair-thickness': `${CROSSHAIR.thicknessPx}px`,
    '--crosshair-gap': `${CROSSHAIR.gapPx}px`,
    '--chat-bottom-offset': `${CHAT.bottomOffsetPx}px`,
    '--hit-marker-size': `${HIT_MARKER.sizePx}px`,
    '--hit-marker-thickness': `${HIT_MARKER.thicknessPx}px`,
    '--hit-marker-color': HIT_MARKER.color,
    '--hit-direction-spread': `${HIT_DIRECTION.spreadPercent}%`,
    '--hit-direction-color': HIT_DIRECTION.color,
    '--hit-direction-max-opacity': `${HIT_DIRECTION.maxOpacity}`,
  }
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value)
  }
}
