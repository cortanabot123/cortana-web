/**
 * 验收重复事件、对账恢复及忙态自愈的真实设备回归用例。
 *
 * 缺陷 1：恢复/对账后把回答（甚至上一轮的回答）重复渲染进一个新气泡。
 *   根因在 src/components/chat.tsx：
 *     - `gatewayEventTurnsRef` 每个 session 只有一条 turn 记录（163 行），对账时被 clear/覆盖
 *       （443、468-476 行），丢失"这条 turn 对应哪个气泡"的身份；
 *     - `message.complete`（348-363 行）与 `message.delta`（332-340 行）在找不到 turn 时
 *       走 "unsolicited" 兜底并 **追加** 一个新气泡，既不比对持久化 transcript，也不比对
 *       Hermes 每帧携带的 `params.seq`（/opt/hermes/tui_gateway/event_replay.py 为每个事件
 *       盖了 per-session 单调 seq），因此任何重复投递/迟到的 assistant 文本帧都会变成新气泡；
 *     - `applyReconciledSession` 的 running 分支只用双向 `startsWith` 猜测接管对象
 *       （461-467 行），猜中后把 `adoptedText` 直接覆盖到旧气泡上（477-479 行）。
 *   重复投递不是假设：Hermes 给同一 session 的每个 attach 传输都发一份事件
 *   （/opt/hermes/tui_gateway/session_transports.py:71 `_attach_session_transport` →
 *   `FanoutTransport`），而 Cortana 每次重连都新开一条浏览器 WS → /api/gateway → 新上游 WS，
 *   旧客户端从不关闭（chat.tsx:559 `gatewayClientRef.current = client` 没有 close 前一个），
 *   于是同一帧可能被送到两条仍在的 socket，被处理两次。
 *
 * 缺陷 2：忙态计数卡死（“Working · 114s 已与 Hermes 状态同步”）。
 *   - `applyReconciledSession` 在 running 时把 count 强制置 1（451-454 行）；
 *   - 全文件只有 `message.complete`(369) / `message.error`(389) / 失败的 submit(734、994) /
 *     `clearActiveTurns()`(444、reset、stop) 会减计数；
 *   - `checkGatewayOnForeground`(483-515) 只在 visibilitychange / pageshow / online 时触发，
 *     没有周期性检查，所以丢掉的 complete 不会再有第二次机会把计数减回去 —— 只要用户不切走再切回，
 *     这个 1 就永远在，`turnStartedAt` 也永远不清，`elapsedSeconds` 每秒 +1（765-771 行）。
 *
 * 用法：node --test tests/reorder-repro.test.mjs
 */
import assert from "node:assert/strict"
import test from "node:test"
import { chromium } from "playwright-core"
import { createServer as createViteServer } from "vite"

const launchBrowser = () => chromium.launch({
  headless: true,
  executablePath: "/opt/hermes/tools/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
})

const U1 = "我测试一下，你sleep1min后再回我"
const U2 = "你再来一次"
const A1 = "一分钟到了。你测的结果如何？"
const A2 = "又过了一分钟。测得怎么样？"
const USER_TEXTS = new Set([U1, U2])

/** Mock gateway: one browser socket per connect, resume payload switchable at runtime. */
function installGateway() {
  localStorage.setItem("cortana-web.hermes.gateway-session", "stored-reorder-session")
  window.__calls = []
  window.__sockets = []
  window.__resumePayload = null
  let liveSeq = 0
  class MockWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    readyState = MockWebSocket.CONNECTING
    onmessage = null
    onclose = null
    constructor() {
      this.index = window.__sockets.push(this) - 1
      queueMicrotask(() => {
        this.readyState = MockWebSocket.OPEN
        this.emit({ method: "event", params: { type: "gateway.ready", payload: {} } })
      })
    }
    emit(frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
    event(type, payload = {}, seq) {
      this.emit({ method: "event", params: { type, session_id: window.__liveSessionId, ...(seq ? { seq } : {}), payload } })
    }
    drop() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
    send(raw) {
      const frame = JSON.parse(raw)
      window.__calls.push({ socket: this.index, method: frame.method })
      const result = (value) => this.emit({ jsonrpc: "2.0", id: frame.id, result: value })
      if (frame.method === "client.capabilities" || frame.method === "ping") return result({})
      if (frame.method === "config.get") return result({ value: "medium" })
      if (frame.method === "session.resume") {
        liveSeq += 1
        window.__liveSessionId = `live-${liveSeq}`
        window.__socket = this
        return result(Object.assign({
          session_id: window.__liveSessionId,
          stored_session_id: "stored-reorder-session",
          messages: [],
          running: false,
          status: "idle",
        }, window.__resumePayload ?? {}))
      }
      if (frame.method === "prompt.submit") {
        window.__submits = (window.__submits ?? 0) + 1
        return result({})
      }
      return result({})
    }
    close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
  }
  window.WebSocket = MockWebSocket
  // Emit on the socket that served the most recent session.resume, with its live session id.
  window.__emit = (type, payload = {}, seq) => window.__socket?.event(type, payload, seq)
  window.__drop = () => window.__socket?.drop()
  window.__resumeCount = () => window.__calls.filter((call) => call.method === "session.resume").length
}

