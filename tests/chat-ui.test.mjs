import assert from "node:assert/strict"
import test from "node:test"
import { chromium } from "playwright-core"
import { createServer as createViteServer } from "vite"

const launchBrowser = () => chromium.launch({
  headless: true,
  executablePath: "/opt/hermes/tools/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
})

async function assertWorkingIndicatorLayout(page) {
  const layout = await page.locator("[data-working-indicator]").evaluate((indicator) => {
    const scroller = document.querySelector('[data-slot="message-scroller-content"]')
    const input = document.querySelector('[data-slot="input-group"]')
    const lastItem = scroller?.querySelector('[data-slot="message-scroller-item"]:last-child')
    const indicatorRect = indicator.getBoundingClientRect()
    const inputRect = input.getBoundingClientRect()
    const style = getComputedStyle(indicator)
    return {
      text: indicator.textContent,
      role: indicator.getAttribute("role"),
      live: indicator.getAttribute("aria-live"),
      insideScroller: scroller?.contains(indicator) ?? false,
      scrollerStatusCount: scroller?.querySelectorAll('[role="status"]').length ?? 0,
      indicatorTop: indicatorRect.top,
      indicatorBottom: indicatorRect.bottom,
      lastMessageBottom: lastItem?.getBoundingClientRect().bottom ?? null,
      inputTop: inputRect.top,
      composerTop: document.querySelector("[data-chat-composer]").getBoundingClientRect().top,
      visible: indicatorRect.width > 0 && indicatorRect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
      inViewport: indicatorRect.top >= 0 && indicatorRect.bottom <= window.innerHeight,
    }
  })
  assert.equal(layout.role, "status")
  assert.equal(layout.live, "polite")
  assert.match(layout.text, /Working/)
  assert.equal(layout.insideScroller, false, "the working bar must remain outside transcript content")
  assert.equal(layout.scrollerStatusCount, 0, "transcript content must contain no role=status rows")
  assert.equal(layout.visible, true, "the working bar must be visible")
  assert.equal(layout.inViewport, true, "the working bar must be inside the viewport")
  assert.ok(layout.indicatorBottom <= layout.inputTop, "the working bar must sit above InputGroup")
  assert.ok(layout.lastMessageBottom === null || layout.lastMessageBottom <= layout.indicatorTop, "the last transcript message must end above the working bar")
  return layout
}

function installMockServiceWorker(page) {
  return page.addInitScript(() => {
    const makeEmitter = () => {
      const listeners = new Map()
      return {
        addEventListener(type, listener) {
          const current = listeners.get(type) ?? new Set()
          current.add(listener)
          listeners.set(type, current)
        },
        removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
        dispatch(type) { for (const listener of listeners.get(type) ?? []) listener({ target: this }) },
      }
    }
    const worker = Object.assign(makeEmitter(), { state: "installing" })
    const registration = Object.assign(makeEmitter(), { installing: worker, waiting: null })
    const serviceWorker = Object.assign(makeEmitter(), {
      controller: {},
      getRegistration: async () => registration,
    })
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker })
    window.__fakeServiceWorker = { registration, serviceWorker, worker }
  })
}

