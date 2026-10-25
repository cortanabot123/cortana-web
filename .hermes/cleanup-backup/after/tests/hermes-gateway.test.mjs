import assert from "node:assert/strict"
import { once } from "node:events"
import test from "node:test"
import WebSocket, { WebSocketServer } from "ws"
import { connectHermesGateway } from "../src/lib/hermes-gateway.ts"

async function startGateway() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await once(server, "listening")
  const url = `ws://127.0.0.1:${server.address().port}`
  let peer
  const received = []
  let promptId
  let pendingInterruptId
  server.on("connection", (socket) => {
    peer = socket
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "gateway.ready", payload: { skin: {}, change_events: true, heartbeat: true, replay_epoch: "test-epoch" } },
    }))
    socket.on("message", (message) => {
      const frame = JSON.parse(String(message))
      received.push(frame)
      if (frame.method === "client.capabilities") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { server_requests: [], declines_not_shown: true } }))
      } else if (frame.method === "session.create") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { session_id: "live-session-1", stored_session_id: "stored-session-1" } }))
      } else if (frame.method === "session.resume") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { session_id: "live-session-1", stored_session_id: frame.params.session_id, messages: [] } }))
      } else if (frame.method === "prompt.submit") {
        promptId = frame.id
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { status: "streaming" } }))
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "message.start", session_id: "live-session-1", payload: {} } }))
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: "live-session-1", payload: { text: "Hello " } } }))
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: "live-session-1", payload: { text: "gateway" } } }))
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "message.complete", session_id: "live-session-1", payload: { text: "Hello gateway", status: "complete" } } }))
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "background.complete", session_id: "live-session-1", payload: { task_id: "task-1", text: "Background work finished" } } }))
      } else if (frame.method === "ping") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { pong: true } }))
      } else if (frame.method === "session.interrupt") {
        pendingInterruptId = frame.id
      } else if (frame.method === "client.test.decline") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: "srq-fake-request", method: "preview.read", params: { session_id: "live-session-1" } }))
      }
    })
  })
  return {
    url,
    received,
    get peer() { return peer },
    get promptId() { return promptId },
    get pendingInterruptId() { return pendingInterruptId },
    async close() {
      for (const client of server.clients) client.terminate()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test("JSON-RPC client handshakes, correlates calls, streams events and fails closed on unsupported server requests", async () => {
  const gateway = await startGateway()
  const statuses = []
  const events = []
  const eventEnvelopes = []
  const client = await connectHermesGateway({
    url: gateway.url,
    WebSocketImpl: WebSocket,
    callTimeoutMs: 2_000,
    pingIntervalMs: 60_000,
    onStatus: (method) => statuses.push(method),
    onEvent: (type, payload, sessionId) => {
      events.push(type)
      eventEnvelopes.push({ type, payload, sessionId })
    },
  })
  // Deltas and the completion are read from the event seam: it is the only dispatch path now.
  const deltas = () => eventEnvelopes.filter(({ type }) => type === "message.delta").map(({ payload }) => payload.text).filter((text) => text !== "Proactive ")
  const completion = async () => eventEnvelopes.find(({ type }) => type === "message.complete")?.payload
  try {
    await waitFor(() => gateway.received.some((frame) => frame.method === "client.capabilities"))
    const capabilities = gateway.received.find((frame) => frame.method === "client.capabilities")
    assert.deepEqual(capabilities.params, { server_requests: true })
    assert.equal(events.includes("gateway.ready"), true)
    const sessionId = await client.createSession()
    assert.equal(sessionId, "live-session-1")
    const create = gateway.received.find((frame) => frame.method === "session.create")
    assert.equal(typeof create.id, "number")
    assert.deepEqual(create.params, {})

    const resumed = await client.resumeSession("stored-session-1")
    assert.deepEqual(resumed, { session_id: "live-session-1", stored_session_id: "stored-session-1", messages: [] })
    const resume = gateway.received.find((frame) => frame.method === "session.resume")
    assert.deepEqual(resume.params, { session_id: "stored-session-1" })

    const promptResult = await client.submitPrompt(sessionId, "Build the gateway")
    assert.deepEqual(promptResult, { status: "streaming" })
    const prompt = gateway.received.find((frame) => frame.method === "prompt.submit")
    assert.equal(typeof prompt.id, "number")
    assert.deepEqual(prompt.params, { session_id: sessionId, text: "Build the gateway" })
    assert.equal(prompt.id, gateway.promptId)
    assert.equal(typeof gateway.received.find((frame) => frame.method === "session.create").id, "number")
    assert.notEqual(create.id, prompt.id)
    await waitFor(() => eventEnvelopes.find(({ type }) => type === "background.complete"))
    assert.deepEqual(eventEnvelopes.find(({ type }) => type === "background.complete"), {
      type: "background.complete",
      payload: { task_id: "task-1", text: "Background work finished" },
      sessionId: "live-session-1",
    })
    assert.deepEqual(deltas(), ["Hello ", "gateway"])
    assert.deepEqual(await completion(), { text: "Hello gateway", status: "complete" })

    for (const [type, payload] of [
      ["message.start", {}],
      ["message.delta", { text: "Proactive " }],
      ["message.delta", { text: "reply" }],
      ["message.complete", { text: "Proactive reply" }],
      ["agent.future_event", { detail: "still surfaced" }],
    ]) {
      gateway.peer.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type, session_id: sessionId, payload } }))
    }
    await waitFor(() => eventEnvelopes.find(({ type }) => type === "agent.future_event"))
    assert.deepEqual(eventEnvelopes.slice(-5).map(({ type }) => type), [
      "message.start", "message.delta", "message.delta", "message.complete", "agent.future_event",
    ])

    // Simulate an unsupported server-to-client request and verify the protocol's NOT_SHOWN_CODE.
    gateway.peer.send(JSON.stringify({ jsonrpc: "2.0", id: "srq-test-1", method: "preview.read", params: { session_id: sessionId } }))
    const decline = await waitFor(() => gateway.received.find((frame) => frame.id === "srq-test-1"))
    assert.equal(decline.error.code, 4404)
    assert.deepEqual(statuses, ["preview.read"])

    // An in-flight method is rejected immediately when its transport closes.
    const pending = client.interrupt(sessionId)
    await waitFor(() => gateway.pendingInterruptId !== undefined)
    gateway.peer.close(1011, "test close")
    await assert.rejects(pending, /closed/i)
  } finally {
    client.close()
    await gateway.close()
  }
})

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = predicate()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for JSON-RPC frame")
}
