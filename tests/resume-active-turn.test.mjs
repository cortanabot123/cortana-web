import assert from "node:assert/strict"
import test from "node:test"
import { chromium } from "playwright-core"
import { createServer as createViteServer } from "vite"

const launchBrowser = () => chromium.launch({
  headless: true,
  executablePath: "/opt/hermes/tools/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
})

async function openResumedTurn(persistedAssistant, { messages, inflightUser = "Recovered user prompt", inflightAssistant = "partial response" } = {}) {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await page.addInitScript(({ assistantText, transcriptMessages, userText, inflightText }) => {
      localStorage.setItem("cortana-web.hermes.gateway-session", "stored-running-session")
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
          const result = (value) => this.emit({ jsonrpc: "2.0", id: frame.id, result: value })
          if (frame.method === "client.capabilities" || frame.method === "ping") result({})
          else if (frame.method === "session.resume") {
            const startedAt = Date.now() / 1000 - 12
            result({
              session_id: "running-live-session",
              stored_session_id: "stored-running-session",
              messages: transcriptMessages ?? [
                { role: "user", content: "Recovered user prompt" },
                { role: "assistant", content: assistantText },
              ],
              running: true,
              status: "working",
              turn_started_at: startedAt,
              inflight: { user: userText, assistant: inflightText, streaming: true },
              queued: null,
            })
            window.__emitTurnEvent = (type, payload = {}) => this.emit({
              method: "event",
              params: { type, session_id: "running-live-session", payload },
            })
          }
        }
        close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
      }
      window.WebSocket = MockWebSocket
    }, { assistantText: persistedAssistant, transcriptMessages: messages, userText: inflightUser, inflightText: inflightAssistant })

    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    return { page, close: async () => { await browser.close(); await vite.close() } }
  } catch (error) {
    await browser.close()
    await vite.close()
    throw error
  }
}

async function assertRestoredWorkingLayout(page) {
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
      statusRows: scroller?.querySelectorAll('[role="status"]').length ?? 0,
      top: indicatorRect.top,
      bottom: indicatorRect.bottom,
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
  assert.equal(layout.insideScroller, false, "restored working bar must not be inside transcript content")
  assert.equal(layout.statusRows, 0, "restored transcript must contain no status rows")
  assert.equal(layout.visible, true)
  assert.equal(layout.inViewport, true)
  assert.ok(layout.bottom <= layout.inputTop, "restored working bar must sit above InputGroup")
  assert.ok(layout.lastMessageBottom === null || layout.lastMessageBottom <= layout.top, "last resumed transcript message must end above working bar")
  return layout
}

test("resuming a running gateway turn reuses transcript bubbles and streams into the existing assistant", { concurrency: false }, async () => {
  const { page, close } = await openResumedTurn("partial response")
  try {
    const indicator = page.locator("[data-working-indicator]")
    const layout = await assertRestoredWorkingLayout(page)
    const elapsed = layout.text
    const elapsedSeconds = Number(elapsed?.match(/(\d+)s/)?.[1] ?? 0)
    assert.ok(elapsedSeconds >= 12, `elapsed indicator should restore at least 12 seconds, got: ${elapsed}`)

    await page.getByText("Recovered user prompt", { exact: true }).waitFor()
    await page.getByText("partial response", { exact: true }).waitFor()
    const contents = page.locator('[data-slot="message-content"]')
    assert.equal(await contents.count(), 2, "the resumed transcript should contain exactly one user and one assistant bubble")

    await page.evaluate(() => window.__emitTurnEvent("message.delta", { text: " continued" }))
    await page.getByText("partial response continued", { exact: true }).waitFor()
    assert.equal(await contents.count(), 2, "a delta must extend the existing assistant bubble, not create another")
    assert.equal((await contents.nth(1).innerText()).trim(), "partial response continued")

    const composerTopBeforeClear = layout.composerTop
    await page.evaluate(() => window.__emitTurnEvent("message.complete", { text: "final answer" }))
    await page.getByText("final answer", { exact: true }).waitFor()
    await indicator.waitFor({ state: "detached" })
    assert.equal(await page.locator("[data-working-indicator]").count(), 0, "completion should clear the restored busy state")
    const composerTopAfterClear = await page.locator("[data-chat-composer]").evaluate((composer) => composer.getBoundingClientRect().top)
    assert.ok(composerTopAfterClear > composerTopBeforeClear, "clearing the restored bar must shrink the composer instead of leaving a blank gap")
    assert.equal(await contents.count(), 2, "completion should settle the same assistant bubble without duplication")
    assert.equal((await contents.nth(1).innerText()).trim(), "final answer")
  } finally {
    await close()
  }
})

test("a restored-turn error clears the composer status bar without leaving a gap", { concurrency: false }, async () => {
  const { page, close } = await openResumedTurn("partial response")
  try {
    const initial = await assertRestoredWorkingLayout(page)
    await page.evaluate(() => window.__emitTurnEvent("message.error", { message: "restored turn failed" }))
    await page.locator("[data-working-indicator]").waitFor({ state: "detached" })
    assert.equal(await page.locator("[data-working-indicator]").count(), 0, "an error must clear the restored working indicator")
    await page.getByRole("alert").getByText("restored turn failed").waitFor()
    const composerTopAfterClear = await page.locator("[data-chat-composer]").evaluate((composer) => composer.getBoundingClientRect().top)
    assert.ok(composerTopAfterClear > initial.composerTop, "clearing after error must shrink the composer instead of leaving a blank gap")
  } finally {
    await close()
  }
})

