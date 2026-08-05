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
 * - **3D 씬 색**(하늘·바닥·플레이어)은 `GameScene.tsx`·`PlayerMeshes.tsx`가 리터럴로
 *   그대로 갖는다 — HUD 토큰이 아니고 이 라운드는 **바꾸지 않는다**.
 *   ⚠️ 그래서 그쪽에는 **코드 정본이 없고 DESIGN.md §2.1의 표만 값을 갖는다** —
 *   1차 리뷰 blocker가 정확히 그 구멍에서 나왔다(문서가 하늘을 바닥이라 적고,
 *   렌더되지도 않는 벽·박스·사다리에 색을 배정했는데 대조할 코드 상수가 없었다).
 *   상수 이관은 **원장 24c**로 이월했다. **벽·박스·사다리는 클라에 렌더 메시가
 *   아직 없다**(판정 전용 `@shared/sim/{walls,boxes,ladders}`).
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
 * 여기 복제하지 않는다.
 *
 * ⚠️ **크로스헤어는 예측 표시다.** 실제 편차는 서버가 시드로 정하고 클라는 그
 * 시드를 알 수 없다(RQ-90 / 원장 22v) — 간격은 "이만큼 퍼질 수 있다"는 안내이지
 * 탄착점이 아니다. */
export const CROSSHAIR = {
  lengthPx: 6,
  thicknessPx: 2,
  gapPx: 4,
  /** ⚠️ **22b 임시 점의 지름** — §3.1 정식 십자(선 굵기 `thicknessPx`)와 **다른
   * 양**이다. 초안이 토큰화하면서 선 굵기(2px)를 이 자리에 물려 **조준점이 4px에서
   * 2px로 절반이 됐고**(1차 리뷰 major) 그 점은 "조준점이 없으면 어디를 쏘는지 알 수
   * 없어 사격 자체를 확인할 수 없다"는 이유로 존재하는 자리표시다.
   * **§3.1 정식 십자를 만드는 라운드가 이 값을 제거한다.** */
  dotPx: 4,
} as const

/** 미니맵(DESIGN.md §3.5). 축척은 `WORLD.SIZE_M`에서 유도한다 —
 * `sizePx / WORLD.SIZE_M`이 px/m다. 여기에 60을 적지 않는 이유는 맵 크기가
 * 바뀌면 축척이 따라 바뀌어야 하기 때문이다. */
export const MINIMAP = { sizePx: 160 } as const

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
    '--crosshair-dot': `${CROSSHAIR.dotPx}px`,
  }
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value)
  }
}
