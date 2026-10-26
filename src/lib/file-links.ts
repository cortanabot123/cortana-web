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

function rewriteLine(line: string): string {
  const wholeLine = MEDIA_LINE.exec(line.trim())
  if (wholeLine) {
    const markdown = mediaMarkdown(wholeLine[1])
    if (markdown) return markdown
  }
  return line.replace(/`?MEDIA:(\/[^\s`]+)`?/g, (match, rawPath: string) => mediaMarkdown(rawPath) ?? match)
}

/** A fence whose whole body is MEDIA tokens is a delivery wrapper, not a code sample. */
function rewriteFence(body: string): string | null {
  const lines = body.split("\n").filter((line) => line.trim())
  if (!lines.length || !lines.every((line) => MEDIA_LINE.test(line.trim()))) return null
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
  const rewritten = text.split(/(```[^\n]*\n[\s\S]*?```)/g).map((part) => {
    const fence = /^```([^\n]*)\n([\s\S]*?)```$/.exec(part)
    if (!fence) return part.split("\n").map(rewriteLine).join("\n")
    const body = rewriteFence(fence[2])
    return body === null ? part : `\`\`\`${fence[1]}\n${body}\n\`\`\``
  }).join("")
  return rewriteLocalImage(rewritten)
}