function installReconnectGateway(page, { closeDuringTurn = false, ignorePing = false, withholdCloseEvent = false, accelerateHeartbeat = true, resumeResponse = null, resumeError = false } = {}) {
  return page.addInitScript(({ closeDuringTurn, ignorePing, withholdCloseEvent, accelerateHeartbeat, resumeResponse, resumeError }) => {
    const NativeSetTimeout = window.setTimeout.bind(window)
    const NativeSetInterval = window.setInterval.bind(window)
    window.__timeoutRequests = []
    window.setTimeout = (callback, delay, ...args) => {
      window.__timeoutRequests.push({ delay, at: Date.now() })
      return NativeSetTimeout(callback, delay >= 30_000 ? 60 : delay, ...args)
    }
    window.setInterval = (callback, delay, ...args) => NativeSetInterval(callback, delay === 15_000 && accelerateHeartbeat ? 20 : delay, ...args)
    let nextSession = 0
    window.__ignoreGatewayPing = ignorePing
    window.__mockGatewaySockets = []
    window.__gatewayCalls = []
    class MockWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = MockWebSocket.CONNECTING
      onmessage = null
      onclose = null
      closeRequested = false
      reconnectDelayAtClose = null
      closeEventCount = 0
      constructor() {
        this.createdAt = Date.now()
        this.index = window.__mockGatewaySockets.push(this) - 1
        queueMicrotask(() => {
          this.readyState = MockWebSocket.OPEN
          this.emit({ method: "event", params: { type: "gateway.ready", payload: {} } })
        })
      }
      emit(frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
      finishClose() {
        if (this.readyState === MockWebSocket.CLOSED) return
        this.readyState = MockWebSocket.CLOSED
        this.closeEventCount += 1
        this.onclose?.()
      }
      drop() { this.finishClose() }
      send(raw) {
        const frame = JSON.parse(raw)
        window.__gatewayCalls.push({ socket: this.index, method: frame.method, ignored: frame.method === "ping" && window.__ignoreGatewayPing, params: frame.params, at: Date.now() })
        const result = (value) => this.emit({ jsonrpc: "2.0", id: frame.id, result: value })
        if (frame.method === "client.capabilities") result({})
        else if (frame.method === "session.create") {
          nextSession += 1
          result({ session_id: `live-${nextSession}`, stored_session_id: "stored-reconnect-session" })
        } else if (frame.method === "session.resume") {
          nextSession += 1
          if (resumeError) this.emit({ jsonrpc: "2.0", id: frame.id, error: { code: 5000, message: "temporary resume failure" } })
          else result({ session_id: `live-${nextSession}`, stored_session_id: frame.params.session_id, messages: [], ...(resumeResponse ?? {}) })
        } else if (frame.method === "ping" && !window.__ignoreGatewayPing) result({})
        else if (frame.method === "prompt.submit") {
          result({})
          const event = (type, payload = {}) => this.emit({ method: "event", params: { type, session_id: `live-${nextSession}`, payload } })
          event("message.start")
          event("message.delta", { text: "Partial response" })
          if (closeDuringTurn) NativeSetTimeout(() => this.drop(), 0)
        }
      }
      close() {
        this.closeRequested = true
        this.reconnectDelayAtClose = window.__timeoutRequests.at(-1)?.delay
        if (!withholdCloseEvent) return this.finishClose()
        this.readyState = MockWebSocket.CLOSED
      }
    }
    window.WebSocket = MockWebSocket
  }, { closeDuringTurn, ignorePing, withholdCloseEvent, accelerateHeartbeat, resumeResponse, resumeError })
}

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
        else if (frame.method === "session.create") result({ session_id: "ui-session", stored_session_id: "stored-ui-session" })
        else if (frame.method === "prompt.submit") {
          result({})
          const event = (type, payload) => this.emit({ method: "event", params: { type, session_id: "ui-session", payload } })
          event("message.start", {})
          if (window.__holdGatewayDelta) {
            window.__releaseGatewayDelta = () => event("message.delta", { text: `Streaming ${frame.params.text}` })
          } else {
            event("message.delta", { text: `Streaming ${frame.params.text}` })
          }
        } else if (frame.method === "session.interrupt") {
          result({})
          this.emit({ method: "event", params: { type: "message.complete", session_id: "ui-session", payload: {} } })
        }
      }
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
    }
    window.WebSocket = MockWebSocket
  })
}

