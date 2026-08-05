import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@client/App'
import { applyDesignTokens } from '@client/config/design-tokens'
import '@client/index.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root를 찾을 수 없다 — index.html 확인')

// 원장 24a — DESIGN.md 토큰을 :root에 심는다. `index.css`는 리터럴 대신
// 여기서 심어진 var(--*)만 참조한다(design-tokens.ts가 정본).
applyDesignTokens(document.documentElement)

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
