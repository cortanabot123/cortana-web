export type StatusUpdatePayload = { kind: string; text: string }
export type GatewayEventPayload = Record<string, unknown>

const GATEWAY_SESSION_STORAGE_KEY = "cortana-web.hermes.gateway-session"
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function loadHermesGatewaySessionId(storage?: StorageLike): string | null {
  try {
    return (storage ?? window.localStorage).getItem(GATEWAY_SESSION_STORAGE_KEY)?.trim() || null
  } catch {
    return null
  }
}

export function saveHermesGatewaySessionId(sessionId: string, storage?: StorageLike): void {
  try {
    ;(storage ?? window.localStorage).setItem(GATEWAY_SESSION_STORAGE_KEY, sessionId)
  } catch {
    // Keep this tab usable when browser persistence is blocked.
  }
}

export function clearHermesGatewaySessionId(storage?: StorageLike): void {
  try {
    ;(storage ?? window.localStorage).removeItem(GATEWAY_SESSION_STORAGE_KEY)
  } catch {
    // Reset still clears the in-memory session when browser persistence is blocked.
  }
}

export type HermesGatewayOptions = {
  url?: string
  onEvent?: (type: string, payload: GatewayEventPayload, sessionId?: string) => void
  onDelta?: (text: string, payload: GatewayEventPayload) => void
  onComplete?: (payload: GatewayEventPayload) => void
  onError?: (error: Error | GatewayEventPayload) => void
  onStatus?: (status: string) => void
  WebSocketImpl?: new (url: string) => WebSocket
  callTimeoutMs?: number
  pingIntervalMs?: number
  probeTimeoutMs?: number
}