test("a gateway close preserves busy state until the Hermes reconciliation completes", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await installReconnectGateway(page, { closeDuringTurn: true, resumeResponse: { running: true, status: "working", turn_started_at: Math.floor(Date.now() / 1000) - 20, inflight: { user: "disconnect test", assistant: "Partial response" } } })
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.getByRole("textbox", { name: "Message" }).fill("disconnect test")
    await page.getByRole("button", { name: "Send" }).click()
    await page.getByText("Partial response").waitFor()
    const indicator = page.locator('[data-working-indicator]')
    await indicator.waitFor()
    await indicator.getByText(/连接已断开/).waitFor()
    assert.equal(await indicator.count(), 1, "socket close must not clear the local active-turn count")
    await page.waitForFunction(() => window.__gatewayCalls.filter(({ method }) => method === "session.resume").length >= 1, null, { timeout: 2500 })
    await indicator.waitFor()
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.equal(await page.getByText("Partial response").count(), 1)
  } finally {
    await browser.close()
    await vite.close()
  }
})

test("a timed-out keepalive invalidates the half-open socket and reconnects by resuming the stored session", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.addInitScript(() => localStorage.setItem("cortana-web.hermes.gateway-session", "stored-reconnect-session"))
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await installReconnectGateway(page, { withholdCloseEvent: true })
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.getByRole("textbox", { name: "Message" }).fill("keepalive timeout turn")
    await page.getByRole("button", { name: "Send" }).click()
    await page.getByText("Partial response").waitFor()
    await page.evaluate(() => { window.__ignoreGatewayPing = true })
    await page.waitForFunction(() => {
      const prompt = window.__gatewayCalls.find(({ method }) => method === "prompt.submit")
      return prompt && window.__gatewayCalls.some(({ socket, method }) => socket === prompt.socket && method === "ping")
    })
    await page.locator("[data-working-indicator]").waitFor()
    await page.waitForFunction(() => {
      const prompt = window.__gatewayCalls.find(({ method }) => method === "prompt.submit")
      const ping = prompt && window.__gatewayCalls.find(({ socket, method, ignored }) => socket === prompt.socket && method === "ping" && ignored)
      return ping && window.__gatewayCalls.some(({ socket, method }) => socket > ping.socket && method === "session.resume")
    }, null, { timeout: 2500 })
    await page.locator('[data-working-indicator]').waitFor({ state: "detached", timeout: 2500 })
    assert.equal(await page.locator("[data-working-indicator]").count(), 0, "Hermes running:false reconciliation clears busy")
    const reconnect = await page.evaluate(() => {
      const prompt = window.__gatewayCalls.find(({ method }) => method === "prompt.submit")
      const ping = window.__gatewayCalls.find(({ socket, method, ignored }) => socket === prompt.socket && method === "ping" && ignored)
      return {
        pingSocketState: window.__mockGatewaySockets[ping.socket].readyState,
        pingCloseRequested: window.__mockGatewaySockets[ping.socket].closeRequested,
        pingCloseEventCount: window.__mockGatewaySockets[ping.socket].closeEventCount,
        reconnectDelayAtClose: window.__mockGatewaySockets[ping.socket].reconnectDelayAtClose,
        resumed: window.__gatewayCalls.some(({ socket, method }) => socket > ping.socket && method === "session.resume"),
      }
    })
    assert.equal(reconnect.pingSocketState, 3, "timed-out ping must actively close the stale transport")
    assert.equal(reconnect.pingCloseRequested, true, "timed-out ping must call socket.close()")
    assert.equal(reconnect.pingCloseEventCount, 0, "the socket mock must withhold onclose after close()")
    assert.equal(reconnect.resumed, true, "the replacement client must resume the stored session")
    assert.ok(reconnect.reconnectDelayAtClose >= 1000 && reconnect.reconnectDelayAtClose <= 30_000, "reconnect backoff must be positive and bounded")
  } finally {
    await browser.close()
    await vite.close()
  }
})

