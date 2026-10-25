import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyTheme, loadThemePreference } from './lib/theme.ts'

const root = document.getElementById('root')!
root.dataset.build = __CORTANA_BUILD_ID__

// Apply the saved (or system) theme before the first paint so dark mode never flashes light.
applyTheme(loadThemePreference())

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {})
  })
}
