/**
 * Real-browser check of the deployed picker: signs in with the Cortana credentials and asserts the
 * reasoning control renders in the composer against the live gateway. Screenshots the composer.
 */
import { chromium } from "playwright-core"

const base = process.env.CORTANA_BASE_URL || "http://127.0.0.1:3000"
const username = process.env.CORTANA_ACCESS_USERNAME
const password = process.env.CORTANA_ACCESS_PASSWORD

const browser = await chromium.launch({
  headless: true,
  executablePath: "/opt/hermes/tools/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  httpCredentials: username && password ? { username, password } : undefined,
})
const page = await context.newPage()
const failures = []
try {
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 })
  const trigger = page.getByRole("button", { name: /^Reasoning: / })
  await trigger.waitFor({ timeout: 30_000 })
  const label = await trigger.getAttribute("aria-label")
  console.log("live trigger:", label)

  const controls = await page.locator("[data-chat-composer] button").evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute("aria-label")).filter(Boolean),
  )
  console.log("composer controls:", JSON.stringify(controls))
  if (JSON.stringify(controls).includes("Reasoning: ") === false) failures.push("reasoning control missing")

  await trigger.click()
  const levels = await page.locator('[role="menuitemradio"]').allInnerTexts()
  console.log("levels:", JSON.stringify(levels.map((text) => text.replace(/\s+/g, " ").trim())))
  console.log("global action count:", await page.getByRole("menuitem", { name: "Set as global default" }).count())

  await page.screenshot({ path: "/opt/data/cache/scratch/cortana-reasoning-menu.png" })
  // Close the menu and shoot the plain composer for visual review.
  await page.keyboard.press("Escape")
  await page.locator("[data-chat-composer]").screenshot({ path: "/opt/data/cache/scratch/cortana-reasoning-composer.png" })
  console.log("screenshots written")
} catch (error) {
  failures.push(error.message)
} finally {
  await browser.close()
}
if (failures.length) {
  console.error("FAILED:", failures.join("; "))
  process.exit(1)
}
console.log("OK")