test("foreground resume probes and replaces a silent half-open gateway during a turn", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.addInitScript(() => localStorage.setItem("cortana-web.hermes.gateway-session", "stored-reconnect-session"))
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await installReconnectGateway(page, { withholdCloseEvent: true, accelerateHeartbeat: false })
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.waitForFunction(() => window.__gatewayCalls.some(({ method }) => method === "session.resume"))
    const initialSocketCount = await page.evaluate(() => window.__mockGatewaySockets.length)
    await page.evaluate(() => {
      window.dispatchEvent(new Event("pageshow"))
      window.dispatchEvent(new Event("online"))
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await page.waitForFunction(() => window.__gatewayCalls.filter(({ method }) => method === "ping").length === 1)
    assert.equal(await page.evaluate(() => window.__mockGatewaySockets.length), initialSocketCount, "healthy foreground signals must not create a parallel socket")

    await page.getByRole("textbox", { name: "Message" }).fill("foreground recovery turn")
    await page.getByRole("button", { name: "Send" }).click()
    await page.getByText("Partial response").waitFor()
    const oldSocket = await page.evaluate(() => window.__mockGatewaySockets.length - 1)
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
      document.dispatchEvent(new Event("visibilitychange"))
      window.__ignoreGatewayPing = true
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
      window.dispatchEvent(new Event("pageshow"))
      document.dispatchEvent(new Event("visibilitychange"))
    })

    await page.waitForFunction((socket) => window.__gatewayCalls.some(({ socket: calledSocket, method }) => calledSocket === socket && method === "ping"), oldSocket, { timeout: 2000 })
    await page.locator('[data-working-indicator]').waitFor({ state: "detached" })
    assert.equal(await page.locator("[data-working-indicator]").count(), 0)
    await page.waitForFunction((socket) => window.__mockGatewaySockets.length > socket + 1 && window.__gatewayCalls.some(({ socket: calledSocket, method }) => calledSocket > socket && method === "session.resume"), oldSocket)
    const result = await page.evaluate((socket) => ({
      oldSocketState: window.__mockGatewaySockets[socket].readyState,
      oldSocketClosed: window.__mockGatewaySockets[socket].closeRequested,
      oldSocketCloseEvents: window.__mockGatewaySockets[socket].closeEventCount,
      replacementSockets: window.__mockGatewaySockets.length - socket - 1,
      resumed: window.__gatewayCalls.some(({ socket: calledSocket, method }) => calledSocket > socket && method === "session.resume"),
    }), oldSocket)
    assert.deepEqual(result, { oldSocketState: 3, oldSocketClosed: true, oldSocketCloseEvents: 0, replacementSockets: 1, resumed: true })
  } finally {
    await browser.close()
    await vite.close()
  }
})

test("gateway chat keeps Send available during turns and exposes a separate interrupt control", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await installMockGateway(page)
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    assert.deepEqual(await page.getByRole("banner").getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))), ["New conversation", "Theme: system"])
    const input = page.getByRole("textbox", { name: "Message" })
    const send = page.getByRole("button", { name: "Send" })
    assert.equal(await send.isDisabled(), true)
    await page.evaluate(() => { window.__holdGatewayDelta = true })
    await input.fill("first prompt")
    await send.click()
    const indicator = page.locator("[data-working-indicator]")
    await indicator.waitFor()
    await assertWorkingIndicatorLayout(page)
    assert.equal(await page.locator('[data-slot="message-scroller-content"] [data-slot="message-scroller-item"]').count(), 1, "the bar must appear while the user prompt is the only transcript row")
    await page.evaluate(() => window.__releaseGatewayDelta())
    await page.getByText("Streaming first prompt").waitFor()
    await page.evaluate(() => window.__mockGatewaySocket.emit({ method: "event", params: { type: "status.update", session_id: "ui-session", payload: { kind: "process", text: "reading files" } } }))
    await indicator.getByText("reading files").waitFor()
    const beforeComplete = await assertWorkingIndicatorLayout(page)
    assert.match(await indicator.innerText(), /Working/)
    assert.equal(await page.locator('[data-slot="message-scroller-content"] [role="status"]').count(), 0, "status.update must not add a status row to transcript")
    // The user asked for no stop button: the send button stays Send and Esc is the only interrupt.
    assert.equal(await page.getByRole("button", { name: "Stop generation" }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Send" }).count(), 1)
    await input.fill("queued prompt")
    assert.equal(await send.isEnabled(), true)
    await send.click()
    await page.getByText("queued prompt", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.__gatewayCalls.filter(({ method }) => method === "prompt.submit").map(({ params }) => params.text)), ["first prompt", "queued prompt"])
    await input.press("Escape")
    await page.waitForFunction(() => window.__gatewayCalls.some(({ method }) => method === "session.interrupt"))
    await indicator.waitFor({ state: "detached" })
    assert.equal(await page.locator("[data-working-indicator]").count(), 0)
    const composerTopAfterComplete = await page.locator("[data-chat-composer]").evaluate((element) => element.getBoundingClientRect().top)
    assert.ok(composerTopAfterComplete > beforeComplete.composerTop, "completion must shrink the composer by removing the status-bar space")
    assert.equal(await page.getByRole("button", { name: "Send" }).count(), 1)
  } finally {
    await browser.close()
    await vite.close()
  }
})

