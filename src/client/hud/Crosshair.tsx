import { useEffect, useState } from 'react'
import type { StoreApi } from 'zustand/vanilla'
import type { UiStoreState } from '@client/store/uiStore'

/**
 * RQ-54 정식 크로스헤어(원장 24e) — `DESIGN.md` §3.1 십자 4선.
 *
 * **렌더 계층이라 테스트 면제 대상이다**(ADR-0008 §6, `fe.md`). 이 파일에는
 * 판단이 없다 — 간격 산술은 `@client/hud/crosshairSpread`(순수, 단위 테스트 있음)가
 * 하고 여기서는 그 결과를 CSS 커스텀 프로퍼티로 넘길 뿐이다. 22b가
 * `aimMath`·`cameraLook`을 분리한 것과 같은 구조다.
 *
 * ⚠️ **간격을 인라인 style로 넘기는 이유**: 값이 매 tier 전환마다 바뀌므로
 * 정적 CSS로는 표현할 수 없다. `--crosshair-gap-live`라는 **한 변수만** 지역
 * 스코프로 덮고 나머지(길이·굵기·색)는 `index.css`가 토큰에서 읽는다 — 즉
 * 리터럴이 컴포넌트로 새지 않는다(원장 24a 규약).
 *
 * ⚠️ **선 4개를 각각 그리는 이유**: 중앙에 간격이 있는 십자라 하나의 사각형으로는
 * 표현되지 않는다. 각 선은 `.hud__crosshair-line--{up,down,left,right}`가 위치를
 * 잡는다.
 */
export function Crosshair({ uiStore }: { uiStore: StoreApi<UiStoreState> }) {
  const [gapPx, setGapPx] = useState(() => uiStore.getState().crosshairGapPx)

  useEffect(() => {
    // 구독 시점과 첫 렌더 사이에 값이 바뀌었을 수 있다 — 한 번 맞추고 시작한다.
    setGapPx(uiStore.getState().crosshairGapPx)
    return uiStore.subscribe((state) => {
      setGapPx(state.crosshairGapPx)
    })
  }, [uiStore])

  return (
    <div
      className="hud__crosshair"
      aria-hidden="true"
      style={{ '--crosshair-gap-live': `${gapPx}px` } as React.CSSProperties}
    >
      <span className="hud__crosshair-line hud__crosshair-line--up" />
      <span className="hud__crosshair-line hud__crosshair-line--down" />
      <span className="hud__crosshair-line hud__crosshair-line--left" />
      <span className="hud__crosshair-line hud__crosshair-line--right" />
    </div>
  )
}
