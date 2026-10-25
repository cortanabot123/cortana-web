import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import test from "node:test"
import WebSocket, { WebSocketServer } from "ws"
import { createAppServer } from "../server.mjs"

const CORTANA_USER = "cortana-test-user"
const CORTANA_PASS = "cortana-test-pass"
const HERMES_USER = "dashboard-test-user"
const HERMES_PASS = "dashboard-test-pass"
const SESSION_COOKIE = "hermes-session-secret-cookie"

async function listening(server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return `http://127.0.0.1:${server.address().port}`
}

function rpcWebSocket(url, { origin, authorization, protocols } = {}) {
  const ws = new WebSocket(url, protocols, {
    headers: { ...(origin ? { Origin: origin } : {}), ...(authorization ? { Authorization: authorization } : {}) },
  })
  ws.on("error", () => {})
  return ws
}

async function startDashboard({ ticket401Once = false } = {}) {
  const tickets = new Map()
  const sockets = []
  let nextTicket = 0
  let loginCount = 0
  let ticketRequestCount = 0
  let consumedCount = 0
  const httpServer = createServer(async (request, response) => {
    if (request.url === "/auth/password-login" && request.method === "POST") {
      loginCount += 1
      let body = ""
      for await (const part of request) body += part
      assert.deepEqual(JSON.parse(body), { provider: "basic", username: HERMES_USER, password: HERMES_PASS })
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": [
          `session=${SESSION_COOKIE}; HttpOnly; Path=/`,
          "csrf=fake-csrf; HttpOnly; Path=/",
          "identity=fake-identity; HttpOnly; Path=/",
        ],
      }).end(JSON.stringify({ ok: true, next: "/" }))
      return
    }
    if (request.url === "/api/auth/ws-ticket" && request.method === "POST") {
      ticketRequestCount += 1
      if (request.headers.cookie?.includes(`session=${SESSION_COOKIE}`) !== true) {
        response.writeHead(401).end("unauthorized")
        return
      }
      if (ticket401Once && ticketRequestCount === 1) {
        response.writeHead(401).end("expired")
        return
      }
      const ticket = `ticket-secret-${++nextTicket}`
      tickets.set(ticket, false)
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ticket, ttl_seconds: 30 }))
      return
    }
    response.writeHead(404).end()
  })
  const wss = new WebSocketServer({ noServer: true, handleProtocols(protocols) {
    return protocols.has("hermes-gateway-v1") ? "hermes-gateway-v1" : false
  } })
  httpServer.on("upgrade", (request, socket, head) => {
    const offered = request.headers["sec-websocket-protocol"]?.split(/\s*,\s*/) ?? []
    const presentedTicket = offered.find((protocol) => protocol.startsWith("hermes-gateway-ticket."))?.slice("hermes-gateway-ticket.".length)
    if (!presentedTicket || tickets.get(presentedTicket) !== false) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    tickets.set(presentedTicket, true)
    consumedCount += 1
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request))
  })
  wss.on("connection", (ws) => {
    sockets.push(ws)
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: { skin: {}, change_events: true, heartbeat: true, replay_epoch: "fake" } } }))
    ws.on("message", (message) => {
      const frame = JSON.parse(String(message))
      if (frame.method === "test.echo") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { echoed: frame.params.value } }))
      }
    })
  })
  const url = await listening(httpServer)
  return {
    url,
    tickets,
    sockets,
    counts: () => ({ loginCount, ticketRequestCount, consumedCount }),
    async close() {
      for (const ws of wss.clients) ws.terminate()
      await new Promise((resolve) => wss.close(resolve))
      httpServer.close()
      await once(httpServer, "close")
    },
  }
}

async function startCortana(options) {
  const server = createAppServer(options)
  const url = await listening(server)
  return {
    url,
    server,
    async close() {
      server.close()
      await once(server, "close")
    },
  }
}

const authorization = `Basic ${Buffer.from(`${CORTANA_USER}:${CORTANA_PASS}`).toString("base64")}`
const dashboardOptions = (dashboardUrl, extra = {}) => ({
  host: "0.0.0.0",
  accessUsername: CORTANA_USER,
  accessPassword: CORTANA_PASS,
  dashboardUrl,
  dashboardUsername: HERMES_USER,
  dashboardPassword: HERMES_PASS,
  gatewayConnectTimeoutMs: 2_000,
  ...extra,
})

