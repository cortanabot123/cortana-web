import assert from "node:assert/strict"
import test from "node:test"
import { chromium } from "playwright-core"
import { createServer as createViteServer } from "vite"

const launchBrowser = () => chromium.launch({
  headless: true,
  executablePath: "/opt/hermes/tools/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
})

function installMockGateway(page) {
  return page.addInitScript(() => {
    class MockWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = MockWebSocket.CONNECTING
      onmessage = null
      onclose = null
      constructor() {
        queueMicrotask(() => {
          this.readyState = MockWebSocket.OPEN
          this.emit({ method: "event", params: { type: "gateway.ready", payload: {} } })
        })
      }
      emit(frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
      send(raw) {
        const frame = JSON.parse(raw)
        const result = (value) => this.emit({ jsonrpc: "2.0", id: frame.id, result: value })
        if (frame.method === "client.capabilities" || frame.method === "ping") result({})
        else if (frame.method === "session.create") result({ session_id: "theme-session", stored_session_id: "theme-session" })
        else if (frame.method === "prompt.submit") result({})
        else if (frame.method === "session.interrupt") result({})
      }
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
    }
    window.WebSocket = MockWebSocket
  })
}

const themeState = (page) => page.evaluate(() => ({
  dark: document.documentElement.classList.contains("dark"),
  dataTheme: document.documentElement.dataset.theme,
  colorScheme: getComputedStyle(document.documentElement).colorScheme,
  stored: window.localStorage.getItem("cortana-web.theme"),
  background: getComputedStyle(document.body).backgroundColor,
}))

test("theme menu switches and persists shadcn light/dark, and the context menu offers only upload", async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "light" })
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await installMockGateway(page)
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)

    // Default preference is "system", which resolves to light on a light OS.
    await page.getByRole("button", { name: "Theme: system" }).waitFor()
    const initial = await themeState(page)
    assert.equal(initial.dark, false, `system theme on a light OS must not be dark: ${JSON.stringify(initial)}`)
    assert.equal(initial.stored, null, "no preference is stored until the user picks one")

    await page.getByRole("button", { name: "Theme: system" }).click()
    await page.getByRole("menuitemradio", { name: "Dark" }).click()
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"))
    const dark = await themeState(page)
    assert.equal(dark.dataTheme, "dark")
    assert.equal(dark.colorScheme, "dark")
    assert.equal(dark.stored, "dark")
    assert.notEqual(dark.background, initial.background, "dark mode must change the shadcn background token")
    await page.getByRole("button", { name: "Theme: dark" }).waitFor()

    // The preference survives a reload and is applied before paint.
    await page.reload()
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"))
    assert.equal((await themeState(page)).dataTheme, "dark")

    await page.getByRole("button", { name: "Theme: dark" }).click()
    await page.getByRole("menuitemradio", { name: "Light" }).click()
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"))
    const light = await themeState(page)
    assert.equal(light.dataTheme, "light")
    assert.equal(light.stored, "light")
    assert.equal(light.background, initial.background)

    // The "+" menu keeps only the file upload entry.
    await page.getByRole("button", { name: "Add context" }).click()
    const items = await page.locator('[data-slot="dropdown-menu-item"]').allInnerTexts()
    assert.deepEqual(items.map((item) => item.replace(/\s+/g, " ").trim()), ["Add Photos & Files"])
    assert.equal(await page.getByText("Deep Research").count(), 0)
    assert.equal(await page.getByText("Web Search").count(), 0)
    const upload = page.getByRole("menuitem", { name: "Add Photos & Files" })
    assert.notEqual(await upload.getAttribute("aria-disabled"), "true", "upload entry must be enabled")
  } finally {
    await browser.close()
    await vite.close()
  }
})