test("user message bubbles render Markdown and preserve single line breaks", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await installMockGateway(page)
    await page.addInitScript(() => localStorage.setItem("cortana-web.theme", "light"))
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    const content = "**粗体** 和 `code`\n第二行"
    await page.getByRole("textbox", { name: "Message" }).fill(content)
    await page.getByRole("button", { name: "Send" }).click()

    const bubble = page.locator('[data-slot="bubble-content"]')
    await bubble.locator("strong").waitFor()
    assert.equal(await bubble.locator("strong").innerText(), "粗体")
    assert.doesNotMatch(await bubble.innerText(), /\*\*粗体\*\*/)
    const inlineCode = bubble.locator('[data-slot="inline-code"]')
    assert.equal(await inlineCode.count(), 1)
    assert.doesNotMatch(await bubble.innerText(), /`code`/)
    assert.equal(await bubble.locator("br").count(), 1, "a single Markdown newline must render as a line break")
    assert.match(await bubble.innerText(), /粗体 和 code\n第二行/)

    const getInlineCodeColors = () => Promise.all([
      inlineCode.evaluate((el) => getComputedStyle(el).backgroundColor),
      bubble.evaluate((el) => getComputedStyle(el).backgroundColor),
      inlineCode.evaluate((el) => getComputedStyle(el).color),
    ])
    const assertReadableAndDistinct = async () => {
      const [codeBg, bubbleBg, codeColor] = await getInlineCodeColors()
      assert.notEqual(codeBg, bubbleBg, "inline code must be visually distinct on a muted user bubble")
      const contrast = await inlineCode.evaluate((el) => {
        const style = getComputedStyle(el)
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = 1
        const context = canvas.getContext("2d", { willReadFrequently: true })
        const pixel = (color) => {
          context.clearRect(0, 0, 1, 1)
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
          return [...context.getImageData(0, 0, 1, 1).data]
        }
        const bubble = pixel(getComputedStyle(el.closest('[data-slot="bubble-content"]')).backgroundColor)
        const overlay = pixel(style.backgroundColor)
        const foreground = pixel(style.color)
        const composite = overlay.map((value, index) => value * overlay[3] / 255 + bubble[index] * (1 - overlay[3] / 255))
        const luminance = ([r, g, b]) => {
          const channel = (value) => {
            const normalized = value / 255
            return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
          }
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
        }
        const foregroundLuminance = luminance(foreground)
        const backgroundLuminance = luminance(composite)
        return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
      })
      assert.ok(contrast >= 4.5, `inline code text contrast must be at least 4.5:1 (${codeColor} on ${codeBg}, ${contrast.toFixed(2)}:1)`)
      return { codeBg, bubbleBg }
    }
    assert.equal(await page.locator("html").evaluate((el) => el.classList.contains("dark")), false)
    const lightColors = await assertReadableAndDistinct()

    await page.evaluate(() => {
      window.__mockGatewaySocket.emit({ method: "event", params: { type: "message.start", session_id: "ui-session", payload: {} } })
      window.__mockGatewaySocket.emit({ method: "event", params: { type: "message.delta", session_id: "ui-session", payload: { text: "Assistant **bold** and `code`\nnext" } } })
    })
    const assistantCode = page.locator('[data-slot="inline-code"]').last()
    await assistantCode.waitFor()
    await page.getByText("bold", { exact: true }).waitFor()
    assert.equal(await page.locator('[data-slot="bubble-content"] br').count(), 1, "user Markdown line-break rendering must remain unchanged")
    assert.ok(await page.locator("br").count() >= 2, "assistant Markdown must retain its line break in addition to the user break")
    assert.match(await page.locator("body").innerText(), /Assistant bold and code\nnext/)
    assert.equal(await assistantCode.evaluate((el) => getComputedStyle(el).backgroundColor), "oklch(0.97 0 0)", "assistant inline-code styling must remain bg-muted")

    await page.getByRole("button", { name: "Theme: light" }).click()
    await page.getByRole("menuitemradio", { name: "Dark" }).click()
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"))
    const darkColors = await assertReadableAndDistinct()
    assert.notDeepEqual(lightColors, darkColors, "theme changes should apply distinct palette colors")
  } finally {
    await browser.close()
    await vite.close()
  }
})

