/**
 * FPS 시점 조작을 위한 포인터 락 배선(`harness/workflow/fe.md` 입력 처리
 * 규칙 — "캔버스 클릭 시 요청, ESC/포커스 이탈 시 해제"). ESC·포커스 이탈
 * 시 해제는 Pointer Lock API 자체의 브라우저 표준 동작이다(사용자
 * 에이전트가 자동으로 락을 해제한다) — 별도 코드가 필요 없다. 이 함수는
 * "클릭 시 요청" 절반만 배선한다.
 *
 * 마우스 이동으로 카메라를 회전시키는 시점 조작(look) 자체는 이 RQ의
 * 스코프 밖이다(team-lead 지시 — RQ-62는 이동 입력 전송+포인터 락 배선까지,
 * 조준·사격은 후속). 렌더 계층 면제 대상 — 테스트 없음, tsc·lint·빌드·
 * 수동 확인이 게이트다.
 */
export function attachPointerLock(canvas: HTMLCanvasElement): () => void {
  function requestLock(): void {
    canvas.requestPointerLock()
  }

  canvas.addEventListener('click', requestLock)
  return () => {
    canvas.removeEventListener('click', requestLock)
  }
}