test("gateway bridge authenticates, mints one single-use ticket per browser, relays both ways, and propagates close", async () => {
  const dashboard = await startDashboard()
  const cortana = await startCortana(dashboardOptions(dashboard.url))
  const output = []
  const originals = Object.fromEntries(["debug", "info", "log", "warn", "error"].map((method) => [method, console[method]]))
  for (const method of Object.keys(originals)) console[method] = (...args) => output.push(args.join(" "))
  let browser
  try {
    const status = await fetch(`${cortana.url}/api/gateway/status`, { headers: { authorization } })
    assert.deepEqual(await status.json(), { available: true })

    browser = rpcWebSocket(`${cortana.url.replace(/^http/, "ws")}/api/gateway`, {
      origin: cortana.url,
      authorization,
    })
    const readyPromise = nextMessage(browser)
    await once(browser, "open")
    const ready = await readyPromise
    assert.equal(ready.params.type, "gateway.ready")
    const firstDashboardSocket = await waitFor(() => dashboard.sockets.find((socket) => socket instanceof WebSocket))
    const upstreamClosed = once(firstDashboardSocket, "close")
    const echoed = nextMessage(browser)
    browser.send(JSON.stringify({ jsonrpc: "2.0", id: 17, method: "test.echo", params: { value: "browser-to-hermes" } }))
    assert.deepEqual(await echoed, { jsonrpc: "2.0", id: 17, result: { echoed: "browser-to-hermes" } })

    const fromDashboard = nextMessage(browser)
    firstDashboardSocket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "status.update", payload: { kind: "status", text: "Hermes-to-browser" } } }))
    assert.equal((await fromDashboard).params.payload.text, "Hermes-to-browser")
    assert.equal(dashboard.counts().ticketRequestCount, 1)
    assert.equal(dashboard.counts().consumedCount, 1)
    assert.equal([...dashboard.tickets.values()].filter(Boolean).length, 1)
    const spentTicket = [...dashboard.tickets.keys()][0]
    const replay = rpcWebSocket(`${dashboard.url.replace(/^http/, "ws")}/api/ws`, {
      protocols: ["hermes-gateway-v1", `hermes-gateway-ticket.${spentTicket}`],
    })
    const replayStatus = await new Promise((resolve) => replay.once("unexpected-response", (_request, response) => resolve(response.statusCode)))
    assert.equal(replayStatus, 401)

    browser.close(1000, "test complete")
    await once(browser, "close")
    await upstreamClosed
    assert.equal(firstDashboardSocket.readyState, WebSocket.CLOSED)

    const second = rpcWebSocket(`${cortana.url.replace(/^http/, "ws")}/api/gateway`, { origin: cortana.url, authorization })
    await once(second, "open")
    assert.equal(dashboard.counts().ticketRequestCount, 2)
    assert.equal(dashboard.counts().consumedCount, 2)
    second.close()
    await once(second, "close")
    assert.equal([...dashboard.tickets.values()].filter(Boolean).length, 2)
    assert.doesNotMatch(output.join("\n"), new RegExp(`${SESSION_COOKIE}|${HERMES_PASS}|ticket-secret-`))
  } finally {
    for (const method of Object.keys(originals)) console[method] = originals[method]
    browser?.terminate()
    await cortana.close()
    await dashboard.close()
  }
})

test("a ws-ticket 401 causes exactly one serialized re-login and retry", async () => {
  const dashboard = await startDashboard({ ticket401Once: true })
  const cortana = await startCortana(dashboardOptions(dashboard.url))
  let browser
  try {
    browser = rpcWebSocket(`${cortana.url.replace(/^http/, "ws")}/api/gateway`, { origin: cortana.url, authorization })
    await once(browser, "open")
    assert.deepEqual(dashboard.counts(), { loginCount: 2, ticketRequestCount: 2, consumedCount: 1 })
    browser.close()
    await once(browser, "close")
  } finally {
    browser?.terminate()
    await cortana.close()
    await dashboard.close()
  }
})

test("missing Cortana Basic auth refuses the upgrade before dashboard login", async () => {
  const dashboard = await startDashboard()
  const cortana = await startCortana(dashboardOptions(dashboard.url))
  let browser
  try {
    browser = rpcWebSocket(`${cortana.url.replace(/^http/, "ws")}/api/gateway`, { origin: cortana.url })
    const rejection = await new Promise((resolve) => browser.once("unexpected-response", (_request, response) => resolve(response.statusCode)))
    assert.equal(rejection, 401)
    assert.equal(dashboard.counts().loginCount, 0)
  } finally {
    browser?.terminate()
    await cortana.close()
    await dashboard.close()
  }
})

test("unconfigured gateway status and upgrade fail closed", async () => {
  const cortana = await startCortana({ dashboardUsername: "", dashboardPassword: "" })
  let browser
  try {
    assert.deepEqual(await (await fetch(`${cortana.url}/api/gateway/status`)).json(), { available: false })
    browser = rpcWebSocket(`${cortana.url.replace(/^http/, "ws")}/api/gateway`, { origin: cortana.url })
    const rejection = await new Promise((resolve) => browser.once("unexpected-response", (_request, response) => resolve(response.statusCode)))
    assert.equal(rejection, 503)
  } finally {
    browser?.terminate()
    await cortana.close()
  }
})

function nextMessage(socket) {
  return new Promise((resolve) => socket.once("message", (message) => resolve(JSON.parse(String(message)))))
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for fake dashboard connection")
}