test("file uploads stage removable arbitrary files and file-only prompts include the stored path", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    const uploaded = []
    await page.route("**/api/uploads", async (route) => {
      uploaded.push({ name: route.request().headers()["x-file-name"], body: route.request().postDataBuffer() })
      await route.fulfill({ status: 201, json: { name: "archive.unknown-format", path: "/tmp/cortana-uploads/opaque/archive" } })
    })
    await installMockGateway(page)
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.getByRole("button", { name: "Add context" }).click()
    await page.getByRole("menuitem", { name: "Add Photos & Files" }).click()
    const fileInput = page.locator('input[type="file"]')
    assert.equal(await fileInput.getAttribute("accept"), null, "all formats must be selectable")
    await fileInput.setInputFiles([
      { name: "archive.unknown-format", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 1]) },
      { name: "remove.me", mimeType: "application/octet-stream", buffer: Buffer.from([2]) },
    ])
    await page.getByText("archive.unknown-format", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Remove remove.me" }).click()
    assert.equal(await page.getByText("remove.me", { exact: true }).count(), 0)
    const send = page.getByRole("button", { name: "Send" })
    assert.equal(await send.isEnabled(), true, "staged files enable Send without text")
    await send.click()
    await page.waitForFunction(() => window.__gatewayCalls?.some(({ method }) => method === "prompt.submit"))
    assert.equal(uploaded.length, 1)
    assert.equal(uploaded[0].name, encodeURIComponent("archive.unknown-format"))
    assert.deepEqual([...uploaded[0].body], [0, 255, 1])
    const prompt = await page.evaluate(() => window.__gatewayCalls.find(({ method }) => method === "prompt.submit").params.text)
    assert.match(prompt, /archive\.unknown-format/)
    assert.match(prompt, /\/tmp\/cortana-uploads\/opaque\/archive/)
    assert.match(prompt, /untrusted/i)
  } finally {
    await browser.close()
    await vite.close()
  }
})

