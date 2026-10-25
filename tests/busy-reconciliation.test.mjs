import assert from "node:assert/strict"
import test from "node:test"
import { chromium } from "playwright-core"
import { createServer as createViteServer } from "vite"

const launchBrowser = () => chromium.launch({
  headless: true,
  executablePath: "/opt/hermes/tools/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
})

function installGateway(page, { resume = null, failResume = false } = {}) {
  return page.addInitScript(({ resume, failResume }) => {
    let liveSession = 0
    window.__gatewayCalls = []
    window.__mockSockets = []
    class MockWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = MockWebSocket.CONNECTING
      onmessage = null
      onclose = null
      constructor() {
        this.index = window.__mockSockets.push(this) - 1
        queueMicrotask(() => {
          this.readyState = MockWebSocket.OPEN
          this.emit({ method: "event", params: { type: "gateway.ready", payload: {} } })
        })
      }
      emit(frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
      drop() {
        this.readyState = MockWebSocket.CLOSED
        this.onclose?.()
      }
      send(raw) {
        const frame = JSON.parse(raw)
        window.__gatewayCalls.push({ socket: this.index, method: frame.method, params: frame.params })
        const result = (value) => this.emit({ jsonrpc: "2.0", id: frame.id, result: value })
        if (frame.method === "client.capabilities" || frame.method === "ping") result({})
        else if (frame.method === "session.create") {
          liveSession += 1
          result({ session_id: `busy-live-${liveSession}`, stored_session_id: "busy-stored-session" })
        } else if (frame.method === "session.resume") {
          liveSession += 1
          if (failResume && this.index > 0) this.emit({ jsonrpc: "2.0", id: frame.id, error: { code: 5000, message: "mock resume failure" } })
          else result({ session_id: `busy-live-${liveSession}`, stored_session_id: frame.params.session_id, messages: [], ...(this.index > 0 ? (resume ?? {}) : {}) })
        } else if (frame.method === "prompt.submit") {
          result({})
          const event = (type, payload = {}) => this.emit({ method: "event", params: { type, session_id: `busy-live-${liveSession}`, payload } })
          event("message.start")
          event("message.delta", { text: "Partial answer" })
          window.__dropGateway = () => this.drop()
        }
      }
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
    }
    window.WebSocket = MockWebSocket
  }, { resume, failResume })
}

async function openChat(page, vite) {
  await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
  const address = vite.httpServer.address()
  await page.goto(`http://127.0.0.1:${address.port}/`)
  await page.getByRole("textbox", { name: "Message" }).fill("disconnect test")
  await page.getByRole("button", { name: "Send" }).click()
  await page.getByText("Partial answer").waitFor()
  await page.evaluate(() => window.__dropGateway())
}

async function withVite(testBody) {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await testBody(page, vite)
  } finally {
    await browser.close()
    await vite.close()
  }
}

test("reconnect reconciliation keeps a running turn and does not add transcript bubbles", { concurrency: false }, async () => {
  await withVite(async (page, vite) => {
    await installGateway(page, { resume: { running: true, status: "working", turn_started_at: Math.floor(Date.now() / 1000) - 20, inflight: { user: "disconnect test", assistant: "Partial answer" } } })
    await openChat(page, vite)
    const bubbleCountBefore = await page.locator('[data-slot="message-scroller-item"]').count()
    await page.locator("[data-working-indicator]").getByText(/连接已断开/).waitFor()
    await page.waitForFunction(() => window.__gatewayCalls.some(({ socket, method }) => socket > 0 && method === "session.resume"))
    const indicator = page.locator("[data-working-indicator]")
    await page.waitForTimeout(100)
    const indicatorText = await indicator.innerText()
    assert.match(indicatorText, /\b(?:2\d|[3-9]\d+)s\b/, `turn_started_at should restore elapsed time; indicator text was ${indicatorText}`)
    const transcriptState = await page.locator("body").innerText()
    assert.equal(await page.locator('[data-slot="message-scroller-item"]').count(), bubbleCountBefore, `resume must not append user or assistant bubbles; body=${transcriptState}`)
    assert.equal(await page.getByText("disconnect test", { exact: true }).count(), 1)
    assert.equal(await page.getByText("Partial answer", { exact: true }).count(), 1)
  })
})

