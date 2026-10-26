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

test("bare absolute paths in prose render too, which is how the agent usually reports files", () => {
  const image = "/opt/data/workspace/随手一张.svg"
  assert.equal(
    rewriteAgentMedia(`给你一张日落风景图：${image}`),
    `给你一张日落风景图：![随手一张.svg](<${url(image)}>)`,
  )
  assert.equal(
    rewriteAgentMedia(`再给你一张山间清晨图：/opt/data/workspace/山间清晨.svg`),
    `再给你一张山间清晨图：![山间清晨.svg](<${url("/opt/data/workspace/山间清晨.svg")}>)`,
  )
  const sheet = "/opt/data/workspace/2221_facade.dxf"
  assert.equal(rewriteAgentMedia(`图纸在这里 ${sheet}`), `图纸在这里 [2221_facade.dxf](<${url(sheet, true)}>)`)
  assert.equal(rewriteAgentMedia(`图：/opt/data/workspace/a.svg。好看`), `图：![a.svg](<${url("/opt/data/workspace/a.svg")}>)` + "。好看", "CJK punctuation ends the path")
  assert.equal(rewriteAgentMedia("见 `" + image + "` 这个文件"), "见 ![随手一张.svg](<" + url(image) + ">) 这个文件", "a code span holding one path renders")
  assert.equal(rewriteAgentMedia("`open('/opt/data/workspace/x.png')`"), "`open('/opt/data/workspace/x.png')`", "a code span holding code stays literal")
  assert.equal(rewriteAgentMedia("```\n" + image + "\n```"), "```\n![随手一张.svg](<" + url(image) + ">)\n```", "a fence holding one path is a delivery wrapper")
  assert.equal(rewriteAgentMedia("![remote](https://example.com/a.png)"), "![remote](https://example.com/a.png)", "remote URLs are never touched")
})

test("code samples, partial tokens and repeated rewrites stay untouched", () => {
  const sample = "```bash\nMEDIA:/opt/data/workspace/probe.png\necho done\n```"
  assert.equal(rewriteAgentMedia(sample), sample, "a fence that is not a pure MEDIA wrapper is code")
  assert.equal(rewriteAgentMedia("```python\nopen('/opt/data/workspace/x.png')\n```"), "```python\nopen('/opt/data/workspace/x.png')\n```", "paths inside a real code fence are code")
  assert.equal(rewriteAgentMedia("MEDIA:/opt/da"), "MEDIA:/opt/da", "a streaming partial path is not rewritten")
  assert.equal(rewriteAgentMedia("MEDIA:/opt/data/workspace"), "MEDIA:/opt/data/workspace", "a directory has no extension")
  const once = rewriteAgentMedia("MEDIA:/opt/data/workspace/probe.svg")
  assert.equal(rewriteAgentMedia(once), once, "rewriting is idempotent")
  const bare = rewriteAgentMedia("图：/opt/data/workspace/probe.svg")
  assert.equal(rewriteAgentMedia(bare), bare, "bare-path rewriting is idempotent")
})

test("markdown image destinations pointing at local files are routed through the file API", () => {
  const file = "/opt/data/workspace/probe.tif"
  assert.equal(rewriteAgentMedia(`![plan](${file})`), `![plan](<${url(file)}>)`)
  const remote = "![remote](https://example.com/a.png)"
  assert.equal(rewriteAgentMedia(remote), remote, "remote images are left alone")
  assert.equal(agentFileUrl(file), url(file))
})
