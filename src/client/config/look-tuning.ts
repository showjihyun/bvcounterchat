/**
 * 마우스 룩 감도(22b) — 스펙 미기재 구현 선택값. `harness/workflow/fe.md`
 * "키 바인딩 소스"와 같은 성격이다: 재조정 UI는 스펙에 없으므로 클라이언트
 * 설정 파일에 고정값으로 둔다(`src/client/input/keymap.ts` 선례).
 *
 * 단위는 라디안/픽셀 — 마우스 1px 이동당 회전각(`@client/input/aimMath`의
 * `accumulateLook`이 소비). 0.002rad/px는 일반적인 FPS 감도 범위(대략
 * 0.001~0.004rad/px)의 중간값이다 — 실측 플레이테스트로 조정 가능한 슬롯.
 */
export const MOUSE_SENSITIVITY_RAD_PER_PX = 0.002
