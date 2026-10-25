import assert from "node:assert/strict"
import { once } from "node:events"
import { createAppServer } from "../server.mjs"

const server = createAppServer()
server.listen(0, "127.0.0.1")
await once(server, "listening")
const address = server.address()
const base = `http://127.0.0.1:${address.port}`
try {
  const page = await fetch(base)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /cortana-web/)
  const manifest = await fetch(`${base}/manifest.webmanifest`)
  assert.equal(manifest.status, 200)
  const status = await fetch(`${base}/api/gateway/status`)
  assert.equal(status.status, 200)
  assert.deepEqual(await status.json(), { available: false })
  console.log("Production server smoke test passed (static app + gateway status).")
} finally {
  server.close()
  await once(server, "close")
}
