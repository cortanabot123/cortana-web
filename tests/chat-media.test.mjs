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
        else if (frame.method === "session.create") result({ session_id: "media-session", stored_session_id: "stored-media-session" })
        else if (frame.method === "prompt.submit") {
          result({})
          const event = (type, payload) => this.emit({ method: "event", params: { type, session_id: "media-session", payload } })
          event("message.start", {})
          event("message.delta", { text: window.__mockReplyText })
          event("message.complete", {})
        }
      }
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
    }
    window.WebSocket = MockWebSocket
  })
}

test("assistant MEDIA images render inline and other files render as attachments", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await page.route("**/api/files**", (route) => route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xfc, 0xff, 0x1f, 0x00, 0x03, 0x03, 0x02, 0x00, 0xef, 0x3b, 0x4b, 0x12, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
    }))
    await installMockGateway(page)
    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)

    const input = page.getByRole("textbox", { name: "Message" })
    const send = page.getByRole("button", { name: "Send" })
    await page.evaluate(() => { window.__mockReplyText = "MEDIA:/opt/data/workspace/inline-image.png" })
    await input.fill("show image")
    await send.click()

    const image = page.locator('img[data-slot="markdown-image"]')
    await image.waitFor()
    await page.waitForFunction(() => document.querySelector('img[data-slot="markdown-image"]')?.naturalWidth === 1)
    assert.equal(await image.count(), 1)
    const imageSrc = await image.getAttribute("src")
    assert.ok(imageSrc?.startsWith("/api/files?path="))
    const imageBubble = page.locator('[data-slot="bubble-content"]').last()
    assert.doesNotMatch(await imageBubble.innerText(), /MEDIA:/)

    await page.evaluate(() => { window.__mockReplyText = "MEDIA:/opt/data/workspace/report-final.pdf" })
    await input.fill("show document")
    await send.click()
    const attachment = page.locator('a[data-slot="file-attachment"]')
    await attachment.waitFor()
    assert.equal(await attachment.count(), 1)
    assert.match(await attachment.getAttribute("href"), /\/api\/files\?path=/)
    assert.equal(await attachment.innerText(), "report-final.pdf")
    assert.equal(await page.locator('img[data-slot="markdown-image"]').count(), 1)
    const pdfBubble = page.locator('[data-slot="bubble-content"]').last()
    assert.equal(await pdfBubble.locator('img[data-slot="markdown-image"]').count(), 0)
    assert.doesNotMatch(await pdfBubble.innerText(), /MEDIA:/)
  } finally {
    await browser.close()
    await vite.close()
  }
})
