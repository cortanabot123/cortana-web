import assert from "node:assert/strict"
import test from "node:test"
import { chromium } from "playwright-core"
import { createServer as createViteServer } from "vite"

const launchBrowser = () => chromium.launch({
  headless: true,
  executablePath: "/opt/hermes/tools/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
})

test("resume renders injected system messages separately from user bubbles", { concurrency: false }, async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await page.addInitScript(() => {
      localStorage.setItem("cortana-web.hermes.gateway-session", "stored-render-kinds-session")
      class MockWebSocket {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3
        readyState = MockWebSocket.CONNECTING
        onmessage = null
        onclose = null
        constructor() {
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
          else if (frame.method === "session.resume") result({
            session_id: "render-kinds-live-session",
            stored_session_id: "stored-render-kinds-session",
            messages: [
              { role: "user", text: "普通用户提问" },
              {
                role: "user",
                text: "[ASYNC DELEGATION BATCH COMPLETE — deleg_x]\n\n## 验证结果\n\n- 子任务完成",
                display_kind: "async_delegation_complete",
                display_metadata: { display_text: "Subagent Task Completed: 验证任务" },
              },
              {
                role: "user",
                text: "[IMPORTANT: Background process proc_x completed]\n\n## 进程结果\n\n- 命令执行完成",
                display_kind: "process_complete",
                display_metadata: { display_text: "Background Process Finished: pi -n x" },
              },
              { role: "user", text: "[OUT-OF-BAND USER MESSAGE] 请继续", display_kind: "steer" },
            ],
          })
        }
        close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
      }
      window.WebSocket = MockWebSocket
    })

    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    const notices = page.locator('[data-slot="system-notice"]')
    await page.getByRole("heading", { name: "验证结果" }).waitFor()
    await page.getByRole("heading", { name: "进程结果" }).waitFor()

    const noticeBackgrounds = async () => page.evaluate(() => {
      const body = getComputedStyle(document.body).backgroundColor
      const notice = getComputedStyle(document.querySelector('[data-slot="system-notice"]')).backgroundColor
      const user = getComputedStyle(document.querySelector('[data-slot="bubble"] [data-slot="bubble-content"]')).backgroundColor
      const composite = (foreground) => {
        const canvas = document.createElement("canvas")
        canvas.width = 1
        canvas.height = 1
        const context = canvas.getContext("2d")
        context.fillStyle = body
        context.fillRect(0, 0, 1, 1)
        context.fillStyle = foreground
        context.fillRect(0, 0, 1, 1)
        const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
        return `rgb(${red}, ${green}, ${blue})`
      }
      return { body: composite(body), notice: composite(notice), user: composite(user), noticeComputed: notice }
    })
    const lightBackgrounds = await noticeBackgrounds()
    assert.notEqual(lightBackgrounds.notice, lightBackgrounds.body, `light system notice must differ from the page: ${JSON.stringify(lightBackgrounds)}`)
    assert.notEqual(lightBackgrounds.notice, "rgb(255, 255, 255)", `light system notice must have visible contrast against white: ${JSON.stringify(lightBackgrounds)}`)
    assert.notEqual(lightBackgrounds.notice, lightBackgrounds.user, `light system notices and user bubbles must use different backgrounds: ${JSON.stringify(lightBackgrounds)}`)

    await page.evaluate(() => document.documentElement.classList.add("dark"))
    const darkBackgrounds = await noticeBackgrounds()
    assert.notEqual(darkBackgrounds.notice, darkBackgrounds.body, `dark system notice must differ from the page: ${JSON.stringify(darkBackgrounds)}`)
    assert.notEqual(darkBackgrounds.notice, darkBackgrounds.user, `dark system notices and user bubbles must use different backgrounds: ${JSON.stringify(darkBackgrounds)}`)

    assert.equal(await notices.count(), 2, "only marked injected messages render as system notices")
    assert.deepEqual(await notices.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-display-kind"))), [
      "async_delegation_complete",
      "process_complete",
    ])
    assert.deepEqual(await notices.locator('[data-slot="system-notice-header"]').evaluateAll((nodes) => nodes.map((node) => node.textContent.trim())), [
      "Subagent Task Completed: 验证任务",
      "Background Process Finished: pi -n x",
    ])
    assert.equal(await notices.evaluateAll((nodes) => nodes.every((node) => node.getAttribute("role") === "note" && node.closest('[data-slot="bubble"]') === null)), true)
    const userBubbles = page.locator('[data-slot="bubble"]')
    assert.equal(await userBubbles.count(), 2, "ordinary user prompt and steer remain user bubbles")
    assert.deepEqual(await userBubbles.evaluateAll((nodes) => nodes.map((node) => node.textContent.trim())), [
      "普通用户提问",
      "[OUT-OF-BAND USER MESSAGE] 请继续",
    ])
    assert.equal(await notices.locator("h2").count(), 2, "notice Markdown headings are rendered as h2 elements")
    assert.equal(await notices.locator("li").count(), 2, "notice Markdown lists are rendered as list items")
    assert.equal(await notices.evaluateAll((nodes) => nodes.every((node) => node.closest('[data-align="end"]') === null)), true)
  } finally {
    await browser.close()
    await vite.close()
  }
})
