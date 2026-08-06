import { useEffect, useState } from 'react'
import type { StoreApi } from 'zustand/vanilla'
import type { UiStoreState } from '@client/store/uiStore'

/**
 * RQ-56 이름표(원장 24ab) — 조준선이 향한 플레이어의 닉네임을 그 머리 위에 띄운다.
 *
 * **왜 캔버스 밖 DOM인가**: 글자는 HUD 레이어가 가장 잘 그린다(선명도·폰트 상속).
 * 대상이 **한 번에 하나뿐**이라 요소도 하나이고, 위치 갱신은 30Hz 루프가
 * `uiStore`에 밀어 넣은 화면 좌표를 그대로 쓴다 — 이 컴포넌트는 계산하지 않는다.
 *
 * ⚠️ **상시 표시가 아니다.** RQ-56이 조준 시에만으로 한정한 이유는 상시 표시가
 * 벽 너머 위치까지 흘려 RQ-31의 캠핑 방지 의도·`DESIGN.md` §3.5("동적 전술
 * 정보는 미니맵에 넣지 않는다")와 어긋나기 때문이다.
 *
 * ⚠️ **시각 디자인은 `DESIGN.md`가 정하지 않았다** — RQ-56이 §3에 들어오기 전에
 * 구현됐다. 토큰만 쓰고(리터럴 금지, 원장 24a) 정식 스타일은 RQ-50~55 라운드가
 * 하단 HUD를 정할 때 함께 본다.
 *
 * 렌더 계층 면제 대상(ADR-0008 §6) — 대상 판정은 `@client/hud/nameplateTarget`이
 * 순수 함수로 갖고 그쪽이 단위 테스트된다.
 */
export function Nameplate({ uiStore }: { uiStore: StoreApi<UiStoreState> }) {
  const [nameplate, setNameplate] = useState(() => uiStore.getState().nameplate)

  useEffect(() => {
    setNameplate(uiStore.getState().nameplate)
    return uiStore.subscribe((state) => {
      setNameplate(state.nameplate)
    })
  }, [uiStore])

  if (!nameplate) return null

  return (
    <span
      className="hud__nameplate"
      // 좌표는 매 조준마다 바뀌므로 인라인이 유일한 선택이다 — CSS 변수로 빼도
      // 결국 인라인으로 심어야 한다(크로스헤어 `--crosshair-gap-live`와 달리
      // 여기는 x·y 두 축이고 기본값이 의미가 없다).
      style={{ left: `${nameplate.xPx}px`, top: `${nameplate.yPx}px` }}
    >
      {nameplate.nickname}
    </span>
  )
}
