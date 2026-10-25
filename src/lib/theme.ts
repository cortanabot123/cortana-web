/**
 * shadcn/ui light + dark theming for Cortana Web.
 *
 * The palette lives in `index.css` (`.dark` overrides the `:root` tokens), so all this
 * module does is decide which theme is active, put `dark` on <html>, and persist the
 * preference. `system` follows the OS and re-applies when the OS preference changes.
 */

export type ThemePreference = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"

export const THEME_STORAGE_KEY = "cortana-web.theme"

const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: "#ffffff",
  dark: "#171717",
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system"
}

export function loadThemePreference(storage?: Pick<Storage, "getItem">): ThemePreference {
  try {
    const stored = (storage ?? window.localStorage).getItem(THEME_STORAGE_KEY)
    if (isThemePreference(stored)) return stored
  } catch {
    // Private-mode / disabled storage: fall through to the system preference.
  }
  return "system"
}

export function saveThemePreference(preference: ThemePreference, storage?: Pick<Storage, "setItem">) {
  try {
    ;(storage ?? window.localStorage).setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Persisting is best effort; the applied theme is still correct for this session.
  }
}

export function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference
}

/** Applies the resolved theme to <html> and returns what was applied. */
export function applyTheme(preference: ThemePreference, root: HTMLElement = document.documentElement): ResolvedTheme {
  const resolved = resolveTheme(preference)
  root.classList.toggle("dark", resolved === "dark")
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute("content", THEME_COLOR[resolved])
  return resolved
}

/** Keeps `system` in sync with the OS while it is the active preference. */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {}
  const query = window.matchMedia("(prefers-color-scheme: dark)")
  const listener = () => onChange()
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}
