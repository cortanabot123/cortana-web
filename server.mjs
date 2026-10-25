import { createReadStream, existsSync, statSync } from "node:fs"
import { chmod, mkdir, open, rm } from "node:fs/promises"
import { randomUUID, timingSafeEqual, createHash, createHmac } from "node:crypto"
import { isIP } from "node:net"
import { createServer } from "node:http"
import WebSocket, { WebSocketServer } from "ws"
import { pipeline } from "node:stream"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
}

function isLoopbackHost(host) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (normalized === "localhost") return true
  if (isIP(normalized) === 4) return normalized.startsWith("127.")
  return normalized === "::1"
}

function constantTimeEqual(left, right) {
  const leftDigest = createHash("sha256").update(left).digest()
  const rightDigest = createHash("sha256").update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest) && left.length === right.length
}

function hasValidBasicAuth(request, username, password) {
  const authorization = request.headers.authorization
  if (typeof authorization !== "string") return false
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization)
  if (!match) return false
  const decoded = Buffer.from(match[1], "base64")
  const separator = decoded.indexOf(0x3a)
  if (separator < 0) return false
  const usernameValid = constantTimeEqual(decoded.subarray(0, separator), Buffer.from(username))
  const passwordValid = constantTimeEqual(decoded.subarray(separator + 1), Buffer.from(password))
  return usernameValid && passwordValid
}

function sendText(response, status, message) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  response.end(JSON.stringify({ error: message }))
}

// --- remember-me session cookie ---------------------------------------------------------
// Browsers do not reliably re-send HTTP Basic credentials after a reload (mobile browsers in
// particular re-prompt every time), so a successful Basic login also mints a signed cookie that
// keeps the user signed in. The cookie is stateless: HMAC over {user, expiry} keyed by the
// configured credentials, so rotating either credential invalidates every outstanding session.
const SESSION_COOKIE = "cortana_session"
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30

function sessionKey(username, password) {
  return createHash("sha256").update(`cortana-web-session\u0000${username}\u0000${password}`).digest()
}

function signSession(payload, username, password) {
  return createHmac("sha256", sessionKey(username, password)).update(payload).digest("base64url")
}

export function createSessionToken(username, password, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    u: username,
    e: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  })).toString("base64url")
  return `${payload}.${signSession(payload, username, password)}`
}

export function isValidSessionToken(token, username, password, now = Date.now()) {
  if (typeof token !== "string") return false
  const separator = token.indexOf(".")
  if (separator <= 0 || separator === token.length - 1) return false
  const payload = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  if (!constantTimeEqual(signature, signSession(payload, username, password))) return false
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return data?.u === username && typeof data?.e === "number" && data.e * 1000 > now
  } catch {
    return false
  }
}

function readCookie(request, name) {
  const header = request.headers.cookie
  if (typeof header !== "string") return null
  for (const part of header.split(";")) {
    const separator = part.indexOf("=")
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(part.slice(separator + 1).trim())
  }
  return null
}

function hasValidSession(request, username, password) {
  return isValidSessionToken(readCookie(request, SESSION_COOKIE), username, password)
}

function isSecureRequest(request) {
  const forwarded = request.headers["x-forwarded-proto"]
  const proto = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : ""
  return proto === "https" || Boolean(request.socket?.encrypted)
}

function sessionCookie(request, username, password) {
  const attributes = [
    `${SESSION_COOKIE}=${createSessionToken(username, password)}`,
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
  ]
  if (isSecureRequest(request)) attributes.push("Secure")
  return attributes.join("; ")
}

/** True when the request carries valid Basic credentials or a valid session cookie. */
function hasAccess(request, username, password) {
  return hasValidBasicAuth(request, username, password) || hasValidSession(request, username, password)
}

/** One origin check for both HTTP routes and the WebSocket upgrade. */
function sameOriginRequest(request, { allowAnyPath = false } = {}) {
  const originHeader = request.headers.origin
  const hostHeader = request.headers.host
  if (typeof originHeader !== "string" || typeof hostHeader !== "string") return false
  try {
    const origin = new URL(originHeader)
    const forwardedProto = request.headers["x-forwarded-proto"]
    const forwarded = typeof forwardedProto === "string" ? forwardedProto.split(",", 1)[0].trim() : ""
    if (forwarded && forwarded !== "http" && forwarded !== "https") return false
    const expectedProtocol = forwarded ? `${forwarded}:` : request.socket.encrypted ? "https:" : "http:"
    return origin.protocol === expectedProtocol
      && !origin.username && !origin.password && (allowAnyPath || origin.pathname === "/") && !origin.search && !origin.hash
      && origin.host.toLowerCase() === hostHeader.toLowerCase()
  } catch {
    return false
  }
}

