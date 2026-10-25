import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
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
        else if (frame.method === "session.create") result({ session_id: "panel-session", stored_session_id: "stored-panel-session" })
        else if (frame.method === "prompt.submit") {
          result({})
          const event = (type, payload) => this.emit({ method: "event", params: { type, session_id: "panel-session", payload } })
          event("message.start", {})
          window.__completeCurrentTurn = (text) => event("message.complete", { text })
        } else if (frame.method === "session.interrupt") result({})
      }
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
    }
    window.WebSocket = MockWebSocket
  })
}

async function assertMobileViewportLocked(page) {
  const state = await page.evaluate(() => ({
    scrollY: window.scrollY,
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    headerTop: document.querySelector("header")?.getBoundingClientRect().top ?? -1,
  }))
  assert.equal(state.scrollY, 0, `mobile page must not scroll away from the header: ${JSON.stringify(state)}`)
  assert.ok(state.documentHeight <= state.viewportHeight + 1, `mobile app must not overflow the page viewport: ${JSON.stringify(state)}`)
  assert.ok(state.headerTop >= 0, `mobile header must remain visible: ${JSON.stringify(state)}`)
}

async function measurePanel(page) {
  return page.evaluate(() => {
    const panel = document.querySelector("[data-chat-panel]")
    const header = document.querySelector("header")
    const form = document.querySelector("[data-chat-composer]")
    const viewport = document.querySelector('[data-slot="message-scroller-viewport"]')
    const items = [...document.querySelectorAll('[data-slot="message-scroller-item"]')]
    const itemRects = items.map((item) => item.getBoundingClientRect())
    const panelRect = panel.getBoundingClientRect()
    const headerRect = header.getBoundingClientRect()
    const formRect = form.getBoundingClientRect()
    const viewportRect = viewport?.getBoundingClientRect()
    const content = document.querySelector('[data-slot="message-scroller-content"]')
    const contentStyle = content ? getComputedStyle(content) : null
    const verticalPadding = contentStyle ? (Number.parseFloat(contentStyle.paddingTop) || 0) + (Number.parseFloat(contentStyle.paddingBottom) || 0) : 0
    return {
      panel: panelRect.height,
      panelWidth: panelRect.width,
      panelLeft: panelRect.left,
      panelTop: panelRect.top,
      viewportWidth: window.innerWidth,
      cap: window.innerHeight,
      header: headerRect.height,
      composer: formRect.height,
      itemsHeight: itemRects.reduce((height, rect) => height + rect.height, 0),
      itemGap: itemRects.length > 1 ? itemRects.slice(1).reduce((gap, rect, index) => gap + rect.top - itemRects[index].bottom, 0) : 0,
      contentPadding: verticalPadding,
      lastItemGap: itemRects.length ? formRect.top - itemRects.at(-1).bottom : null,
      viewportGap: viewportRect ? formRect.top - viewportRect.bottom : null,
      viewportHeight: viewportRect?.height ?? 0,
      scrollTop: viewport?.scrollTop ?? 0,
      scrollHeight: viewport?.scrollHeight ?? 0,
      scrollClientHeight: viewport?.clientHeight ?? 0,
      lastItemBottomVisible: itemRects.length > 0 && itemRects.at(-1).bottom <= viewportRect.bottom + 1 && itemRects.at(-1).bottom <= formRect.top,
    }
  })
}

