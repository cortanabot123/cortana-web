import assert from "node:assert/strict"
import test from "node:test"
import { chromium } from "playwright-core"
import { createServer as createViteServer } from "vite"

const launchBrowser = () => chromium.launch({
  headless: true,
  executablePath: "/opt/hermes/tools/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
})

test("Retry restores a completed resumed answer without resubmitting or retaining partial text", async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await page.addInitScript(() => {
      localStorage.setItem("cortana-web.hermes.gateway-session", "stored-retry-session")
      window.__gatewayCalls = []
      window.__mockGatewaySockets = []
      window.__latestLiveSessionId = ""
      class MockWebSocket {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3
        readyState = MockWebSocket.CONNECTING
        onmessage = null
        onclose = null
        constructor() {
          this.index = window.__mockGatewaySockets.push(this) - 1
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
          if (frame.method === "client.capabilities") result({})
          else if (frame.method === "session.resume") {
            const resumeCount = window.__gatewayCalls.filter(({ method }) => method === "session.resume").length
            window.__latestLiveSessionId = `retry-live-${resumeCount}`
            result({
              session_id: window.__latestLiveSessionId,
              stored_session_id: "stored-retry-session",
              messages: resumeCount === 1 ? [] : [
                { role: "user", text: "Restore my answer" },
                { role: "assistant", text: "Completed server-side answer" },
              ],
            })
          } else if (frame.method === "prompt.submit") {
            result({})
            const event = (type, payload = {}) => this.emit({
              method: "event",
              params: { type, session_id: window.__latestLiveSessionId, payload },
            })
            event("message.start")
            event("message.delta", { text: "Stale partial text" })
            const submissions = window.__gatewayCalls.filter(({ method }) => method === "prompt.submit").length
            if (submissions === 1) setTimeout(() => this.drop(), 0)
            else event("message.delta", { text: "Duplicate retry answer" })
          }
        }
        close() { this.drop() }
      }
      window.WebSocket = MockWebSocket
    })
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.waitForFunction(() => window.__gatewayCalls.some(({ method }) => method === "session.resume"))

    await page.getByRole("textbox", { name: "Message" }).fill("Restore my answer")
    await page.getByRole("button", { name: "Send" }).click()
    await page.getByText("Stale partial text").waitFor()
    await page.locator('[data-working-indicator]').waitFor({ state: "detached" })
    await page.getByRole("alert").getByText(/connection closed/i).waitFor()
    await page.waitForFunction(() => window.__gatewayCalls.filter(({ method }) => method === "session.resume").length >= 2)

    await page.getByRole("button", { name: "Retry" }).click()
    await page.waitForFunction(() => {
      const transcript = document.body.textContent ?? ""
      return transcript.includes("Completed server-side answer") || transcript.includes("Duplicate retry answer")
    })

    const assistantContents = await page.locator('[data-slot="message-content"]').evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""))
    assert.equal(assistantContents.filter((text) => text === "Completed server-side answer").length, 1, "Retry restores exactly one completed server transcript answer")
    assert.equal(assistantContents.some((text) => text.includes("Stale partial text")), false, "the stale partial bubble is reconciled away")
    assert.equal(await page.getByRole("alert").count(), 0, "Retry/error state is cleared")
    assert.equal(await page.locator('[data-working-indicator]').count(), 0, "the UI is no longer busy")
    assert.equal(await page.getByText("Restore my answer", { exact: true }).count(), 1, "the user prompt is not duplicated")
    assert.equal(await page.evaluate(() => window.__gatewayCalls.filter(({ method }) => method === "prompt.submit").length), 1, "Retry does not resubmit the prompt")
    assert.equal(await page.evaluate(() => window.__gatewayCalls.filter(({ method }) => method === "session.resume").length), 2, "Retry uses the already-resumed transcript without another resume RPC")
  } finally {
    await browser.close()
    await vite.close()
  }
})
