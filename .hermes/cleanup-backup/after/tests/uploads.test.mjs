import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createAppServer } from "../server.mjs"

async function withServer(options, run) {
  const server = createAppServer(options)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  try { await run(`http://127.0.0.1:${address.port}`) }
  finally {
    server.close()
    await once(server, "close")
  }
}

test("uploads preserve arbitrary binary bytes in a private opaque path and reject auth, origin, and size violations", async () => {
  const uploadRoot = await mkdtemp(path.join(tmpdir(), "cortana-uploads-test-"))
  const auth = `Basic ${Buffer.from("upload-user:upload-password").toString("base64")}`
  const credentials = { host: "0.0.0.0", accessUsername: "upload-user", accessPassword: "upload-password", uploadRoot }
  try {
    await withServer(credentials, async (base) => {
      const denied = await fetch(`${base}/api/uploads`, { method: "POST", body: new Uint8Array([1]) })
      assert.equal(denied.status, 401)
      const wrongOrigin = await fetch(`${base}/api/uploads`, {
        method: "POST", headers: { authorization: auth, origin: "https://attacker.example", "x-file-name": "any%2Ebin" }, body: new Uint8Array([1]),
      })
      assert.equal(wrongOrigin.status, 403)
      const headers = { authorization: auth, origin: base, "x-file-name": encodeURIComponent("arbitrary.payload") }
      const bytes = new Uint8Array([0, 255, 13, 10, 0, 128, 65])
      const response = await fetch(`${base}/api/uploads`, { method: "POST", headers, body: bytes })
      assert.equal(response.status, 201)
      assert.equal(response.headers.get("cache-control"), "no-store")
      const uploaded = await response.json()
      assert.equal(uploaded.name, "arbitrary.payload")
      assert.ok(path.isAbsolute(uploaded.path))
      assert.ok(uploaded.path.startsWith(uploadRoot + path.sep))
      assert.deepEqual(await readFile(uploaded.path), Buffer.from(bytes))
      assert.equal((await stat(path.dirname(uploaded.path))).mode & 0o777, 0o700)
      assert.equal((await stat(uploaded.path)).mode & 0o777, 0o600)
      assert.notEqual(path.basename(uploaded.path), uploaded.name)
      assert.notEqual((await fetch(`${base}${uploaded.path}`)).status, 200, "uploaded files must not be downloadable through static serving")

      const tooLarge = await fetch(`${base}/api/uploads`, {
        method: "POST", headers: { ...headers, "x-file-name": "large.bin" }, body: new Uint8Array(25 * 1024 * 1024 + 1),
      })
      assert.equal(tooLarge.status, 413)
      assert.match((await tooLarge.json()).error, /25 MiB/)
    })
  } finally {
    await rm(uploadRoot, { recursive: true, force: true })
  }
})
