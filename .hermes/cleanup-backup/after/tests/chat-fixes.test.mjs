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
    const nativeSetTimeout = window.setTimeout.bind(window)
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 20_000 ? 40 : delay, ...args)
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
        window.__gatewayCalls ??= []
        window.__gatewayCalls.push({ method: frame.method, params: frame.params })
        const result = (value) => this.emit({ jsonrpc: "2.0", id: frame.id, result: value })
        if (frame.method === "client.capabilities" || frame.method === "ping") result({})
        else if (frame.method === "session.create") {
          window.__sessionCreateCount = (window.__sessionCreateCount ?? 0) + 1
          result({ session_id: `fix-session-${window.__sessionCreateCount}`, stored_session_id: `stored-fix-${window.__sessionCreateCount}` })
        } else if (frame.method === "prompt.submit") {
          result({})
          const event = (type, payload) => this.emit({ method: "event", params: { type, session_id: frame.params.session_id, payload } })
          event("message.start", {})
          window.__completeCurrentTurn = (text = "A short reply") => event("message.complete", { text })
        } else if (frame.method === "session.interrupt") result({})
        // Intentionally withhold slash.exec responses to exercise the client timeout.
      }
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
    }
    window.WebSocket = MockWebSocket
  })
}

test("local session commands, slash timeout, working indicator, and short-thread anchoring", async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await installMockGateway(page)
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    const input = page.getByRole("textbox", { name: "Message" })

    await input.fill("/new hello")
    await input.press("Enter")
    await page.waitForFunction(() => window.__sessionCreateCount === 1)
    assert.equal(await page.evaluate(() => window.__gatewayCalls.filter(({ method }) => method === "slash.exec").length), 0)
    // /new behaves like the "New conversation" button: empty transcript + welcome screen.
    await page.getByText("What should we build?").waitFor()
    await page.getByText("The agent can read your code, run commands and make changes. Press send to start.").waitFor()
    assert.equal(await page.locator('[data-slot="message-scroller-item"]').count(), 0)

    await input.fill("/stop")
    await input.press("Enter")
    await page.waitForFunction(() => window.__gatewayCalls.some(({ method }) => method === "session.interrupt"))

    await input.fill("/unresponsive")
    await input.press("Enter")
    await page.locator("[data-command-result]").getByText("Command timed out").waitFor()

    await input.fill("/clear")
    await input.press("Enter")
    await page.waitForFunction(() => window.__sessionCreateCount === 2)
    await input.fill("A short question")
    await input.press("Enter")
    const working = page.locator("[data-working-indicator]")
    await working.getByRole("status").waitFor()
    assert.equal(await working.getByText(/Working/).count(), 1)
    await page.evaluate(() => window.__mockGatewaySocket.emit({
      method: "event",
      params: { type: "status.update", session_id: "fix-session-2", payload: { kind: "process", text: "Checking the answer" } },
    }))
    await working.getByText("Checking the answer").waitFor()
    await page.evaluate(() => window.__completeCurrentTurn())
    await page.getByText("A short reply").waitFor()
    await working.waitFor({ state: "detached" })

    const boxes = page.locator('[data-slot="message-scroller-item"]')
    // The prior /new reset the conversation, so this flow has exactly its three added messages.
    assert.equal(await boxes.count(), 3)
    const measureTranscript = () => page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-slot="message-scroller-item"]')]
      const boxes = items.map((item) => item.getBoundingClientRect())
      const last = boxes.at(-1)
      const composer = document.querySelector("form").getBoundingClientRect()
      const viewport = document.querySelector('[data-slot="message-scroller-viewport"]')
      return {
        gap: composer.top - last.bottom,
        viewportGap: composer.top - viewport.getBoundingClientRect().bottom,
        largestItemGap: Math.max(0, ...boxes.slice(1).map((box, index) => box.top - boxes[index].bottom)),
        atEnd: Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 1,
      }
    })
    const shortLayout = await measureTranscript()
    assert.ok(shortLayout.viewportGap >= 0, `expected transcript viewport to end above composer, got ${shortLayout.viewportGap}px`)
    assert.ok(shortLayout.gap >= 4, `expected last short message to end at least 4px above composer, got ${shortLayout.gap}px`)
    assert.ok(shortLayout.gap <= 120, `expected short-thread bottom anchoring gap <= 120px, got ${shortLayout.gap}px`)
    assert.ok(shortLayout.largestItemGap <= 32, `expected rendered transcript item gaps <= 32px, got ${shortLayout.largestItemGap}px`)

    const longReply = Array.from({ length: 18 }, (_, index) => `Long reply paragraph ${index + 1}: DNS records can also direct requests to the appropriate service. Saved answers expire after a set time, so resolvers refresh the information.`).join("\n\n")
    await input.fill("Explain the DNS details")
    await input.press("Enter")
    await page.waitForFunction(() => window.__gatewayCalls.filter(({ method }) => method === "prompt.submit").length === 2)
    await page.evaluate((text) => window.__completeCurrentTurn(text), longReply)
    await page.getByText("Long reply paragraph 18:").waitFor()
    const longLayout = await measureTranscript()
    assert.ok(longLayout.atEnd, `expected long reply to be scrolled to the end: ${JSON.stringify(longLayout)}`)
    assert.ok(longLayout.viewportGap >= 0, `expected transcript viewport to end above composer after long reply, got ${longLayout.viewportGap}px`)
    assert.ok(longLayout.gap >= 4, `expected last long-reply message to end at least 4px above composer, got ${longLayout.gap}px`)
    assert.equal(await page.evaluate(() => window.__gatewayCalls.filter(({ method }) => method === "slash.exec").length), 1)
  } finally {
    await browser.close()
    await vite.close()
  }
})
