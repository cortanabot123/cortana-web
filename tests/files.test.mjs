import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
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

test("agent files are served safely from configured roots", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "cortana-files-test-"))
  const fileRoot = path.join(parent, "allowed")
  const sibling = path.join(parent, "sibling")
  await mkdir(fileRoot)
  await mkdir(sibling)
  const imagePath = path.join(fileRoot, "pixel.png")
  const outsidePath = path.join(sibling, "secret.png")
  const bytes = Buffer.from([0, 255, 1, 2, 10, 128])
  const auth = `Basic ${Buffer.from("files-user:files-password").toString("base64")}`
  await writeFile(imagePath, bytes)
  await writeFile(outsidePath, Buffer.from("outside"))
  await writeFile(path.join(fileRoot, ".env"), "secret")
  await symlink(outsidePath, path.join(fileRoot, "escape.png"))

  try {
    await withServer({
      host: "0.0.0.0",
      accessUsername: "files-user",
      accessPassword: "files-password",
      fileRoots: [fileRoot],
    }, async (base) => {
      const urlFor = (requestedPath, options = "") => `${base}/api/files?path=${encodeURIComponent(requestedPath)}${options}`
      const unauthorized = await fetch(urlFor(imagePath))
      assert.equal(unauthorized.status, 401)

      const response = await fetch(urlFor(imagePath), { headers: { authorization: auth } })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get("content-type"), "image/png")
      assert.equal(response.headers.get("content-length"), String(bytes.length))
      assert.equal(response.headers.get("x-content-type-options"), "nosniff")
      assert.equal(response.headers.get("cache-control"), "private, max-age=300")
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)

      const download = await fetch(urlFor(imagePath, "&download=1"), { headers: { authorization: auth } })
      assert.equal(download.status, 200)
      assert.match(download.headers.get("content-disposition"), /^attachment; filename\*=UTF-8''pixel\.png$/)
      await download.arrayBuffer()

      const head = await fetch(urlFor(imagePath), { method: "HEAD", headers: { authorization: auth } })
      assert.equal(head.status, 200)
      assert.equal(await head.text(), "")
      for (const header of ["content-type", "content-length", "content-disposition", "x-content-type-options", "cache-control"]) {
        assert.equal(head.headers.get(header), response.headers.get(header), `HEAD ${header} must match GET`)
      }

      const outside = await fetch(urlFor(outsidePath), { headers: { authorization: auth } })
      assert.equal(outside.status, 403)
      const traversal = await fetch(urlFor(path.join(fileRoot, "..", "sibling", "secret.png")), { headers: { authorization: auth } })
      assert.ok([400, 403].includes(traversal.status))
      const dotfile = await fetch(urlFor(path.join(fileRoot, ".env")), { headers: { authorization: auth } })
      assert.equal(dotfile.status, 400)
      const missing = await fetch(urlFor(path.join(fileRoot, "missing.png")), { headers: { authorization: auth } })
      assert.equal(missing.status, 404)
      const symlinkEscape = await fetch(urlFor(path.join(fileRoot, "escape.png")), { headers: { authorization: auth } })
      assert.equal(symlinkEscape.status, 403)
      const notReadableSibling = await fetch(urlFor(path.join(sibling, "secret.png")), { headers: { authorization: auth } })
      assert.equal(notReadableSibling.status, 403)
      const wrongMethod = await fetch(urlFor(imagePath), { method: "POST", headers: { authorization: auth } })
      assert.equal(wrongMethod.status, 405)
    })
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
