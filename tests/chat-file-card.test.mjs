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
        else if (frame.method === "session.create") result({ session_id: "file-card-session", stored_session_id: "stored-file-card-session" })
        else if (frame.method === "prompt.submit") result({})
      }
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
    }
    window.WebSocket = MockWebSocket
  })
}

test("agent image directives render inline and other files render download cards", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nXsAAAAASUVORK5CYII=", "base64")
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await page.route("**/api/files**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: png }))
    await installMockGateway(page)
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)

    const composer = page.getByRole("textbox", { name: "Message" })
    const send = page.getByRole("button", { name: "Send" })
    await composer.fill("image case")
    await send.click()
    await page.evaluate(() => {
      const socket = window.__mockGatewaySocket
      const emit = (type, payload) => socket.emit({ method: "event", params: { type, session_id: "file-card-session", payload } })
      emit("message.start", {})
      emit("message.delta", { text: 'MEDIA 已生成：\n::file{path="/opt/data/workspace/probe.png"}' })
      emit("message.complete", { text: 'MEDIA 已生成：\n::file{path="/opt/data/workspace/probe.png"}' })
    })
    const image = page.locator('img[data-slot="markdown-image"]')
    await image.waitFor()
    await page.waitForFunction(() => document.querySelector('img[data-slot="markdown-image"]')?.naturalWidth === 1)
    assert.equal(await page.locator('img[data-slot="markdown-image"]').count(), 1)
    assert.equal(await image.evaluate((element) => element.naturalWidth), 1)
    assert.match(await image.getAttribute("src"), /^\/api\/files\?path=/)
    const imageMessage = image.locator("xpath=ancestor::*[@data-slot='message-scroller-item']")
    assert.doesNotMatch(await imageMessage.innerText(), /::file\{/)

    await composer.fill("document case")
    await send.click()
    await page.evaluate(() => {
      const socket = window.__mockGatewaySocket
      const response = '::file{path="/opt/data/workspace/report.docx"}'
      const emit = (type, payload) => socket.emit({ method: "event", params: { type, session_id: "file-card-session", payload } })
      emit("message.start", {})
      emit("message.delta", { text: response })
      emit("message.complete", { text: response })
    })
    const card = page.locator('a[data-slot="file-card"]')
    await card.waitFor()
    assert.equal(await card.count(), 1)
    assert.match(await card.getAttribute("href"), /&download=1$/)
    assert.equal(await card.locator('[data-slot="file-card-name"]').innerText(), "report.docx")
    const cardMessage = card.locator("xpath=ancestor::*[@data-slot='message-scroller-item']")
    assert.equal(await cardMessage.locator("img").count(), 0)
    assert.doesNotMatch(await cardMessage.innerText(), /::file\{/)
  } finally {
    await browser.close()
    await vite.close()
  }
})
