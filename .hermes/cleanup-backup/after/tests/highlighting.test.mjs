import assert from "node:assert/strict"
import test from "node:test"
import { chromium } from "playwright-core"
import { createServer as createViteServer } from "vite"

const launchBrowser = () => chromium.launch({
  headless: true,
  executablePath: "/opt/hermes/tools/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
})

test("code highlighting loads on demand and highlights fenced code", async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    const highlighterRequests = []
    page.on("request", (request) => {
      if (request.url().includes("/src/lib/highlighter.tsx")) highlighterRequests.push(request.url())
    })
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await page.addInitScript(() => {
      class MockWebSocket {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3
        readyState = MockWebSocket.CONNECTING
        onmessage = null
        onclose = null
        constructor() {
          window.__mockGatewaySocket = this
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
          else if (frame.method === "session.create") result({ session_id: "highlight-session", stored_session_id: "highlight-session" })
          else if (frame.method === "prompt.submit") {
            result({})
            const emit = (type, payload) => this.emit({ method: "event", params: { type, session_id: frame.params.session_id, payload } })
            emit("message.start", {})
            emit("message.delta", { text: "```typescript\nconst answer: number = 42\n```" })
          }
        }
        close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
      }
      window.WebSocket = MockWebSocket
    })

    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.getByRole("textbox", { name: "Message" }).waitFor()
    assert.deepEqual(highlighterRequests, [], "normal chat startup must not load Shiki")

    await page.getByRole("textbox", { name: "Message" }).fill("show code")
    await page.getByRole("button", { name: "Send" }).click()
    await page.locator('[data-slot="code-block-code"]').waitFor()
    await page.locator('[data-slot="code-block-code"] span[style]').first().waitFor()
    assert.ok(highlighterRequests.length > 0, "rendering fenced code must load the highlighter")
    assert.equal(await page.locator('[data-slot="code-block-code"]').innerText(), "const answer: number = 42")
  } finally {
    await browser.close()
    await vite.close()
  }
})