type PendingCall = { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
type RpcFrame = {
  jsonrpc?: string
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export type HermesGatewaySession = {
  session_id: string
  stored_session_id?: string
  messages?: unknown[]
  [key: string]: unknown
}

export type CommandCatalogCategory = { name: string; pairs: string[][] }
export type CommandsCatalogResult = {
  pairs: string[][]
  sub: Record<string, string[]>
  canon: Record<string, string>
  commands: Record<string, { argument_mode?: "options" | "text" | "mixed" | null; desktop?: string | null; desktop_subcommands?: string[] | null }>
  categories: CommandCatalogCategory[]
  skills: Record<string, { usage: number; origin: string }>
  skill_count: number
  warning: string
}
export type SlashExecResult = {
  output?: string | null
  warning?: string | null
  type?: "exec" | "alias" | "plugin" | "send" | "skill" | "prefill" | null
  target?: string | null
  message?: string | null
  notice?: string | null
  display?: string | null
  name?: string | null
  status?: string | null
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
export type ReasoningState = { value: ReasoningEffort | ""; display?: string }
export type ConfigSetResult = { key?: string; value?: string; scope?: string; warning?: string }

export type HermesGatewayClient = {
  createSession(): Promise<string>
  createSessionDetails(): Promise<{ sessionId: string; storedSessionId: string }>
  resumeSession(sessionId: string): Promise<HermesGatewaySession>
  submitPrompt(sessionId: string, text: string): Promise<unknown>
  commandsCatalog(sessionId?: string): Promise<CommandsCatalogResult>
  slashExec(sessionId: string, command: string): Promise<SlashExecResult>
  interrupt(sessionId: string): Promise<unknown>
  getReasoning(sessionId?: string): Promise<ReasoningState>
  setReasoning(
    sessionId: string | null,
    effort: ReasoningEffort,
    scope?: "session" | "global",
  ): Promise<ConfigSetResult>
  probe(): Promise<void>
  close(): void
}

/** Opens a same-origin Cortana gateway connection and exposes the small chat RPC surface. */
export function connectHermesGateway(options: HermesGatewayOptions = {}): Promise<HermesGatewayClient> {
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket
  const url = options.url ?? "/api/gateway"
  const timeoutMs = options.callTimeoutMs ?? 30_000
  const pending = new Map<string | number, PendingCall>()
  let nextId = 0
  let socket: WebSocket
  let keepalive: ReturnType<typeof setInterval> | undefined
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  let readySettled = false
  let closed = false
  let intentionalClose = false
  let readyResolve!: (client: HermesGatewayClient) => void
  let readyReject!: (error: Error) => void

  const connection = new Promise<HermesGatewayClient>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })

  const failPending = (error: Error) => {
    for (const call of pending.values()) {
      clearTimeout(call.timer)
      call.reject(error)
    }
    pending.clear()
  }

  const sendFrame = (frame: RpcFrame) => {
    if (closed || socket.readyState !== 1) throw new Error("Hermes gateway is not connected")
    try {
      socket.send(JSON.stringify(frame))
    } catch (cause) {
      // A socket that passed the readyState check can still be half-dead after the proxy
      // reclaimed it; treat the throw as a disconnect so the caller reconnects instead of
      // dropping the frame and any completion that would have followed it.
      disconnect(cause instanceof Error ? cause : new Error("Hermes gateway send failed"))
      throw cause
    }
  }

  const call = <T = unknown>(method: string, params: Record<string, unknown> = {}, callTimeoutMs = timeoutMs): Promise<T> => {
    if (closed || socket.readyState !== 1) return Promise.reject(new Error("Hermes gateway is not connected"))
    const id = ++nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Hermes gateway call timed out: ${method}`))
      }, callTimeoutMs)
      pending.set(id, { resolve: resolve as (result: any) => void, reject, timer })
      try {
        sendFrame({ jsonrpc: "2.0", id, method, params })
      } catch (cause) {
        clearTimeout(timer)
        pending.delete(id)
        reject(cause instanceof Error ? cause : new Error("Hermes gateway send failed"))
      }
    })
  }

  const disconnect = (error: Error) => {
    if (closed) return
    closed = true
    if (keepalive) clearInterval(keepalive)
    failPending(error)
    options.onError?.(error)
    options.onStatus?.(`Disconnected: ${error.message}`)
    try { socket.close() } catch { /* socket already closed */ }
  }

  const client: HermesGatewayClient = {
    async createSession() {
      return (await this.createSessionDetails()).sessionId
    },
    async createSessionDetails() {
      const result = await call<{ session_id?: unknown; stored_session_id?: unknown }>("session.create")
      if (typeof result?.session_id !== "string" || !result.session_id) throw new Error("Hermes gateway returned no session id")
      if (typeof result.stored_session_id !== "string" || !result.stored_session_id) throw new Error("Hermes gateway returned no stored session id")
      return { sessionId: result.session_id, storedSessionId: result.stored_session_id }
    },
    async resumeSession(sessionId) {
      const result = await call<HermesGatewaySession>("session.resume", { session_id: sessionId })
      if (typeof result?.session_id !== "string" || !result.session_id) throw new Error("Hermes gateway returned no resumed session id")
      return result
    },
    submitPrompt(sessionId, text) {
      return call("prompt.submit", { session_id: sessionId, text })
    },
    commandsCatalog(sessionId) {
      return call<CommandsCatalogResult>("commands.catalog", sessionId ? { session_id: sessionId } : {})
    },
    slashExec(sessionId, command) {
      return call<SlashExecResult>("slash.exec", { session_id: sessionId, command })
    },
    interrupt(sessionId) {
      return call("session.interrupt", { session_id: sessionId })
    },
    async getReasoning(sessionId) {
      const result = await call<ReasoningState>("config.get", sessionId ? { key: "reasoning", session_id: sessionId } : { key: "reasoning" })
      const value = typeof result?.value === "string" ? result.value.trim().toLowerCase() : ""
      return { value: value as ReasoningState["value"], display: typeof result?.display === "string" ? result.display : undefined }
    },
    setReasoning(sessionId, effort, scope = "session") {
      // scope="session" pins the level to this conversation only; "global" writes
      // agent.reasoning_effort in config.yaml for every future session.
      const params: Record<string, unknown> = { key: "reasoning", value: effort, scope }
      if (sessionId) params.session_id = sessionId
      return call<ConfigSetResult>("config.set", params)
    },
    async probe() {
      try {
        await call("ping", {}, options.probeTimeoutMs ?? Math.min(timeoutMs, 3000))
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error("Hermes gateway probe failed")
        disconnect(error)
        throw error
      }
    },
    close() {
      if (intentionalClose) return
      intentionalClose = true
      if (closed) {
        try { socket.close() } catch { /* socket already closed */ }
        return
      }
      closed = true
      if (keepalive) clearInterval(keepalive)
      failPending(new Error("Hermes gateway closed"))
      try { socket.close() } catch { /* socket already closed */ }
    },
  }

  try {
    socket = new WebSocketImpl(url)
  } catch (cause) {
    readySettled = true
    readyReject(cause instanceof Error ? cause : new Error("Unable to open Hermes gateway"))
    return connection
  }

  socket.onmessage = (messageEvent: MessageEvent) => {
    let frame: RpcFrame
    try {
      const raw = typeof messageEvent.data === "string" ? messageEvent.data : String(messageEvent.data)
      frame = JSON.parse(raw) as RpcFrame
    } catch {
      options.onError?.(new Error("Hermes gateway sent malformed JSON-RPC data"))
      return
    }

    if (frame.method === "event") {
      const params = frame.params
      if (!params || typeof params.type !== "string") return
      const type = params.type
      const payload = params.payload && typeof params.payload === "object" ? params.payload as GatewayEventPayload : {}
      const sessionId = typeof params.session_id === "string" ? params.session_id : undefined
      options.onEvent?.(type, payload, sessionId)
      if (type === "gateway.ready" && !readySettled) {
        readySettled = true
        if (readyTimer) clearTimeout(readyTimer)
        try {
          void call("client.capabilities", { server_requests: true }).catch((error: unknown) => {
            options.onError?.(error instanceof Error ? error : new Error("Hermes capabilities request failed"))
          })
          keepalive = setInterval(() => {
            void call("ping").catch((cause: unknown) => {
              const error = cause instanceof Error ? cause : new Error("Hermes gateway ping failed")
              disconnect(error)
            })
          }, options.pingIntervalMs ?? 15_000)
          readyResolve(client)
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error("Hermes gateway handshake failed")
          readyReject(error)
          client.close()
        }
      } else if (type === "message.delta" && typeof payload.text === "string") {
        options.onDelta?.(payload.text, payload)
      } else if (type === "message.complete") {
        options.onComplete?.(payload)
      } else if (type === "error") {
        options.onError?.(payload)
      }
      return
    }

    if (frame.method && frame.id !== undefined && !("result" in frame) && !("error" in frame)) {
      options.onStatus?.(frame.method)
      try {
        sendFrame({ jsonrpc: "2.0", id: frame.id, error: { code: 4404, message: "This request is not shown in Cortana." } })
      } catch (cause) {
        options.onError?.(cause instanceof Error ? cause : new Error("Unable to decline Hermes request"))
      }
      return
    }

    if (frame.id === undefined) return
    const callState = pending.get(frame.id)
    if (!callState) return
    pending.delete(frame.id)
    clearTimeout(callState.timer)
    if (frame.error) callState.reject(new Error(frame.error.message || `Hermes RPC failed (${frame.error.code ?? "unknown"})`))
    else callState.resolve(frame.result)
  }

  socket.onclose = () => {
    const alreadyDisconnected = closed
    closed = true
    if (readyTimer) clearTimeout(readyTimer)
    if (keepalive) clearInterval(keepalive)
    const error = new Error("Hermes gateway connection closed")
    if (!intentionalClose && !alreadyDisconnected) {
      options.onStatus?.("Disconnected: Hermes gateway connection closed")
      options.onError?.(error)
    }
    failPending(error)
    if (!readySettled) {
      readySettled = true
      readyReject(error)
    }
  }
  socket.onerror = () => {
    options.onError?.(new Error("Hermes gateway connection error"))
    if (!readySettled) {
      readySettled = true
      if (readyTimer) clearTimeout(readyTimer)
      readyReject(new Error("Unable to connect to Hermes gateway"))
    }
  }
  readyTimer = setTimeout(() => {
    if (readySettled) return
    readySettled = true
    readyReject(new Error("Hermes gateway ready handshake timed out"))
    client.close()
  }, timeoutMs)

  return connection
}
