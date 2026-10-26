const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp"]
const FILE_EXTENSION = /\.[a-z0-9]{1,6}$/i
const MEDIA_LINE = /^`?MEDIA:(\/.+?)`?$/

export const AGENT_IMAGE_EXTENSIONS: Set<string> = new Set(IMAGE_EXTENSIONS)

export function agentFileUrl(absolutePath: string, options?: { download?: boolean }): string {
  const download = options?.download ? "&download=1" : ""
  return `/api/files?path=${encodeURIComponent(absolutePath)}${download}`
}

function extensionOf(filePath: string): string {
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1)
  const dot = basename.lastIndexOf(".")
  return dot < 0 ? "" : basename.slice(dot).toLowerCase()
}

export function isAgentImagePath(p: string): boolean {
  return AGENT_IMAGE_EXTENSIONS.has(extensionOf(p))
}

/** Trailing punctuation a path picks up from prose: `)` `]` `,` `"` `'` and sentence periods. */
function cleanPath(rawPath: string): string {
  return rawPath.replace(/[)\],"'`]+$/, "").replace(/\.+$/, "")
}

/**
 * An absolute path written straight into prose (`给你一张图：/opt/data/workspace/x.svg`), which is how
 * the agent reports files far more often than it emits a `MEDIA:` token. Latin, CJK and dashes only:
 * a space or CJK punctuation ends the match, so a sentence never swallows its neighbours.
 */
const BARE_PATH = /(?<![\w/])(\/(?:[\w\u4e00-\u9fff.-]+\/)*[\w\u4e00-\u9fff.-]+\.[a-z0-9]{1,6})(?![\w])/g

/**
 * Renders one agent-supplied path as markdown, or null when the token is not a file yet.
 * Any extension counts as a file (new CAD/Office/image formats outpace a whitelist); only the
 * image set renders inline, everything else becomes a download link.
 */
function mediaMarkdown(rawPath: string): string | null {
  const filePath = cleanPath(rawPath)
  if (!filePath || !FILE_EXTENSION.test(filePath)) return null
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1)
  const url = agentFileUrl(filePath, { download: !isAgentImagePath(filePath) })
  return isAgentImagePath(filePath) ? `![${basename}](<${url}>)` : `[${basename}](<${url}>)`
}

function rewriteBarePaths(line: string): string {
  return line.split(/(`[^`\n]*`)/).map((part) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      // A code span that holds nothing but an absolute path is how the agent usually quotes a file;
      // render it, but keep spans that carry anything else (`open('/x.png')`) as literal code.
      const inner = part.slice(1, -1).trim()
      return /^\/[^\s`]+$/.test(inner) ? mediaMarkdown(inner) ?? part : part
    }
    return part.replace(BARE_PATH, (match, rawPath: string) => {
      if (rawPath.startsWith("/api/files")) return match
      return mediaMarkdown(rawPath) ?? match
    })
  }).join("")
}

function rewriteLine(line: string): string {
  const trimmed = line.trim()
  const wholeLine = MEDIA_LINE.exec(trimmed)
  if (wholeLine) {
    const markdown = mediaMarkdown(wholeLine[1])
    if (markdown) return markdown
  }
  const wholePath = /^`?(\/[^\s`]+?)`?$/.exec(trimmed)
  if (wholePath) {
    const markdown = mediaMarkdown(wholePath[1])
    if (markdown) return markdown
  }
  const tokenRewritten = line.replace(/`?MEDIA:(\/[^\s`]+)`?/g, (match, rawPath: string) => mediaMarkdown(rawPath) ?? match)
  return rewriteBarePaths(tokenRewritten)
}

/** A fence whose whole body is MEDIA tokens or bare paths is a delivery wrapper, not a code sample. */
function rewriteFence(body: string): string | null {
  const lines = body.split("\n").filter((line) => line.trim())
  const isDelivery = (line: string) => {
    const content = line.trim().replace(/^`|`$/g, "")
    return MEDIA_LINE.test(content) || (/^\/[^\s`]+$/.test(content) && FILE_EXTENSION.test(content))
  }
  if (!lines.length || !lines.every(isDelivery)) return null
  return lines.map(rewriteLine).join("\n")
}

function rewriteLocalImage(markdown: string): string {
  return markdown.replace(/(!\[([^\]]*)\]\(<?)(\/[^)\s>]+)/g, (match, prefix: string, _alt: string, localPath: string) => {
    if (localPath.startsWith("/api/files?path=") || !FILE_EXTENSION.test(localPath)) return match
    return `${prefix}<${agentFileUrl(localPath)}>`
  })
}

export function rewriteAgentMedia(text: string): string {
  // Split on fenced code blocks: prose is rewritten freely, a fence only when its whole body is
  // MEDIA tokens, so real code samples keep their literal text.
  return text.split(/(```[^\n]*\n[\s\S]*?```)/g).map((part) => {
    const fence = /^```([^\n]*)\n([\s\S]*?)```$/.exec(part)
    if (!fence) {
      // Local markdown image destinations first, so the prose pass below cannot nest a link inside
      // an image destination (`![a](/abs/x.png)` must become one image, not `![a]([x.png](…))`).
      return rewriteLocalImage(part).split("\n").map(rewriteLine).join("\n")
    }
    const body = rewriteFence(fence[2])
    return body === null ? part : `\`\`\`${fence[1]}\n${body}\n\`\`\``
  }).join("")
}
