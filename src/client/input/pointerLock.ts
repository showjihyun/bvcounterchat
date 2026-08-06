/**
 * FPS 시점 조작을 위한 포인터 락 배선(`harness/workflow/fe.md` 입력 처리
 * 규칙 — "캔버스 클릭 시 요청, ESC/포커스 이탈 시 해제"). ESC·포커스 이탈
 * 시 해제는 Pointer Lock API 자체의 브라우저 표준 동작이다(사용자
 * 에이전트가 자동으로 락을 해제한다) — 별도 코드가 필요 없다.
 *
 * 락이 걸린 동안에는 커서가 숨고 브라우저 창을 벗어나지 않는다 — 그것이 FPS
 * 조작의 전제다. 락이 **걸리지 않으면** 마우스가 화면 밖으로 나가고
 * `mouseLook`이 mousemove를 전부 무시하므로(그 모듈이 `pointerLockElement`를
 * 검사한다) **시점이 아예 안 돈다.**
 *
 * ⚠️ **실패가 조용하면 안 된다**(원장 24e-2). 초안은 `canvas.requestPointerLock()`을
 * 부르고 결과를 보지 않았다 — 브라우저가 거절해도 아무 흔적이 없어 "마우스가
 * 화면을 넘어간다"는 증상만 남고 원인을 알 수 없었다. 거절은 드문 일이 아니다:
 * - **해제 직후 재요청**: ESC로 푼 뒤 짧은 시간(Chrome 기준 약 1초) 안에 다시
 *   요청하면 사용자 보호를 위해 거절된다.
 * - **문서 비포커스**: 다른 창을 보고 있으면 거절된다.
 *
 * 최신 브라우저의 `requestPointerLock()`은 **Promise를 반환**한다(구형은
 * `undefined`) — 둘 다 다루고 `pointerlockerror` 이벤트도 함께 듣는다.
 * Chrome은 실패 시 **둘 다** 내므로 요청 1회당 1번만 경고한다(PR #61 리뷰 minor).
 *
 * **이 모듈은 UI를 만들지 않는다.** 사용자에게 보이는 신호는 `LockHint`가
 * 맡는다 — 락이 걸리지 않으면 안내가 계속 떠 있다. 여기 남는 것은 개발자용
 * 콘솔 경고뿐이다(원인을 증상에서 추측하지 않게 한다).
 *
 * 렌더 계층 면제 대상 — 이 파일 자체는 테스트 없음(DOM API 배선), tsc·lint·
 * 빌드·수동 확인이 게이트다(ADR-0008 §6).
 */

export function attachPointerLock(canvas: HTMLCanvasElement): () => void {
  const doc = canvas.ownerDocument
  /** 이번 요청이 아직 경고를 내지 않았는가. Promise 거절과 `pointerlockerror`가
   * 같은 실패로 둘 다 오므로, 요청 단위로 1회만 통과시킨다. */
  let notifyArmed = false

  function notify(reason: string): void {
    if (!notifyArmed) return
    notifyArmed = false
    console.warn(`[pointerLock] 락 요청이 거절됐다: ${reason}`)
  }

  function requestLock(): void {
    if (doc.pointerLockElement === canvas) return
    notifyArmed = true
    let result: unknown
    try {
      result = canvas.requestPointerLock()
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : String(err))
      return
    }
    // 최신 브라우저는 Promise를 준다. 거절을 잡지 않으면 unhandled rejection이
    // 되고 원인이 콘솔에 애매하게 남는다.
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        notify(err instanceof Error ? err.message : String(err))
      })
    }
  }

  function onLockError(): void {
    // 구형 경로 — Promise를 안 주는 브라우저는 이 이벤트로만 알린다.
    notify('pointerlockerror')
  }

  canvas.addEventListener('click', requestLock)
  doc.addEventListener('pointerlockerror', onLockError)
  return () => {
    canvas.removeEventListener('click', requestLock)
    doc.removeEventListener('pointerlockerror', onLockError)
  }
}
