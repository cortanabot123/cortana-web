import assert from "node:assert/strict"
import test from "node:test"
import { chromium } from "playwright-core"
import { createServer as createViteServer } from "vite"

const launchBrowser = () => chromium.launch({
  headless: true,
  executablePath: "/opt/hermes/tools/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
})

// The reported shape: submit, the daemon accepts the turn and then the socket dies before any
// event arrives; the browser's automatic reconnect attempts fail while it restarts. Hermes still
// finishes the answer, so on refresh the reply is there — but the live page has no socket and no
// local answer. Clicking Retry used to re-submit into that dead connection, which showed
// "Working" forever. Retry must re-open the gateway, re-read the session, and render the answer.
test("Retry re-reads the session transcript when the answer landed while the page was disconnected", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await page.addInitScript(() => {
      localStorage.setItem("cortana-web.hermes.gateway-session", "stored-retry-session")
      window.__gatewayCalls = []
      window.__answerLanded = false
      window.__daemonDead = false
      let socketSeq = 0
      class MockWebSocket {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3
        readyState = MockWebSocket.CONNECTING
        onmessage = null
        onclose = null
        constructor() {
          this.index = socketSeq++
          // Socket 0 is the initial page load. Afterwards the daemon is down until the test
          // flips __daemonDead, like a restart that outlasts the reconnect backoff.
          const down = this.index > 0 && window.__daemonDead
          queueMicrotask(() => {
            if (down) {
              this.readyState = MockWebSocket.CLOSED
              this.onclose?.()
              return
            }
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
          window.__gatewayCalls.push({ socket: this.index, method: frame.method })
          const emit = this.emit.bind(this)
          const result = (value) => emit({ jsonrpc: "2.0", id: frame.id, result: value })
          if (frame.method === "client.capabilities") result({})
          else if (frame.method === "session.resume") {
            const resumeCount = window.__gatewayCalls.filter(({ method }) => method === "session.resume").length
            window.__liveSessionId = `live-${resumeCount}`
            // While the turn is running the daemon has no finished answer to report; once it has
            // finished, any resume call returns the stored exchange.
            const messages = window.__answerLanded
              ? [
                  { role: "user", text: "Did it finish" },
                  { role: "assistant", text: "Finished while offline" },
                ]
              : []
            result({ session_id: window.__liveSessionId, stored_session_id: "stored-retry-session", messages })
          } else if (frame.method === "prompt.submit") {
            result({})
            // Hermes explicitly ends this mock turn with an error, making Retry available; the
            // stored answer then lands while automatic reconnects are failing.
            this.emit({ method: "event", params: { type: "message.error", session_id: window.__liveSessionId, payload: { message: "Mock turn failed; retry is available." } } })
            window.__answerLanded = true
            window.__daemonDead = true
            setTimeout(() => this.drop(), 0)
          }
        }
        close() { this.drop() }
      }
      window.WebSocket = MockWebSocket
    })
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.waitForFunction(() => window.__gatewayCalls.some(({ method }) => method === "session.resume"))

    await page.getByRole("textbox", { name: "Message" }).fill("Did it finish")
    await page.getByRole("button", { name: "Send" }).click()
    await page.waitForTimeout(1500)
    await page.getByRole("alert").getByText(/Mock turn failed/i).waitFor()
    // Let several automatic reconnect attempts fail, so the page genuinely holds no gateway client.
    await page.waitForTimeout(3_500)
    assert.equal(await page.locator("[data-working-indicator]").count(), 0, "no working row before Retry")

    // The daemon is back now — this is what happened when the user refreshed and saw the answer.
    await page.evaluate(() => { window.__daemonDead = false })

    await page.getByRole("button", { name: "Retry" }).click()
    await page.waitForTimeout(1500)
    await page.getByText("Finished while offline").waitFor({ timeout: 5_000 })

    const contents = await page.locator('[data-slot="message-content"]').evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""))
    assert.equal(contents.filter((text) => text === "Finished while offline").length, 1, "the stored answer is rendered once")
    assert.equal(await page.locator("[data-working-indicator]").count(), 0, "Retry must not leave the UI working")
    assert.equal(await page.getByRole("alert").count(), 0, "Retry clears the disconnect error")
    assert.equal(await page.getByText("Did it finish", { exact: true }).count(), 1, "the prompt is not duplicated")
    assert.equal(
      await page.evaluate(() => window.__gatewayCalls.filter(({ method }) => method === "prompt.submit").length),
      1,
      "only the original submit happened: Retry rendered the stored answer instead of asking again",
    )
  } finally {
    await browser.close()
    await vite.close()
  }
})