function safeUploadName(header) {
  if (typeof header !== "string" || header.length > 1024) return null
  let decoded
  try { decoded = decodeURIComponent(header) } catch { return null }
  const name = decoded.split(/[\\/]/).at(-1).replace(/[\\u0000-\\u001f\\u007f]/g, "").trim().slice(0, 255)
  return name || "uploaded-file"
}

async function receiveUpload(request, response, uploadRoot) {
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST", "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify({ error: "Method not allowed" }))
    return
  }
  if (!sameOriginRequest(request)) {
    sendText(response, 403, "Upload must come from this site")
    request.resume()
    return
  }
  const name = safeUploadName(request.headers["x-file-name"])
  if (!name) {
    sendText(response, 400, "A valid file name is required")
    request.resume()
    return
  }
  const contentLength = request.headers["content-length"]
  if (contentLength !== undefined && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > MAX_UPLOAD_BYTES)) {
    sendText(response, Number(contentLength) > MAX_UPLOAD_BYTES ? 413 : 400, Number(contentLength) > MAX_UPLOAD_BYTES ? "Files must be 25 MiB or smaller" : "Invalid upload size")
    request.resume()
    return
  }

  let directory
  let filePath
  let file
  try {
    await mkdir(uploadRoot, { recursive: true, mode: 0o700 })
    await chmod(uploadRoot, 0o700)
    directory = path.join(uploadRoot, randomUUID())
    await mkdir(directory, { mode: 0o700 })
    filePath = path.join(directory, randomUUID())
    file = await open(filePath, "wx", 0o600)
    let size = 0
    let exceededLimit = false
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_UPLOAD_BYTES && !exceededLimit) {
        exceededLimit = true
        await file.close()
        file = null
        await rm(directory, { recursive: true, force: true })
        continue
      }
      if (!exceededLimit) await file.writeFile(chunk)
    }
    if (exceededLimit) {
      sendText(response, 413, "Files must be 25 MiB or smaller")
      return
    }
    await file.close()
    file = null
    response.writeHead(201, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
    response.end(JSON.stringify({ name, path: path.resolve(filePath) }))
  } catch {
    if (file) await file.close().catch(() => {})
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
    if (!response.headersSent && !response.destroyed) sendText(response, 500, "Unable to store uploaded file")
  }
}

function serveStatic(request, response, distDir) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end()
    return
  }
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname)
  const resolved = path.resolve(distDir, `.${pathname}`)
  if (resolved !== distDir && !resolved.startsWith(`${path.resolve(distDir)}${path.sep}`)) {
    response.writeHead(403).end()
    return
  }
  let filePath = resolved
  if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = path.join(distDir, "index.html")
  if (!existsSync(filePath)) {
    response.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("Build the app with npm run build first.")
    return
  }
  const ext = path.extname(filePath)
  response.writeHead(200, {
    "content-type": MIME_TYPES[ext] ?? "application/octet-stream",
    "cache-control": ext === ".html" || path.basename(filePath) === "sw.js" ? "no-cache" : "public, max-age=31536000, immutable",
  })
  if (request.method === "HEAD") response.end()
  else pipeline(createReadStream(filePath), response, (error) => { if (error && !response.destroyed) response.destroy(error) })
}

export function getListenHost(env = process.env) {
  return env.HOST || "127.0.0.1"
}

