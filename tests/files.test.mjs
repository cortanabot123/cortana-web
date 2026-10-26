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

test("agent files are served only from allowed roots with safe headers and methods", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "cortana-files-test-"))
  const root = path.join(tempRoot, "root")
  const sibling = path.join(tempRoot, "sibling")
  const uploadRoot = path.join(tempRoot, "uploads")
  const auth = `Basic ${Buffer.from("files-user:files-password").toString("base64")}`
  const headers = { authorization: auth }
  const pngBytes = Buffer.from([0, 1, 2, 255, 137, 80, 78, 71])
  try {
    await mkdir(root)
    await mkdir(sibling)
    const imagePath = path.join(root, "probe.png")
    const outsidePath = path.join(sibling, "outside.png")
    await writeFile(imagePath, pngBytes)
    await writeFile(outsidePath, pngBytes)
    await writeFile(path.join(root, ".secret"), "hidden")
    await mkdir(path.join(root, "folder"))
    await symlink(outsidePath, path.join(root, "escape.png"))

    await withServer({ host: "0.0.0.0", accessUsername: "files-user", accessPassword: "files-password", fileRoots: [root], uploadRoot }, async (base) => {
      const urlFor = (filePath, suffix = "") => `${base}/api/files?path=${encodeURIComponent(filePath)}${suffix}`
      const denied = await fetch(urlFor(imagePath))
      assert.equal(denied.status, 401, "non-loopback hosts must protect file delivery")

      const response = await fetch(urlFor(imagePath), { headers })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get("content-type"), "image/png")
      assert.equal(response.headers.get("content-length"), String(pngBytes.length))
      assert.equal(response.headers.get("x-content-type-options"), "nosniff")
      assert.equal(response.headers.get("cache-control"), "private, max-age=300")
      assert.equal(response.headers.get("content-disposition"), null)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), pngBytes)

      const download = await fetch(urlFor(imagePath, "&download=1"), { headers })
      assert.equal(download.status, 200)
      assert.match(download.headers.get("content-disposition"), /^attachment; filename\*=UTF-8''probe\.png$/)
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), pngBytes)

      const head = await fetch(urlFor(imagePath), { method: "HEAD", headers })
      assert.equal(head.status, response.status)
      for (const name of ["content-type", "content-length", "content-disposition", "x-content-type-options", "cache-control"]) {
        assert.equal(head.headers.get(name), response.headers.get(name))
      }
      assert.equal(await head.text(), "")

      const notInline = await fetch(urlFor(path.join(root, "report.docx")), { headers })
      assert.equal(notInline.status, 404)
      await writeFile(path.join(root, "report.docx"), "document")
      const attachment = await fetch(urlFor(path.join(root, "report.docx")), { headers })
      assert.equal(attachment.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      assert.match(attachment.headers.get("content-disposition"), /^attachment;/)
      await attachment.arrayBuffer()

      for (const [filePath, status] of [
        ["", 400],
        ["relative.png", 400],
        [`${path.join(root, "invalid")}${String.fromCharCode(0)}.png`, 400],
        [`${root}${path.sep}..${path.sep}sibling${path.sep}outside.png`, 400],
        [path.join(root, ".secret"), 400],
        [path.join(root, "missing.png"), 404],
        [path.join(root, "folder"), 404],
        [path.join(root, "escape.png"), 403],
        [outsidePath, 403],
        [tempRoot, 403],
      ]) {
        const result = await fetch(urlFor(filePath), { headers })
        assert.equal(result.status, status, `${filePath} should return ${status}`)
        assert.match(result.headers.get("content-type"), /application\/json/)
        await result.json()
      }

      const wrongMethod = await fetch(`${base}/api/files`, { method: "POST", headers })
      assert.equal(wrongMethod.status, 405)
      assert.match(wrongMethod.headers.get("content-type"), /application\/json/)
      await wrongMethod.json()
    })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