test("resuming adopts inflight text when the persisted assistant transcript lags a delta", { concurrency: false }, async () => {
  const { page, close } = await openResumedTurn("partial")
  try {
    const contents = page.locator('[data-slot="message-content"]')
    await page.getByText("Recovered user prompt", { exact: true }).waitFor()
    await page.getByText("partial response", { exact: true }).waitFor()
    assert.equal(await contents.count(), 2, "adopting the newer inflight text must not create an assistant duplicate")
    assert.equal((await contents.nth(1).innerText()).trim(), "partial response")
  } finally {
    await close()
  }
})

test("resuming does not append the original prompt after a persisted correction", { concurrency: false }, async () => {
  const { page, close } = await openResumedTurn("partial", {
    messages: [
      { role: "user", content: "original prompt" },
      { role: "assistant", content: "partial" },
      { role: "user", content: "correction" },
    ],
    inflightUser: "original prompt",
    inflightAssistant: "partial",
  })
  try {
    const contents = page.locator('[data-slot="message-content"]')
    await page.getByText("correction", { exact: true }).waitFor()
    assert.equal(await contents.count(), 3, "the transcript should retain two user bubbles and one assistant bubble")
    const userBubbles = page.locator('[data-slot="message-content"]').filter({ hasText: /original prompt|correction/ })
    assert.equal(await userBubbles.count(), 2)
    const rendered = await userBubbles.allInnerTexts()
    assert.equal(rendered.filter((text) => text.includes("original prompt")).length, 1)
    assert.equal(rendered.filter((text) => text.includes("correction")).length, 1)
  } finally {
    await close()
  }
})

test("resuming adopts the longer persisted assistant text and streams into it", { concurrency: false }, async () => {
  const { page, close } = await openResumedTurn("partial response more", {
    messages: [
      { role: "user", content: "Recovered user prompt" },
      { role: "assistant", content: "partial response more" },
    ],
    inflightAssistant: "partial",
  })
  try {
    const contents = page.locator('[data-slot="message-content"]')
    await page.getByText("partial response more", { exact: true }).waitFor()
    assert.equal(await contents.count(), 2, "the persisted assistant message should be reused without an extra bubble")
    assert.equal((await contents.nth(1).innerText()).trim(), "partial response more")

    await page.evaluate(() => window.__emitTurnEvent("message.delta", { text: "!" }))
    await page.getByText("partial response more!", { exact: true }).waitFor()
    assert.equal(await contents.count(), 2, "the delta should extend the reused assistant bubble")
    assert.equal((await contents.nth(1).innerText()).trim(), "partial response more!")
  } finally {
    await close()
  }
})

test("resuming while thinking does not attach the next delta to the previous answer", { concurrency: false }, async () => {
  const { page, close } = await openResumedTurn("ignored default", {
    messages: [
      { role: "user", content: "上一轮问题" },
      { role: "assistant", content: "上一轮答案" },
      { role: "user", content: "本轮问题" },
    ],
    inflightUser: "本轮问题",
    inflightAssistant: "",
  })
  try {
    const contents = page.locator('[data-slot="message-content"]')
    const previousAnswer = contents.nth(1)
    await page.getByText("上一轮答案", { exact: true }).waitFor()
    await page.getByRole("status").getByText(/Working/).waitFor()
    assert.equal(await previousAnswer.innerText(), "上一轮答案")
    const beforeDeltaCount = await contents.count()

    await page.evaluate(() => window.__emitTurnEvent("message.delta", { text: "新回答" }))
    await page.getByText("新回答", { exact: true }).waitFor()
    assert.equal(await contents.count(), beforeDeltaCount + 1, "the first delta should create an independent assistant bubble")
    assert.equal(await previousAnswer.innerText(), "上一轮答案", "the previous answer must remain byte-for-byte visible")
  } finally {
    await close()
  }
})

test("resuming unrelated inflight text leaves the previous answer untouched", { concurrency: false }, async () => {
  const { page, close } = await openResumedTurn("ignored default", {
    messages: [
      { role: "user", content: "上一轮问题" },
      { role: "assistant", content: "上一轮答案" },
      { role: "user", content: "本轮问题" },
    ],
    inflightUser: "本轮问题",
    inflightAssistant: "completely different",
  })
  try {
    const contents = page.locator('[data-slot="message-content"]')
    const previousAnswer = contents.nth(1)
    await page.getByText("上一轮答案", { exact: true }).waitFor()
    assert.equal(await previousAnswer.innerText(), "上一轮答案")
    assert.equal(await page.getByText("completely different", { exact: true }).count(), 0, "unmatched inflight text is not rendered into an older bubble")

    await page.evaluate(() => window.__emitTurnEvent("message.delta", { text: "新回答" }))
    await page.getByText("新回答", { exact: true }).waitFor()
    assert.equal(await contents.count(), 4, "an unmatched turn starts a separate assistant bubble on its first delta")
    assert.equal(await previousAnswer.innerText(), "上一轮答案", "the unrelated inflight text must not overwrite the previous answer")
  } finally {
    await close()
  }
})