export function createHermesGatewayBridge({
  dashboardUrl = process.env.HERMES_DASHBOARD_URL || "http://127.0.0.1:9119",
  username = process.env.HERMES_DASHBOARD_USERNAME,
  password = process.env.HERMES_DASHBOARD_PASSWORD,
  fetchImpl = fetch,
  wsConnectFactory = (url, protocols) => new WebSocket(url, protocols),
} = {}) {
  let cookieJar = ""
  let loginPromise = null
  let dashboardBaseUrl = ""
  try {
    const parsed = new URL(dashboardUrl)
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
      dashboardBaseUrl = parsed.origin
    }
  } catch { /* an invalid URL leaves the optional gateway unavailable */ }
  const available = Boolean(username && password && dashboardBaseUrl)

  async function loginDashboard({ force = false } = {}) {
    if (!available) throw new Error("Hermes gateway is not configured")
    if (!force && cookieJar) return cookieJar
    if (loginPromise) return loginPromise
    loginPromise = (async () => {
      let response
      try {
        response = await fetchImpl(new URL("/auth/password-login", dashboardBaseUrl), {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ provider: "basic", username, password }),
          signal: AbortSignal.timeout(10_000),
          cache: "no-store",
        })
      } catch {
        throw new Error("Hermes dashboard login failed")
      }
      if (!response.ok) throw new Error("Hermes dashboard login failed")
      let result
      try { result = await response.json() } catch { throw new Error("Hermes dashboard login failed") }
      if (result?.ok !== true) throw new Error("Hermes dashboard login failed")
      let cookies = response.headers.getSetCookie?.() ?? []
      if (!cookies.length) {
        const combined = response.headers.get("set-cookie")
        if (combined) cookies = combined.split(/,(?=\s*[^;,=]+=[^;,]*)/)
      }
      cookieJar = cookies.map((cookie) => cookie.split(";", 1)[0]).filter(Boolean).join("; ")
      if (!cookieJar) throw new Error("Hermes dashboard did not issue a session")
      return cookieJar
    })()
    try { return await loginPromise } finally { loginPromise = null }
  }

  async function mintTicket() {
    if (!available) throw new Error("Hermes gateway is not configured")
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cookies = await loginDashboard()
      let response
      try {
        response = await fetchImpl(new URL("/api/auth/ws-ticket", dashboardBaseUrl), {
          method: "POST",
          headers: { cookie: cookies, accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
          cache: "no-store",
        })
      } catch {
        throw new Error("Hermes dashboard ticket request failed")
      }
      if (response.status === 401 && attempt === 0) {
        if (cookieJar === cookies) cookieJar = ""
        await loginDashboard()
        continue
      }
      if (!response.ok) throw new Error("Hermes dashboard ticket request failed")
      let result
      try { result = await response.json() } catch { throw new Error("Hermes dashboard ticket request failed") }
      if (typeof result?.ticket !== "string" || !result.ticket) throw new Error("Hermes dashboard ticket request failed")
      return result.ticket
    }
    throw new Error("Hermes dashboard ticket request failed")
  }

  async function openGateway() {
    const ticket = await mintTicket()
    const dashboard = new URL("/api/ws", dashboardBaseUrl)
    dashboard.protocol = dashboard.protocol === "https:" ? "wss:" : "ws:"
    const socket = wsConnectFactory(dashboard.href, ["hermes-gateway-v1", `hermes-gateway-ticket.${ticket}`])
    const bufferedMessages = []
    const bufferEarlyMessage = (data, isBinary) => bufferedMessages.push([data, isBinary])
    socket.on("message", bufferEarlyMessage)
    socket.gatewayBufferedMessages = bufferedMessages
    socket.gatewayBufferListener = bufferEarlyMessage
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onError = () => { cleanup(); reject(new Error("Hermes gateway connection failed")) }
      const cleanup = () => {
        clearTimeout(timer)
        socket.off("open", onOpen)
        socket.off("error", onError)
      }
      const timer = setTimeout(() => {
        cleanup()
        socket.terminate()
        reject(new Error("Hermes gateway connection timed out"))
      }, 10_000)
      socket.once("open", onOpen)
      socket.once("error", onError)
    })
    return socket
  }

  return { available, loginDashboard, mintTicket, openGateway }
}


