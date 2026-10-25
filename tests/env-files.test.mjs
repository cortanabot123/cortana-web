import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))

function isIgnored(file) {
  const result = spawnSync("git", ["check-ignore", "--no-index", "--quiet", "--", file], {
    cwd: repositoryRoot,
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status === 0 || result.status === 1, true, result.stderr?.toString())
  return result.status === 0
}

test("secret environment files are ignored while .env.example remains trackable", () => {
  assert.equal(isIgnored(".env"), true, ".env should be ignored")
  assert.equal(isIgnored(".env.local"), true, ".env.local should be ignored")
  assert.equal(isIgnored(".env.example"), false, ".env.example should remain trackable")
})