test("incoming completions use system notifications without audio", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await page.addInitScript(() => {
      window.__notifications = []
      window.__permissionRequests = 0
      window.__audioContexts = 0
      class MockNotification {
        static permission = "default"
        static requestPermission() {
          window.__permissionRequests += 1
          MockNotification.permission = "granted"
          return Promise.resolve("granted")
        }
        constructor(title, options) { window.__notifications.push({ title, body: options.body }) }
      }
      window.Notification = MockNotification
      window.AudioContext = class { constructor() { window.__audioContexts += 1 } }
    })
    await installMockGateway(page)
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    assert.equal(await page.evaluate(() => window.__permissionRequests), 0, "permission must not be requested on page load")

    const input = page.getByRole("textbox", { name: "Message" })
    await input.fill("notification test")
    await page.getByRole("button", { name: "Send" }).click()
    await page.waitForFunction(() => window.__gatewayCalls.some(({ method }) => method === "prompt.submit"))
    assert.equal(await page.evaluate(() => window.__permissionRequests), 1, "permission should be requested by the real prompt gesture")
    await page.getByText("Streaming notification test").waitFor()
    await page.evaluate(() => {
      const emit = (type, payload) => window.__mockGatewaySocket.emit({ method: "event", params: { type, session_id: "ui-session", payload } })
      emit("message.delta", { text: " more" })
    })
    assert.deepEqual(await page.evaluate(() => window.__notifications), [], "streaming deltas must not notify")

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
      window.__mockGatewaySocket.emit({ method: "event", params: { type: "message.complete", session_id: "ui-session", payload: { text: "Streaming notification test more" } } })
    })
    await page.waitForFunction(() => window.__notifications.length === 1)
    assert.deepEqual(await page.evaluate(() => window.__notifications), [{ title: "Cortana", body: "Streaming notification test more" }])

    await page.evaluate(() => window.__mockGatewaySocket.emit({ method: "event", params: { type: "background.complete", session_id: "ui-session", payload: { text: "Background response text" } } }))
    await page.waitForFunction(() => window.__notifications.length === 2)
    assert.deepEqual(await page.evaluate(() => window.__notifications[1]), { title: "Cortana", body: "Background response text" })

    // A completion the user is watching in the foreground must still notify: the done signal is
    // the point, and gating it on scroll position is what made notifications intermittent.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
      // The send-time prompt can only resolve inside a trusted gesture; headless automation is
      // not one, so grant explicitly to exercise the "watching the page" branch.
      Object.defineProperty(window.Notification, "permission", { configurable: true, get: () => "granted" })
    })
    await input.fill("foreground prompt")
    await page.getByRole("button", { name: "Send" }).click()
    await page.waitForFunction(() => window.__gatewayCalls.filter(({ method }) => method === "prompt.submit").length === 2)
    await page.getByText("Streaming foreground prompt").waitFor()
    await page.evaluate(() => window.__mockGatewaySocket.emit({ method: "event", params: { type: "message.complete", session_id: "ui-session", payload: { text: "Foreground completion" } } }))
    // The streamed turn text is what the notice carries; the complete payload only fills in when
    // no delta ever arrived.
    await page.waitForFunction(() => (window.__notifications ?? []).some(({ body }) => body === "Streaming foreground prompt"))

    // Two completions in a row must both be visible: a fixed notification tag replaces the
    // previous one and silently collapses them.
    const tags = await page.evaluate(() => {
      window.__notificationTags = []
      const Original = window.Notification
      window.Notification = class extends Original {
        constructor(title, options) { super(title, options); window.__notificationTags.push(options?.tag) }
      }
      window.Notification.permission = "granted"
      const emit = (type, payload) => window.__mockGatewaySocket.emit({ method: "event", params: { type, session_id: "ui-session", payload } })
      emit("message.complete", { text: "First burst" })
      emit("message.complete", { text: "Second burst" })
      return true
    })
    assert.equal(tags, true)
    await page.waitForFunction(() => (window.__notificationTags ?? []).length >= 2)
    const burstTags = await page.evaluate(() => window.__notificationTags)
    assert.equal(new Set(burstTags).size, burstTags.length, `notification tags must be unique per completion, got ${JSON.stringify(burstTags)}`)

    await page.evaluate(() => { Object.defineProperty(window.Notification, "permission", { configurable: true, get: () => "default" }) })
    await input.fill("second real prompt")
    await page.getByRole("button", { name: "Send" }).click()
    await page.waitForFunction(() => window.__gatewayCalls.filter(({ method }) => method === "prompt.submit").length === 3)
    assert.equal(await page.evaluate(() => window.__permissionRequests), 2, "an undecided permission is asked again on the next send")

    // The explicit control is the reliable path: it runs inside a click gesture, and a refusal
    // must leave a visible, non-nagging state instead of a silent one.
    await page.evaluate(() => {
      window.__permissionRequests = 0
      Object.defineProperty(window.Notification, "permission", { configurable: true, get: () => "default" })
      window.Notification.requestPermission = () => {
        window.__permissionRequests += 1
        Object.defineProperty(window.Notification, "permission", { configurable: true, get: () => "denied" })
        return Promise.resolve("denied")
      }
      // React only re-reads the DOM when something re-renders, so flip the stub before that
      // render lands (as the browser would, before the next gateway event arrives).
      window.__mockGatewaySocket.emit({ method: "event", params: { type: "status.update", session_id: "ui-session", payload: { kind: "process", text: "waiting" } } })
    })
    const enable = page.getByRole("button", { name: "Enable system notifications" })
    await enable.waitFor()
    await enable.click()
    await page.getByRole("button", { name: "System notifications blocked" }).waitFor()
    assert.equal(await page.evaluate(() => window.__permissionRequests), 1, "the explicit control asks once per click")

    // A recorded refusal silences later sends: the page keeps its own record of the refusal
    // even when the stub permission is put back to "default".
    await page.evaluate(() => { window.__permissionRequests = 0 })
    await input.fill("third real prompt")
    await page.getByRole("button", { name: "Send" }).click()
    await page.waitForFunction(() => window.__gatewayCalls.filter(({ method }) => method === "prompt.submit").length === 4)
    assert.equal(await page.evaluate(() => window.__permissionRequests), 0, "a recorded refusal stops the send-time prompt")
    assert.equal(await page.evaluate(() => window.__audioContexts), 0, "no AudioContext should be created or used")
  } finally {
    await browser.close()
    await vite.close()
  }
})