async function openChat(page) {
  await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
  await page.addInitScript(installGateway)
  const address = page.__vite.httpServer.address()
  await page.goto(`http://127.0.0.1:${address.port}/`)
  await page.getByRole("textbox", { name: "Message" }).waitFor()
  await page.waitForFunction(() => window.__resumeCount() >= 1)
}

async function bubbles(page) {
  return page.locator('[data-slot="message-content"]').evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent ?? "").trim()),
  )
}

const assistantTexts = (texts) => texts.filter((text) => !USER_TEXTS.has(text))

async function workingBar(page) {
  const bar = page.locator("[data-working-indicator]")
  return (await bar.count()) ? (await bar.innerText()).replace(/\s+/g, " ").trim() : null
}

async function withChat(testBody) {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.__vite = vite
    await openChat(page)
    await testBody(page)
  } finally {
    await browser.close()
    await vite.close()
  }
}

/** Turn 1 streams and completes for real, so the client owns a transcript bubble for A1. */
async function completeFirstTurn(page) {
  await page.getByRole("textbox", { name: "Message" }).fill(U1)
  await page.getByRole("button", { name: "Send" }).click()
  await page.waitForFunction(() => window.__submits >= 1)
  await page.evaluate(({ A1 }) => {
    window.__emit("message.start", {}, 11)
    window.__emit("message.delta", { text: A1 }, 12)
    window.__emit("message.complete", { text: A1, response_previewed: true }, 13)
  }, { A1 })
  await page.getByText(A1, { exact: true }).waitFor()
}

test("对账（running:false，含空 tool 行）后重复投递的同一条回答不得再追加气泡", { concurrency: false }, async () => {
  await withChat(async (page) => {
    await completeFirstTurn(page)

    // 第二轮：本地先有 live 气泡（流式），随后断线。
    await page.getByRole("textbox", { name: "Message" }).fill(U2)
    await page.getByRole("button", { name: "Send" }).click()
    await page.waitForFunction(() => window.__submits >= 2)
    await page.evaluate(({ A2 }) => {
      window.__emit("message.start", {}, 21)
      window.__emit("message.delta", { text: A2.slice(0, 4) }, 22)
      // 真实 payload 形状：第二轮的回答由一个空的 assistant 行（只带 tool_calls）加一个最终行组成。
      window.__resumePayload = {
        running: false,
        status: "idle",
        messages: [
          { role: "user", text: "我测试一下，你sleep1min后再回我" },
          { role: "assistant", text: "一分钟到了。你测的结果如何？" },
          { role: "user", text: "你再来一次" },
          { role: "assistant", text: "", tool_calls: [{ id: "call_00_sleep" }] },
          { role: "assistant", text: A2 },
        ],
      }
    }, { A2 })
    await page.evaluate(() => window.__drop())
    await page.waitForFunction(() => window.__resumeCount() >= 2, null, { timeout: 15_000 })
    await page.getByText(A2, { exact: true }).waitFor()

    // Hermes 给同一 session 的每个 attach 传输各发一份事件；重连后这条 complete 又到了一 次。
    await page.evaluate(({ A2 }) => {
      window.__emit("message.complete", { text: A2, response_previewed: true }, 23)
    }, { A2 })
    await page.waitForTimeout(300)

    const texts = await bubbles(page)
    const assistants = assistantTexts(texts)
    assert.deepEqual(
      assistants,
      [A1, A2],
      `对账后重复投递的 message.complete 被当成新一轮回答追加了气泡（气泡全文：${JSON.stringify(texts)}）`,
    )
    assert.equal(await workingBar(page), null, "对账说 idle 之后不应再显示忙态")
  })
})

