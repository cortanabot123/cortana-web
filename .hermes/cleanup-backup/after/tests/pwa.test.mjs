import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (file) => readFile(new URL(file, import.meta.url), "utf8")

test("project and PWA metadata use the cortana-web slug", async () => {
  const manifest = JSON.parse(await read("../public/manifest.webmanifest"))
  const html = await read("../index.html")
  const packageJson = JSON.parse(await read("../package.json"))
  const viteConfig = await read("../vite.config.ts")
  assert.equal(packageJson.name, "cortana-web")
  assert.match(html, /<title>cortana-web<\/title>/)
  assert.equal(manifest.name, "cortana-web")
  assert.equal(manifest.short_name, "cortana-web")
  assert.match(viteConfig, /name: "cortana-web-app-shell-service-worker"/)
})

test("PWA manifest declares a standalone cortana-web app with install icons", async () => {
  const manifest = JSON.parse(await read("../public/manifest.webmanifest"))
  assert.equal(manifest.name, "cortana-web")
  assert.equal(manifest.display, "standalone")
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"))
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"))
  assert.equal(manifest.start_url, "/")
})

test("PWA registers a service worker and caches only built app-shell resources", async () => {
  const entry = await read("../src/main.tsx")
  const config = await read("../vite.config.ts")
  assert.match(entry, /serviceWorker\.register/)
  assert.match(config, /service-worker\.js|sw\.js/)
  const app = await read("../src/App.tsx")
  const chat = await read("../src/components/chat.tsx")
  assert.match(app, /data-build=\{__CORTANA_BUILD_ID__\}/)
  assert.match(chat, /build \{__CORTANA_BUILD_ID__\}/)
  assert.match(chat, /foundRegistration\.addEventListener\("updatefound"/)
  assert.match(chat, /addEventListener\("controllerchange"/)
  assert.match(chat, /New version available —/)
  assert.match(chat, /disabled=\{busy\}/)
  assert.match(chat, /if \(!reloadRequested \|\| !updatedWorkerActive \|\| busy\) return/)
  assert.match(chat, /setUpdateDismissed\(true\)/)
  const worker = await read("../src/pwa/sw.js")
  assert.match(worker, /const CACHE_NAME = "cortana-web-shell-__CORTANA_BUILD_ID__"/)
  assert.match(config, /__CORTANA_BUILD_ID__: JSON\.stringify\(buildId\)/)
  assert.match(config, /replaceAll\("__CORTANA_BUILD_ID__", buildId\)/)
  assert.match(config, /cortana-build/)
  assert.match(worker, /key\.startsWith\("cortana-web-shell-"\)/)
  assert.match(worker, /key\.startsWith\("cortana-shell-"\)/)
  assert.match(worker, /install/)
  assert.match(worker, /then\(\(\) => self\.skipWaiting\(\)\)/)
  assert.match(worker, /then\(\(\) => self\.clients\.claim\(\)\)/)
  assert.match(worker, /event\.data\?\.type !== "SKIP_WAITING"/)
  assert.match(worker, /\/api\//)
  assert.match(worker, /caches\.open/)
  assert.match(worker, /cache\.match\(request\)/)
  assert.doesNotMatch(worker, /caches\.match\(/)
  assert.doesNotMatch(worker, /cache\.put\s*\(/)
  assert.doesNotMatch(worker, /\.add\s*\(request\)/)


  for (const size of [192, 512]) {
    const icon = await readFile(new URL(`../public/icons/icon-${size}.png`, import.meta.url))
    assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
    assert.equal(icon.readUInt32BE(16), size)
    assert.equal(icon.readUInt32BE(20), size)
  }
})
