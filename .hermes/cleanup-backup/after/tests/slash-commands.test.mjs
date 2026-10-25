import assert from "node:assert/strict"
import test from "node:test"
import { chromium } from "playwright-core"
import { createServer as createViteServer } from "vite"

const launchBrowser = () => chromium.launch({
  headless: true,
  executablePath: "/opt/hermes/tools/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
})

test("slash completion, command results, directives, errors, and ordinary prompts use mocked gateway RPCs", async () => {
  const vite = await createViteServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.route("**/api/gateway/status", (route) => route.fulfill({ json: { available: true } }))
    await page.addInitScript(() => {
      const catalog = {
        pairs: [["status", "Show Hermes status"], ["learn", "Run a skill"], ["fill", "Prefill composer"], ["snapshot", "Show statistics snapshot"], ["goal", "Show statistics goal"], ["start", "Start a task"]],
        sub: {},
        canon: {},
        commands: { status: {}, learn: {}, fill: {}, snapshot: {}, goal: {}, start: {} },
        categories: [{ name: "Info", pairs: [["status", "Show Hermes status"], ["learn", "Run a skill"], ["fill", "Prefill composer"], ["snapshot", "Show statistics snapshot"], ["goal", "Show statistics goal"], ["start", "Start a task"]] }],
        skills: {},
        skill_count: 0,
        warning: "Catalog warning notice",
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
          else if (frame.method === "session.create") result({ session_id: "slash-session", stored_session_id: "stored-slash-session" })
          else if (frame.method === "commands.catalog") result(catalog)
          else if (frame.method === "slash.exec") {
            const command = frame.params.command
            if (command === "/status") result({ output: "Hermes status output", warning: "Status warning" })
            else if (command === "/learn") result({ type: "skill", message: "Run skill instructions", display: "Skill selected" })
            else if (command === "/fill") result({ type: "prefill", message: "prepared draft" })
            else if (command === "/oops") this.emit({ jsonrpc: "2.0", id: frame.id, error: { code: -32602, message: "Unknown slash command: /oops" } })
            else result({ output: `Result for ${command}` })
          } else if (frame.method === "prompt.submit") {
            result({ status: "streaming" })
            const event = (type, payload) => this.emit({ method: "event", params: { type, session_id: "slash-session", payload } })
            event("message.start", {})
            event("message.delta", { text: `Assistant reply to ${frame.params.text}` })
            event("message.complete", { text: `Assistant reply to ${frame.params.text}` })
          }
        }
        close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
      }
      window.WebSocket = MockWebSocket
    })

    const address = vite.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    const input = page.getByRole("textbox", { name: "Message" })

    await input.fill("/")
    const menu = page.getByRole("listbox", { name: "Slash commands" })
    await menu.waitFor()
    await menu.getByText("Info", { exact: true }).waitFor()
    await input.fill("/stat")
    await menu.getByRole("option").filter({ hasText: "/status" }).waitFor()
    const rankedNames = await menu.getByRole("option").evaluateAll((options) => options.map((option) => option.querySelector("code")?.textContent))
    assert.deepEqual(rankedNames, ["/status", "/snapshot", "/goal"])
    // /status takes no arguments: selecting it from the menu runs it immediately instead of
    // silently inserting text (the user could not tell whether the command had been sent).
    await input.press("Enter")
    assert.equal(await input.inputValue(), "")
    await page.locator("[data-command-result]").filter({ hasText: "Hermes status output" }).waitFor()
    assert.equal(await page.locator("[data-command-result]").filter({ hasText: "Status warning" }).count(), 1)
    assert.equal(await page.getByText("Assistant reply to /status").count(), 0)
    assert.equal(await page.evaluate(() => window.__gatewayCalls.filter(({ method }) => method === "prompt.submit").length), 0)
    assert.deepEqual(await page.evaluate(() => window.__gatewayCalls.filter(({ method }) => method === "slash.exec").map(({ params }) => params)), [
      { session_id: "slash-session", command: "/status" },
    ])
    assert.equal(await page.evaluate(() => window.__gatewayCalls.filter(({ method }) => method === "commands.catalog").length), 1)

    await input.fill("/learn")
    await input.press("Enter")
    await page.locator("[data-command-result]").filter({ hasText: "Skill selected" }).waitFor()
    await page.getByText("Assistant reply to Run skill instructions").waitFor()
    const promptCallsAfterSkill = await page.evaluate(() => window.__gatewayCalls.filter(({ method }) => method === "prompt.submit"))
    assert.equal(promptCallsAfterSkill.length, 1)
    assert.deepEqual(promptCallsAfterSkill[0].params, { session_id: "slash-session", text: "Run skill instructions" })

    await input.fill("/fill")
    await input.press("Enter")
    await page.waitForFunction(() => document.querySelector('[aria-label="Message"]')?.value === "prepared draft")
    assert.equal(await page.evaluate(() => window.__gatewayCalls.filter(({ method }) => method === "prompt.submit").length), 1)

    await input.fill("/oops")
    await input.press("Enter")
    await page.locator("[data-command-result]").filter({ hasText: "Unknown slash command: /oops" }).waitFor()
    assert.equal(await input.inputValue(), "/oops")

    await input.fill("ordinary prompt")
    await page.getByRole("button", { name: "Send" }).click()
    await page.getByText("Assistant reply to ordinary prompt").waitFor()
    const promptCalls = await page.evaluate(() => window.__gatewayCalls.filter(({ method }) => method === "prompt.submit"))
    assert.equal(promptCalls.length, 2)
    assert.deepEqual(promptCalls[1].params, { session_id: "slash-session", text: "ordinary prompt" })
  } finally {
    await browser.close()
    await vite.close()
  }
})
