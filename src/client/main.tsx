import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@client/App'
import '@client/index.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root를 찾을 수 없다 — index.html 확인')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
