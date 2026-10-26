import assert from "node:assert/strict"
import test from "node:test"
import {
  agentFileUrl,
  extractFileDirectives,
  fileNameOf,
  isAgentImagePath,
  parseFileDirective,
  stripFileDirectives,
} from "../src/lib/file-directives.ts"

test("file directives parse quoted paths, optional backticks, and surrounding whitespace", () => {
  assert.deepEqual(parseFileDirective('::file{path="/opt/data/workspace/a b.png"}'), { path: "/opt/data/workspace/a b.png" })
  assert.deepEqual(parseFileDirective("  `::file{ path = '/opt/data/report.docx' }`  "), { path: "/opt/data/report.docx" })
  assert.equal(parseFileDirective('::file{path="/opt/data/a.png"} trailing text'), null)
  assert.deepEqual(extractFileDirectives('\n::file{path="/tmp/one.png"}\n`::file{path=\'/tmp/two.pdf\'}`\n'), [
    { path: "/tmp/one.png" },
    { path: "/tmp/two.pdf" },
  ])
  assert.deepEqual(extractFileDirectives('ordinary prose\n::file{path="/tmp/a.png"}'), [])
})

test("file URLs encode absolute paths and preserve download mode", () => {
  assert.equal(agentFileUrl("/opt/data/a file#1.png"), "/api/files?path=%2Fopt%2Fdata%2Fa%20file%231.png")
  assert.equal(agentFileUrl("/opt/data/report.docx", { download: true }), "/api/files?path=%2Fopt%2Fdata%2Freport.docx&download=1")
})

test("agent image detection is extension-based and case-insensitive", () => {
  assert.equal(isAgentImagePath("/tmp/image.PNG"), true)
  assert.equal(isAgentImagePath("/tmp/image.svg"), true)
  assert.equal(isAgentImagePath("/tmp/report.docx"), false)
  assert.equal(fileNameOf("/opt/data/report.docx"), "report.docx")
})

test("directive stripping preserves prose and does not consume incomplete streaming markers", () => {
  assert.equal(stripFileDirectives("Plain prose stays exactly as written."), "Plain prose stays exactly as written.")
  assert.equal(stripFileDirectives('Created it: ::file{path="/opt/data/a.png"} successfully'), "Created it:  successfully")
  assert.equal(stripFileDirectives('Still streaming ::file{path="/opt/da'), 'Still streaming ::file{path="/opt/da')
  assert.equal(stripFileDirectives('before\n::file{path="/tmp/a.png"}\nafter'), "before\n\nafter")
})
