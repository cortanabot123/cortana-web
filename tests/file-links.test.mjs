import assert from "node:assert/strict"
import test from "node:test"
import { agentFileUrl, isAgentImagePath, rewriteAgentMedia } from "../src/lib/file-links.ts"

const url = (p, download = false) => `/api/files?path=${encodeURIComponent(p)}${download ? "&download=1" : ""}`

test("MEDIA tokens become inline images for every image extension, including svg", () => {
  for (const ext of ["png", "svg", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]) {
    const file = `/opt/data/workspace/probe.${ext}`
    assert.equal(rewriteAgentMedia(`MEDIA:${file}`), `![probe.${ext}](<${url(file)}>)`, ext)
    assert.equal(isAgentImagePath(file), true, ext)
  }
  assert.equal(rewriteAgentMedia("MEDIA:/opt/data/workspace/PROBE.PNG"), `![PROBE.PNG](<${url("/opt/data/workspace/PROBE.PNG")}>)`)
})

test("formats outside the image set still render as download links instead of raw text", () => {
  for (const ext of ["tif", "tiff", "heic", "dwg", "dxf", "doc", "xls", "rar", "7z", "mov", "pdf", "zip"]) {
    const file = `/opt/data/workspace/probe.${ext}`
    const rendered = rewriteAgentMedia(`MEDIA:${file}`)
    assert.equal(rendered, `[probe.${ext}](<${url(file, true)}>)`, ext)
    assert.doesNotMatch(rendered, /MEDIA:/, ext)
    assert.equal(isAgentImagePath(file), false, ext)
  }
})

test("backticked, fenced and prose-delivered MEDIA tokens all resolve", () => {
  const file = "/opt/data/workspace/probe.svg"
  const image = `![probe.svg](<${url(file)}>)`
  assert.equal(rewriteAgentMedia(`\`MEDIA:${file}\``), image)
  assert.equal(rewriteAgentMedia(`\`\`\`\nMEDIA:${file}\n\`\`\``), "```\n" + image + "\n```")
  assert.equal(rewriteAgentMedia(`画好了：\nMEDIA:${file}\n`), `画好了：\n${image}\n`)
  assert.equal(rewriteAgentMedia(`MEDIA:${file}.`), image, "trailing sentence period is stripped")
  assert.equal(rewriteAgentMedia(`MEDIA:${file})`), image, "trailing bracket is stripped")
})

test("code samples, partial tokens and repeated rewrites stay untouched", () => {
  const sample = "```bash\nMEDIA:/opt/data/workspace/probe.png\necho done\n```"
  assert.equal(rewriteAgentMedia(sample), sample, "a fence that is not a pure MEDIA wrapper is code")
  assert.equal(rewriteAgentMedia("MEDIA:/opt/da"), "MEDIA:/opt/da", "a streaming partial path is not rewritten")
  assert.equal(rewriteAgentMedia("MEDIA:/opt/data/workspace"), "MEDIA:/opt/data/workspace", "a directory has no extension")
  assert.equal(rewriteAgentMedia("我在 /opt/data/workspace/probe.svg 里画了"), "我在 /opt/data/workspace/probe.svg 里画了", "a bare path in prose is not a delivery token")
  const once = rewriteAgentMedia("MEDIA:/opt/data/workspace/probe.svg")
  assert.equal(rewriteAgentMedia(once), once, "rewriting is idempotent")
})

test("markdown image destinations pointing at local files are routed through the file API", () => {
  const file = "/opt/data/workspace/probe.tif"
  assert.equal(rewriteAgentMedia(`![plan](${file})`), `![plan](<${url(file)}>)`)
  const remote = "![remote](https://example.com/a.png)"
  assert.equal(rewriteAgentMedia(remote), remote, "remote images are left alone")
  assert.equal(agentFileUrl(file), url(file))
})