function rejectUpgrade(socket, status, message) {
  const body = JSON.stringify({ error: message })
  socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 503 ? "Service Unavailable" : status === 504 ? "Gateway Timeout" : status === 404 ? "Not Found" : "Bad Gateway"}\r\n` +
    "Connection: close\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  socket.destroy()
}

export function createAppServer({
  distDir = path.join(ROOT, "dist"),
  uploadRoot = path.join(process.env.TMPDIR || "/opt/data/cache/scratch", "cortana-uploads"),
  fetchImpl = fetch,
  host = getListenHost(),
  accessUsername = process.env.CORTANA_ACCESS_USERNAME,
  accessPassword = process.env.CORTANA_ACCESS_PASSWORD,
  dashboardUrl = process.env.HERMES_DASHBOARD_URL || "http://127.0.0.1:9119",
  dashboardUsername = process.env.HERMES_DASHBOARD_USERNAME,
  dashboardPassword = process.env.HERMES_DASHBOARD_PASSWORD,
  wsConnectFactory = (url, protocols) => new WebSocket(url, protocols),
  gatewayConnectTimeoutMs = 15_000,
  gatewayPingIntervalMs = 25_000,
} = {}) {
  const requiresAuth = !isLoopbackHost(host)
  if (requiresAuth && (!accessUsername || !accessPassword)) {
    throw new Error("CORTANA_ACCESS_USERNAME and CORTANA_ACCESS_PASSWORD are required for non-loopback binds")
  }

  const gateway = createHermesGatewayBridge({
    dashboardUrl,
    username: dashboardUsername,
    password: dashboardPassword,
    fetchImpl,
    wsConnectFactory,
  })
  const gatewayWss = new WebSocketServer({ noServer: true })
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname
    if (requiresAuth) {
      if (!hasAccess(request, accessUsername, accessPassword)) {
        response.writeHead(401, {
          "www-authenticate": 'Basic realm="cortana-web", charset="UTF-8"',
          "cache-control": "no-store",
        }).end()
        return
      }
      // Remember the login so a reload (or a mobile browser that drops Basic credentials) does not
      // ask for the password again. Navigations and API calls slide the expiry; static assets skip
      // the extra Set-Cookie noise.
      const reissuesSession = !pathname.startsWith("/assets/") && pathname !== "/sw.js"
      if (reissuesSession) response.setHeader("set-cookie", sessionCookie(request, accessUsername, accessPassword))
    }
    if (pathname === "/api/uploads") {
      void receiveUpload(request, response, uploadRoot)
      return
    }
    if (pathname === "/api/gateway/status" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
      response.end(JSON.stringify({ available: gateway.available }))
      return
    }
    try {
      serveStatic(request, response, distDir)
    } catch {
      sendText(response, 400, "Invalid path")
    }
  })

  const shutdownPair = (browser, upstream, code = 1000, reason = "") => {
    for (const socket of [browser, upstream]) {
      if (!socket || socket.readyState === WebSocket.CLOSED) continue
      try {
        if (socket.readyState === WebSocket.OPEN) socket.close(code, reason)
        else socket.terminate()
      } catch { socket.terminate() }
    }
  }

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url, "http://localhost").pathname
    if (pathname !== "/api/gateway") {
      rejectUpgrade(socket, 404, "Not found")
      return
    }
    if (requiresAuth && !hasAccess(request, accessUsername, accessPassword)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="cortana-web", charset="UTF-8"\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (!sameOriginRequest(request, { allowAnyPath: true })) {
      rejectUpgrade(socket, 403, "Cross-origin WebSocket refused")
      return
    }
    if (!gateway.available) {
      rejectUpgrade(socket, 503, "Hermes gateway is not configured")
      return
    }

    let upstream
    let browser
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      shutdownPair(browser, upstream, 1011, "Gateway connection timed out")
      if (!browser && !socket.destroyed) rejectUpgrade(socket, 504, "Hermes gateway connection timed out")
    }, gatewayConnectTimeoutMs)
    void gateway.openGateway().then((connected) => {
      upstream = connected
      if (settled) {
        shutdownPair(null, upstream, 1011, "Gateway connection timed out")
        return
      }
      gatewayWss.handleUpgrade(request, socket, head, (accepted) => {
        browser = accepted
        settled = true
        clearTimeout(timer)
        const relay = (source, target) => source.on("message", (data, isBinary) => {
          if (target.readyState !== WebSocket.OPEN) return
          try { target.send(data, { binary: isBinary }) }
          catch { shutdownPair(browser, upstream, 1011, "Gateway relay failed") }
        })
        relay(browser, upstream)
        upstream.off("message", upstream.gatewayBufferListener)
        relay(upstream, browser)
        for (const [data, isBinary] of upstream.gatewayBufferedMessages) {
          if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: isBinary })
        }
        upstream.gatewayBufferedMessages.length = 0
        browser.on("close", (code, reason) => { clearInterval(pinger); shutdownPair(browser, upstream, code, reason.toString()) })
        upstream.on("close", (code, reason) => { clearInterval(pinger); shutdownPair(browser, upstream, code, reason.toString()) })
        browser.on("error", () => shutdownPair(browser, upstream, 1011, "Gateway transport error"))
        upstream.on("error", () => shutdownPair(browser, upstream, 1011, "Gateway transport error"))
        // Protocol-level ping keeps intermediaries (reverse proxy, mobile NAT) from silently
        // reclaiming an idle socket. Without it a backgrounded tab stays "open" client-side
        // while the connection is already gone, and every completion frame in between is lost.
        const pinger = setInterval(() => {
          let dead = false
          for (const socket of [browser, upstream]) {
            if (!socket || socket.readyState !== WebSocket.OPEN || socket.isAlive === false) { dead = true; break }
            socket.isAlive = false
          }
          if (dead) { shutdownPair(browser, upstream, 1011, "Gateway connection stale"); return }
          for (const socket of [browser, upstream]) {
            try { socket.ping() } catch { shutdownPair(browser, upstream, 1011, "Gateway ping failed") }
          }
        }, gatewayPingIntervalMs)
        for (const socket of [browser, upstream]) {
          socket.isAlive = true
          socket.on("pong", () => { socket.isAlive = true })
        }
      })
    }).catch(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      shutdownPair(browser, upstream, 1011, "Gateway connection failed")
      if (!socket.destroyed) rejectUpgrade(socket, 502, "Hermes gateway connection failed")
    })
  })

  return server
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000)
  const host = getListenHost()
  createAppServer({ host }).listen(port, host, () => {
    console.log(`cortana-web server listening on http://${host}:${port}`)
  })
}