test("reconnect reconciliation renders a completed answer once and clears busy", { concurrency: false }, async () => {
  await withVite(async (page, vite) => {
    await installGateway(page, { resume: { running: false, status: "idle", messages: [{ role: "user", content: "disconnect test" }, { role: "assistant", content: "Recovered final answer" }] } })
    await openChat(page, vite)
    await page.waitForFunction(() => window.__gatewayCalls.some(({ socket, method }) => socket > 0 && method === "session.resume"))
    await page.locator("[data-working-indicator]").waitFor({ state: "detached" })
    assert.equal(await page.getByText("Recovered final answer", { exact: true }).count(), 1)
    assert.equal(await page.getByText("disconnect test", { exact: true }).count(), 1)
    assert.equal(await page.locator('[data-slot="message-scroller-item"]').count(), 2)
  })
})

test("reconciliation failure preserves busy status without creating an error bubble", { concurrency: false }, async () => {
  await withVite(async (page, vite) => {
    await installGateway(page, { failResume: true })
    await openChat(page, vite)
    const indicator = page.locator("[data-working-indicator]")
    await indicator.getByText(/连接已断开/).waitFor()
    await page.waitForFunction(() => window.__gatewayCalls.some(({ socket, method }) => socket > 0 && method === "session.resume"))
    await indicator.getByText(/连接已断开，正在重连/).waitFor()
    assert.match(await indicator.innerText(), /连接已断开/, "offline status remains the stable reconnect message")
    assert.doesNotMatch(await indicator.innerText(), /Unable to connect to Hermes gateway/)
    assert.equal(await indicator.count(), 1)
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.equal(await page.getByText("Partial answer", { exact: true }).count(), 1)
  })
})

test("concurrent prompt completions decrement the active-turn count one at a time", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await page.addInitScript(() => {
      window.__gatewayCalls = []
      class MockWebSocket {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
        readyState = 0; onmessage = null; onclose = null
        constructor() { window.__socket = this; queueMicrotask(() => { this.readyState = 1; this.emit({ method: "event", params: { type: "gateway.ready", payload: {} } }) }) }
        emit(frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
        send(raw) {
          const frame = JSON.parse(raw); window.__gatewayCalls.push(frame)
          const result = (value) => this.emit({ jsonrpc: "2.0", id: frame.id, result: value })
          if (frame.method === "client.capabilities" || frame.method === "ping") result({})
          else if (frame.method === "session.create") result({ session_id: "concurrent-live", stored_session_id: "concurrent-stored" })
          else if (frame.method === "prompt.submit") {
            result({})
            this.emit({ method: "event", params: { type: "message.start", session_id: "concurrent-live", payload: {} } })
          }
        }
        close() { this.readyState = 3; this.onclose?.() }
      }
      window.WebSocket = MockWebSocket
    })
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    const input = page.getByRole("textbox", { name: "Message" })
    await input.fill("first turn")
    await page.getByRole("button", { name: "Send" }).click()
    await page.locator("[data-working-indicator]").waitFor()
    await input.fill("second turn")
    await page.getByRole("button", { name: "Send" }).click()
    await page.waitForFunction(() => window.__gatewayCalls.filter(({ method }) => method === "prompt.submit").length === 2)
    await page.evaluate(() => {
      const frame = { method: "event", params: { type: "message.complete", session_id: "concurrent-live", seq: 77, payload: { text: "first complete" } } }
      window.__socket.emit(frame)
      window.__socket.emit(frame)
    })
    await page.locator("[data-working-indicator]").waitFor()
    assert.equal(await page.locator("[data-working-indicator]").count(), 1, "duplicate seq is discarded: the first completion changes count 2→1 only once")
    assert.equal(await page.getByText("first complete", { exact: true }).count(), 1, "duplicate seq appends only one assistant bubble")
    await page.evaluate(() => window.__socket.emit({ method: "event", params: { type: "message.complete", session_id: "concurrent-live", seq: 78, payload: { text: "second complete" } } }))
    await page.locator("[data-working-indicator]").waitFor({ state: "detached" })
    assert.equal(await page.locator("[data-working-indicator]").count(), 0, "only the second completion clears busy")
  } finally {
    await browser.close()
    await vite.close()
  }
})
