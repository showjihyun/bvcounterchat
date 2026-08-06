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
/** 채팅 패널(DESIGN.md §3.3) — RQ-52가 정한 **좌하단**을 유지하되 바닥에서
 * 얼마나 띄울지(원장 24m, 사용자 요구). 가장자리 여백(`EDGE_INSET`)에 **더해지는**
 * 값이라 0이면 종전 위치다.
 *
 * ⚠️ 사분면을 바꾸는 값이 아니다 — 우하단으로 옮기는 것은 RQ-52·RQ-53을 동시에
 * 뒤집는 일이라 스펙 개정이 선행이다(PR #61 델타 리뷰 minor). 이 값을 화면 높이에
 * 근접하게 키우면 그 선을 넘으므로, 바꿀 때 사분면이 유지되는지 함께 본다. */
export const CHAT = { bottomOffsetPx: 100 } as const

export const MINIMAP = { sizePx: 160 } as const

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
  /**
   * 벽 렌더 높이(m). **판정은 무한 높이**이고(`@shared/sim/walls` — ADR-0013)
   * 이 값은 **표현 전용**이라 서버·예측 어디에도 들어가지 않는다.
   *
   * 4m는 사다리 꼭대기(`LADDER_ALPHA.maxY`)에서 가져왔다. **스펙에 벽 높이가
   * 없어**(RQ-30은 플레이 면적만 규정) 스펙 값이 아니라 렌더 선택값이다.
   *
   * ⚠️ **이 값은 오늘 이미 부족하다**(PR #61 리뷰 major). 카메라는 발이 아니라
   * **눈**에 있다(`PlayerControls`가 발 + `eyeHeightM` 1.7m). 사다리 꼭대기에 선
   * 플레이어의 시점은 **5.7m**로 그려진 벽 윗면보다 1.7m 위이고, 점프(RQ-92 1.0m)를
   * 더하면 6.7m다. 즉 **사다리 위에서는 벽 너머가 보이는데** 그 방향으로 쏜 탄은
   * 판정상 무한 높이인 기둥에 **조용히 막힌다**(`intersectWallXZ`에는 Y 경계가 없다).
   * 지상에서 위로 각을 준 사격도 같다.
   *
   * 값을 올릴지(6.7m 이상) ADR-0013을 유한 높이 벽으로 개정할지는 **원장 24g**가
   * 갖는다 — 지금 올리면 판정 모델과의 관계를 정하지 않은 채 숫자만 바뀐다.
   */
  wallRenderHeightM: 4,
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
  }
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value)
  }
}
