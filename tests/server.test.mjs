import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createAppServer, createSessionToken, getListenHost, isValidSessionToken } from "../server.mjs"

test("defaults the server bind address to loopback without opening a wildcard listener", () => {
  assert.equal(getListenHost({}), "127.0.0.1")
  assert.equal(getListenHost({ HOST: "0.0.0.0" }), "0.0.0.0")
})

test("refuses non-loopback server configuration unless both access credentials are set", () => {
  assert.throws(() => createAppServer({ host: "0.0.0.0", accessUsername: "user", accessPassword: "" }), /CORTANA_ACCESS_USERNAME and CORTANA_ACCESS_PASSWORD/)
  assert.throws(() => createAppServer({ host: "0.0.0.0", accessUsername: "", accessPassword: "pass" }), /CORTANA_ACCESS_USERNAME and CORTANA_ACCESS_PASSWORD/)
})

async function withServer(options, run) {
  const server = createAppServer(options)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    server.close()
    await once(server, "close")
  }
}

test("reports gateway availability without exposing dashboard credentials", async () => {
  await withServer({ dashboardUsername: "gateway-user", dashboardPassword: "gateway-password" }, async (base) => {
    const response = await fetch(`${base}/api/gateway/status`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { available: true })
    assert.equal(response.headers.get("cache-control"), "no-store")
  })
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/api/gateway/status`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { available: false })
  })
})

test("requires Basic auth for static assets and gateway status on non-loopback configurations", async () => {
  const credentials = { host: "0.0.0.0", accessUsername: "cortana-user", accessPassword: "private-pass" }
  await withServer(credentials, async (base) => {
    for (const pathname of ["/", "/api/gateway/status"]) {
      const response = await fetch(`${base}${pathname}`)
      assert.equal(response.status, 401)
      assert.equal(response.headers.get("www-authenticate"), 'Basic realm="cortana-web", charset="UTF-8"')
      assert.doesNotMatch(await response.text(), /cortana-user|private-pass/)
    }
    const invalid = await fetch(`${base}/`, {
      headers: { authorization: `Basic ${Buffer.from("cortana-user:wrong-pass").toString("base64")}` },
    })
    assert.equal(invalid.status, 401)

    const authorization = `Basic ${Buffer.from("cortana-user:private-pass").toString("base64")}`
    const staticResponse = await fetch(`${base}/`, { headers: { authorization } })
    assert.equal(staticResponse.status, 200)
    assert.match(await staticResponse.text(), /html/i)
    const status = await fetch(`${base}/api/gateway/status`, { headers: { authorization } })
    assert.equal(status.status, 200)
  })
})

test("a Basic login issues a session cookie that survives reloads, and forged cookies are refused", async () => {
  const credentials = { host: "0.0.0.0", accessUsername: "cortana-user", accessPassword: "private-pass" }
  const authorization = `Basic ${Buffer.from("cortana-user:private-pass").toString("base64")}`
  await withServer(credentials, async (base) => {
    // First load: the browser prompts once and the server hands back a remember-me cookie.
    const login = await fetch(`${base}/`, { headers: { authorization } })
    assert.equal(login.status, 200)
    const setCookie = login.headers.getSetCookie?.()[0] ?? login.headers.get("set-cookie")
    assert.match(setCookie, /^cortana_session=[^;]+/)
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /Max-Age=2592000/)
    assert.match(setCookie, /SameSite=Lax/)
    assert.doesNotMatch(setCookie, /private-pass/)
    const session = setCookie.split(";")[0]

    // Reload with only the cookie: no Authorization header, still authorised.
    for (const pathname of ["/", "/api/gateway/status"]) {
      const reload = await fetch(`${base}${pathname}`, { headers: { cookie: session } })
      assert.equal(reload.status, 200, `${pathname} should accept the session cookie`)
    }
    const sliding = await fetch(`${base}/`, { headers: { cookie: session } })
    assert.match(sliding.headers.get("set-cookie"), /^cortana_session=/, "the cookie should be refreshed on navigation")

    // Tampered signature, wrong key and anonymous access all fail closed.
    const [name, value] = session.split("=")
    for (const cookie of [`${name}=${value}x`, `${name}=`, `other=${value}`]) {
      const forged = await fetch(`${base}/`, { headers: { cookie } })
      assert.equal(forged.status, 401, `cookie ${cookie} must not authenticate`)
    }
    assert.equal((await fetch(`${base}/`)).status, 401)
  })
})

test("session tokens expire and stay bound to the configured credentials", () => {
  const issued = createSessionToken("cortana-user", "private-pass", 0)
  assert.equal(isValidSessionToken(issued, "cortana-user", "private-pass", 1000), true)
  // 31 days later the token is dead.
  assert.equal(isValidSessionToken(issued, "cortana-user", "private-pass", 31 * 24 * 60 * 60 * 1000), false)
  // A password rotation invalidates outstanding sessions.
  assert.equal(isValidSessionToken(issued, "cortana-user", "other-pass", 1000), false)
  assert.equal(isValidSessionToken(issued, "other-user", "private-pass", 1000), false)
  assert.equal(isValidSessionToken("", "cortana-user", "private-pass", 1000), false)
  assert.equal(isValidSessionToken(undefined, "cortana-user", "private-pass", 1000), false)
})

test("serves dist files and falls back to the app shell", async () => {
  const distDir = await mkdtemp(path.join(tmpdir(), "cortana-web-dist-"))
  await writeFile(path.join(distDir, "index.html"), "<main>shell</main>")
  try {
    await withServer({ distDir }, async (base) => {
      assert.equal(await (await fetch(`${base}/`)).text(), "<main>shell</main>")
      assert.equal(await (await fetch(`${base}/thread`)).text(), "<main>shell</main>")
    })
  } finally {
    await rm(distDir, { recursive: true, force: true })
  }
})