test("running 对账后重投上一轮增量不得串入新回答，idle 对账最终清除忙态", { concurrency: false }, async () => {
  await withChat(async (page) => {
    await completeFirstTurn(page)

    // 第二轮：user 气泡 + 本地 live 气泡，随后整条 socket 死掉，第二轮一个字都没到。
    await page.getByRole("textbox", { name: "Message" }).fill(U2)
    await page.getByRole("button", { name: "Send" }).click()
    await page.waitForFunction(() => window.__submits >= 2)
    await page.evaluate(({ A1 }) => {
      window.__emit("message.start", {}, 31)
      // Hermes 此时还在 tool 里睡（inflight.assistant 为空），对账只能恢复"运行中"。
      window.__resumePayload = {
        running: true,
        status: "working",
        turn_started_at: Date.now() / 1000 - 114,
        messages: [
          { role: "user", text: "我测试一下，你sleep1min后再回我" },
          { role: "assistant", text: "一分钟到了。你测的结果如何？" },
          { role: "user", text: "你再来一次" },
        ],
        inflight: { user: "你再来一次", assistant: "" },
      }
      window.__replayedDelta = A1
    }, { A1 })
    await page.evaluate(() => window.__drop())
    await page.waitForFunction(() => window.__resumeCount() >= 2, null, { timeout: 15_000 })
    await page.waitForTimeout(250)

    const restoredBar = await workingBar(page)
    assert.match(restoredBar ?? "", /Working · 1\d\ds 已与 Hermes 状态同步/, `对账应恢复运行中并显示同步状态，实际：${restoredBar}`)

    // 上一轮的回答文本在重连后被重投（duplicated/fan-out frame）：旧内容必须被忽略，不能变成新气泡。
    await page.evaluate(() => {
      window.__emit("message.delta", { text: window.__replayedDelta }, 32)
      window.__resumePayload = {
        running: false,
        status: "idle",
        messages: [
          { role: "user", text: "我测试一下，你sleep1min后再回我" },
          { role: "assistant", text: "一分钟到了。你测的结果如何？" },
          { role: "user", text: "你再来一次" },
        ],
      }
    })
    await page.waitForFunction(() => window.__resumeCount() >= 3, null, { timeout: 20_000 })
    await page.waitForTimeout(300)

    const texts = await bubbles(page)
    const assistants = assistantTexts(texts)
    assert.deepEqual(
      assistants,
      [A1],
      `上一轮的文本被追加成了本轮的新气泡（气泡全文：${JSON.stringify(texts)}）`,
    )
    assert.equal(await workingBar(page), null, "周期对账确认 idle 后应清除忙态")
  })
})

test("complete 丢失后周期性对账检查 idle 并停止忙态计时", { concurrency: false }, async () => {
  await withChat(async (page) => {
    await completeFirstTurn(page)

    await page.getByRole("textbox", { name: "Message" }).fill(U2)
    await page.getByRole("button", { name: "Send" }).click()
    await page.waitForFunction(() => window.__submits >= 2)
    await page.evaluate(() => {
      window.__emit("message.start", {}, 41)
      window.__resumePayload = {
        running: true,
        status: "working",
        turn_started_at: Date.now() / 1000 - 114,
        messages: [
          { role: "user", text: "我测试一下，你sleep1min后再回我" },
          { role: "assistant", text: "一分钟到了。你测的结果如何？" },
          { role: "user", text: "你再来一次" },
        ],
        inflight: { user: "你再来一次", assistant: "" },
      }
    })
    await page.evaluate(() => window.__drop())
    await page.waitForFunction(() => window.__resumeCount() >= 2, null, { timeout: 15_000 })
    await page.waitForTimeout(250)

    const first = await workingBar(page)
    const firstSeconds = Number(first?.match(/(\d+)s/)?.[1] ?? 0)
    const transcriptBefore = await bubbles(page)
    await page.waitForTimeout(2100)
    const second = await workingBar(page)
    const secondSeconds = Number(second?.match(/(\d+)s/)?.[1] ?? 0)
    const transcriptAfter = await bubbles(page)

    assert.deepEqual(transcriptAfter, transcriptBefore, "这段时间里没有新帧，transcript 不应变化")
    assert.ok(secondSeconds > firstSeconds, `忙态计时器应随 turnStartedAt 持续增长（前：${first}，后：${second}）`)
    await page.evaluate(() => {
      window.__resumePayload = {
        running: false,
        status: "idle",
        messages: [
          { role: "user", text: "我测试一下，你sleep1min后再回我" },
          { role: "assistant", text: "一分钟到了。你测的结果如何？" },
          { role: "user", text: "你再来一次" },
        ],
      }
    })
    await page.waitForFunction(() => window.__resumeCount() >= 3, null, { timeout: 20_000 })
    await page.locator("[data-working-indicator]").waitFor({ state: "detached" })
    assert.equal(await workingBar(page), null, "complete 丢失后周期对账返回 idle，应清除忙态并停止计时")
  })
})
