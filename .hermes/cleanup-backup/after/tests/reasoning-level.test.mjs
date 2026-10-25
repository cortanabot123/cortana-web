import assert from "node:assert/strict"
import test from "node:test"
import { chromium } from "playwright-core"
import { createServer as createViteServer } from "vite"

// These cases each boot a Vite server plus a Chromium instance. Running them concurrently in one
// file starves the machine (module graph cold starts exceed Playwright's navigation timeout), so
// they are serialized here only; the rest of the suite keeps `node --test` defaults.
const serial = (name, run) => test(name, { concurrency: false }, run)

const launchBrowser = () => chromium.launch({
  headless: true,
  executablePath: "/opt/hermes/tools/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
})

/**
 * Mock gateway that answers config.get/config.set and records every config.set so the test can
 * prove the scope each picker action uses (session pin vs. global config.yaml write).
 * `initialReasoning` seeds the effective level the gateway reports.
 */
function installMockGateway(page, { initialReasoning = "none", setError = null } = {}) {
  return page.addInitScript(({ initialReasoning, setError }) => {
    window.__configCalls = []
    window.__reasoningValue = initialReasoning
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
        const failure = (code, message) => this.emit({ jsonrpc: "2.0", id: frame.id, error: { code, message } })
        if (frame.method === "client.capabilities" || frame.method === "ping") result({})
        else if (frame.method === "session.create") result({ session_id: "reasoning-session", stored_session_id: "reasoning-session" })
        else if (frame.method === "session.resume") result({ session_id: "reasoning-session", stored_session_id: "reasoning-session", messages: [] })
        else if (frame.method === "prompt.submit") result({})
        else if (frame.method === "session.interrupt") result({})
        else if (frame.method === "config.get") result({ value: window.__reasoningValue, display: "separate" })
        else if (frame.method === "config.set") {
          window.__configCalls.push({ key: frame.params?.key, value: frame.params?.value, scope: frame.params?.scope, sessionId: frame.params?.session_id })
          if (setError) return failure(setError.code, setError.message)
          if (frame.params?.key === "reasoning") window.__reasoningValue = frame.params?.value
          result({ key: frame.params?.key, value: frame.params?.value, scope: frame.params?.scope ?? "session" })
        }
      }
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
    }
    window.WebSocket = MockWebSocket
  }, { initialReasoning, setError })
}

async function openApp(browser, options) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
  await installMockGateway(page, options)
  await page.goto(`http://127.0.0.1:${options.port}/`, { timeout: 60_000, waitUntil: "domcontentloaded" })
  return page
}

async function withApp(options, run) {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await openApp(browser, { ...options, port: vite.httpServer.address().port })
    await run(page)
  } finally {
    await browser.close()
    await vite.close()
  }
}

serial("reasoning picker shows the gateway's effective level and pins a pick to the session", async () => {
  await withApp({ initialReasoning: "none" }, async (page) => {
    // The trigger must reflect what the gateway reports, not a hard-coded default.
    await page.getByRole("button", { name: "Reasoning: None" }).waitFor()
    // Composer order stays + then reasoning then Send; Send remains the last control.
    // The notification-permission affordance lives in the same bar but is not a composer control.
    const labels = await page.locator("[data-chat-composer] button:not([data-notification-permission])").evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute("aria-label")).filter(Boolean),
    )
    assert.deepEqual(labels, ["Add context", "Reasoning: None", "Send"], `composer controls changed: ${JSON.stringify(labels)}`)

    await page.getByRole("button", { name: "Reasoning: None" }).click()
    const levels = await page.locator('[role="menuitemradio"]').allInnerTexts()
    assert.deepEqual(
      levels.map((text) => text.replace(/\s+/g, " ").trim()),
      ["None off", "Minimal", "Low", "Medium", "High", "Extra high", "Max"],
    )
    const none = page.getByRole("menuitemradio", { name: /^None/ })
    assert.equal(await none.getAttribute("aria-checked"), "true", "the current level must be checked")

    await page.getByRole("menuitemradio", { name: "High", exact: true }).click()
    await page.getByRole("button", { name: "Reasoning: High" }).waitFor()

    const calls = await page.evaluate(() => window.__configCalls)
    assert.equal(calls.length, 1, `one pick must issue exactly one config.set: ${JSON.stringify(calls)}`)
    assert.deepEqual(
      { key: calls[0].key, value: calls[0].value, scope: calls[0].scope },
      { key: "reasoning", value: "high", scope: "session" },
      "a pick in the composer pins this conversation and must not rewrite config.yaml",
    )

    // Feedback is required: the user must see the scope of what they just changed.
    await page.locator("[data-reasoning-note]").waitFor()
    assert.match(await page.locator("[data-reasoning-note]").innerText(), /This conversation only/)
  })
})

serial("Set as global default writes config.yaml and reports it", async () => {
  await withApp({ initialReasoning: "low" }, async (page) => {
    await page.getByRole("button", { name: "Reasoning: Low" }).waitFor()
    await page.getByRole("button", { name: "Reasoning: Low" }).click()
    await page.getByRole("menuitem", { name: "Set as global default" }).click()
    await page.locator("[data-reasoning-note]").waitFor()
    assert.match(await page.locator("[data-reasoning-note]").innerText(), /Global default updated/)

    const calls = await page.evaluate(() => window.__configCalls)
    assert.equal(calls.length, 1, `expected one config.set: ${JSON.stringify(calls)}`)
    assert.deepEqual(
      { key: calls[0].key, value: calls[0].value, scope: calls[0].scope },
      { key: "reasoning", value: "low", scope: "global" },
      "the global action must carry the current level and scope=global",
    )
  })
})

serial("a rejected reasoning change surfaces the error instead of silently keeping the old level", async () => {
  await withApp({ initialReasoning: "none", setError: { code: 4002, message: "unknown reasoning value" } }, async (page) => {
    await page.getByRole("button", { name: "Reasoning: None" }).waitFor()
    await page.getByRole("button", { name: "Reasoning: None" }).click()
    await page.getByRole("menuitemradio", { name: "Max" }).click()
    await page.locator("[data-reasoning-note]").waitFor()
    assert.match(await page.locator("[data-reasoning-note]").innerText(), /unknown reasoning value/)
    // The trigger must not claim a level the gateway refused.
    await page.getByRole("button", { name: "Reasoning: None" }).waitFor()
  })
})