test("chat fills the whole viewport on every breakpoint and scrolls internally", async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  mkdirSync("tests/screenshots", { recursive: true })
  const measurements = {}
  try {
    for (const viewport of [{ name: "desktop-1600x1100", width: 1600, height: 1100 }, { name: "mobile-390x844", width: 390, height: 844 }]) {
      // The app is full-bleed on every breakpoint: no phone-shaped card and no surrounding gutters.
      const isMobile = viewport.width < 768
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
      await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
      await installMockGateway(page)
      const address = vite.httpServer.address()
      await page.goto(`http://127.0.0.1:${address.port}/`)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(100)
      const states = {}
      states.empty = await measurePanel(page)
      await page.screenshot({ path: `tests/screenshots/panel-${viewport.name}-empty.png` })
      assert.ok(Math.abs(states.empty.panel - states.empty.cap) <= 1, `panel should fill the viewport height: ${JSON.stringify(states.empty)}`)
      assert.ok(Math.abs(states.empty.panelWidth - states.empty.viewportWidth) <= 1, `panel should fill the viewport width (no simulated phone card): ${JSON.stringify(states.empty)}`)
      assert.equal(states.empty.panelTop, 0, `panel must start at the top edge: ${JSON.stringify(states.empty)}`)
      assert.equal(states.empty.panelLeft, 0, `panel must start at the left edge: ${JSON.stringify(states.empty)}`)

      const input = page.getByRole("textbox", { name: "Message" })
      await input.fill("A short first question")
      await input.press("Enter")
      await page.getByRole("status").getByText(/Working/).waitFor()
      await page.waitForTimeout(100)
      states.oneMessageWorking = await measurePanel(page)
      if (isMobile) await assertMobileViewportLocked(page)
      await page.screenshot({ path: `tests/screenshots/panel-${viewport.name}-working.png` })
      assert.ok(Math.abs(states.oneMessageWorking.panel - states.oneMessageWorking.cap) <= 1, `panel must not grow or shrink with content: ${JSON.stringify(states.oneMessageWorking)}`)
      assert.ok(states.oneMessageWorking.lastItemGap <= 40, `working indicator should sit close to the composer: ${JSON.stringify(states.oneMessageWorking)}`)

      await page.evaluate(() => window.__completeCurrentTurn("A brief answer."))
      await page.getByText("A brief answer.").waitFor()
      await page.getByRole("status").waitFor({ state: "detached" })
      states.twoMessages = await measurePanel(page)
      assert.ok(Math.abs(states.twoMessages.panel - states.twoMessages.cap) <= 1, `two-message panel should still fill the viewport: ${JSON.stringify(states.twoMessages)}`)
      assert.ok(states.twoMessages.lastItemGap <= 40, `two-message transcript must end close to composer: ${JSON.stringify(states.twoMessages)}`)

      await input.fill("A second short question")
      await input.press("Enter")
      await page.getByRole("status").getByText(/Working/).waitFor()
      await page.evaluate(() => window.__completeCurrentTurn("A second brief answer."))
      await page.getByText("A second brief answer.").waitFor()
      await page.getByRole("status").waitFor({ state: "detached" })

      const longReply = Array.from({ length: 28 }, (_, index) => `Long conversation paragraph ${index + 1}: A DNS resolver follows the delegation chain, checks cached records, and returns the address associated with the requested service. This longer paragraph makes the transcript exceed the available viewport while preserving readable line wrapping.`).join("\n\n")
      await input.fill("Show me a long explanation")
      await input.press("Enter")
      await page.waitForFunction(() => window.__gatewayCalls.filter(({ method }) => method === "prompt.submit").length === 3)
      await page.evaluate((text) => window.__completeCurrentTurn(text), longReply)
      await page.getByText("Long conversation paragraph 28:").waitFor()
      await page.waitForFunction(() => {
        const viewport = document.querySelector('[data-slot="message-scroller-viewport"]')
        return viewport && Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 1
      })
      states.longConversation = await measurePanel(page)
      await page.screenshot({ path: `tests/screenshots/panel-${viewport.name}-long.png` })
      assert.ok(Math.abs(states.longConversation.panel - states.longConversation.cap) <= 1, `long conversation should reach viewport cap: ${JSON.stringify(states.longConversation)}`)
      assert.ok(Math.abs(states.longConversation.scrollHeight - states.longConversation.scrollClientHeight - states.longConversation.scrollTop) <= 1, `long transcript should be scrolled to end: ${JSON.stringify(states.longConversation)}`)
      assert.ok(states.longConversation.lastItemBottomVisible, `last message bottom must be fully visible above composer: ${JSON.stringify(states.longConversation)}`)
      assert.ok(states.longConversation.viewportGap >= 0, `transcript viewport must not overlap composer: ${JSON.stringify(states.longConversation)}`)

      await input.fill("/new")
      await input.press("Enter")
      await page.waitForFunction(() => window.__gatewayCalls.filter(({ method }) => method === "session.create").length === 2)
      // /new now follows the New conversation button and leaves an empty welcome screen.
      await page.getByText("What should we build?").waitFor()
      await page.waitForFunction(() => document.querySelectorAll('[data-slot="message-scroller-item"]').length === 0)
      states.afterNew = await measurePanel(page)
      if (isMobile) await assertMobileViewportLocked(page)
      assert.ok(Math.abs(states.afterNew.panel - states.afterNew.cap) <= 1, `reset panel should stay at the full viewport: ${JSON.stringify(states.afterNew)}`)
      measurements[viewport.name] = states
      await page.close()
    }
    console.log(`Measured panel heights: ${JSON.stringify(measurements)}`)
  } finally {
    await browser.close()
    await vite.close()
  }
})