test("build stamp is visible and update notices appear only after a worker update", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await installMockServiceWorker(page)
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    const buildId = await page.locator("#root").getAttribute("data-build")
    assert.ok(buildId)
    assert.equal(await page.locator("#root").getAttribute("data-build"), buildId)
    assert.equal(await page.getByText(`build ${buildId}`, { exact: true }).count(), 1)
    assert.equal(await page.locator('meta[name="cortana-build"]').getAttribute("content"), buildId)
    assert.equal(await page.getByRole("status").count(), 0)

    await page.evaluate(() => {
      window.__fakeServiceWorker.registration.dispatch("updatefound")
      window.__fakeServiceWorker.worker.state = "installed"
      window.__fakeServiceWorker.worker.dispatch("statechange")
    })
    await page.getByRole("status").getByText("New version available —").waitFor()
    await page.getByRole("button", { name: "Reload" }).waitFor()
    await page.getByRole("button", { name: "Dismiss update notice" }).click()
    assert.equal(await page.getByRole("status").count(), 0)
  } finally {
    await browser.close()
    await vite.close()
  }
})

test("controllerchange shows an update notice but no notice appears without an update", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await installMockServiceWorker(page)
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    assert.equal(await page.getByRole("status").count(), 0)
    await page.evaluate(() => window.__fakeServiceWorker.serviceWorker.dispatch("controllerchange"))
    await page.getByRole("status").getByText("New version available —").waitFor()
  } finally {
    await browser.close()
    await vite.close()
  }
})

test("gateway unavailability produces an inline error and never falls back to another transport", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: false } }))
    const attempted = []
    page.on("request", (request) => attempted.push(request.url()))
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.getByRole("textbox", { name: "Message" }).fill("hello")
    await page.getByRole("button", { name: "Send" }).click()
    await page.getByRole("alert").getByText(/TUI Gateway is unavailable/i).waitFor()
    assert.equal(attempted.some((url) => /chat\/completions/.test(url)), false)
  } finally {
    await browser.close()
    await vite.close()
  }
})
