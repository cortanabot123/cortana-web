import assert from "node:assert/strict"
import test from "node:test"
import { chromium } from "playwright-core"
import { createServer as createViteServer } from "vite"

const launchBrowser = () => chromium.launch({
  headless: true,
  executablePath: "/opt/hermes/tools/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
})

test("resume hydration omits empty and whitespace-only entries", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await page.addInitScript(() => {
      if (window.location.search !== "?fresh") {
        localStorage.setItem("cortana-web.hermes.gateway-session", "stored-resume-session")
      }
      class MockWebSocket {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3
        readyState = MockWebSocket.CONNECTING
        onmessage = null
        onclose = null
        constructor() {
          window.__resumeSocket = this
          queueMicrotask(() => {
            this.readyState = MockWebSocket.OPEN
            this.emit({ method: "event", params: { type: "gateway.ready", payload: {} } })
          })
        }
        emit(frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
        send(raw) {
          const frame = JSON.parse(raw)
          if (frame.method === "client.capabilities") {
            this.emit({ jsonrpc: "2.0", id: frame.id, result: {} })
          } else if (frame.method === "session.resume") {
            window.__resumePending = true
            window.__releaseResume = () => this.emit({ jsonrpc: "2.0", id: frame.id, result: {
              session_id: "resumed-live-session",
              stored_session_id: "stored-resume-session",
              messages: [
                { role: "user", text: "  Keep my spacing  " },
                { role: "assistant", text: "" },
                { role: "assistant", content: " \t\n " },
                { role: "assistant", text: "A visible answer" },
                { role: "assistant", content: "Another visible answer" },
              ],
            } })
          }
        }
        close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
      }
      window.WebSocket = MockWebSocket
    })
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)

    await page.waitForFunction(() => window.__resumePending === true)
    const historyLoader = page.getByRole("status", { name: "Loading conversation history…" })
    await historyLoader.waitFor({ timeout: 2000 })
    assert.equal(await historyLoader.locator(".animate-spin").count(), 1)
    await page.evaluate(() => window.__releaseResume())

    const contents = page.locator('[data-slot="message-content"]')
    await page.getByText("A visible answer").waitFor()
    await historyLoader.waitFor({ state: "detached" })
    await page.getByText("Another visible answer").waitFor()
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="message-content"]').length === 3)
    assert.deepEqual(await contents.evaluateAll((nodes) => nodes.map((node) => node.textContent)), [
      "  Keep my spacing  ",
      "A visible answer",
      "Another visible answer",
    ])
    assert.equal(await page.locator('[data-slot="message-content"]').evaluateAll((nodes) => nodes.some((node) => !node.textContent.trim())), false)
    assert.equal(await page.getByRole("button", { name: "Close window" }).count(), 0)

    await page.evaluate(() => localStorage.removeItem("cortana-web.hermes.gateway-session"))
    await page.goto(`http://127.0.0.1:${address.port}/?fresh`)
    await page.getByText("What should we build?").waitFor()
    assert.equal(await page.getByRole("status", { name: "Loading conversation history…" }).count(), 0)
  } finally {
    await browser.close()
    await vite.close()
  }
})
