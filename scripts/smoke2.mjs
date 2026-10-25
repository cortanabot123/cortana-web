import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const worker = await readFile("dist/sw.js", "utf8")
const shell = worker.match(/const SHELL_ASSETS = (\[[^;]+\])/)
assert.ok(shell, "service worker must contain a generated shell asset list")
const assets = JSON.parse(shell[1])
assert.ok(assets.includes("/index.html"))
assert.ok(assets.some((asset) => asset.endsWith(".js")))
assert.ok(assets.some((asset) => asset.endsWith(".css")))
assert.ok(assets.includes("/manifest.webmanifest"))
assert.ok(assets.every((asset) => !asset.startsWith("/api/")))
assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/)
assert.doesNotMatch(worker, /cache\.put\s*\(/)
console.log("PWA smoke test passed (installable shell precache; no API/runtime caching).")
