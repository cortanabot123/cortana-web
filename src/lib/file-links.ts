const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp"]
const OTHER_AGENT_EXTENSIONS = [".pdf", ".csv", ".md", ".json", ".zip", ".docx", ".xlsx", ".pptx", ".dxf", ".txt", ".mp4", ".webm", ".mp3", ".wav"]
const KNOWN_AGENT_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...OTHER_AGENT_EXTENSIONS])

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

function rewriteLocalImage(markdown: string): string {
  return markdown.replace(/(!\[([^\]]*)\]\()(\/[^)\s]+)(\))/g, (match, prefix: string, _alt: string, localPath: string, suffix: string) => {
    if (localPath.startsWith("/api/files?path=") || !KNOWN_AGENT_EXTENSIONS.has(extensionOf(localPath))) return match
    return `${prefix}<${agentFileUrl(localPath)}>${suffix}`
  })
}

export function rewriteAgentMedia(text: string): string {
  const mediaRewritten = text.replace(/MEDIA:(\/[^\s]*)/g, (match, rawPath: string) => {
    const filePath = rawPath.replace(/[)\],"']+$/, "").replace(/\.+$/, "")
    if (!filePath || !KNOWN_AGENT_EXTENSIONS.has(extensionOf(filePath))) return match
    const basename = filePath.slice(filePath.lastIndexOf("/") + 1)
    const url = agentFileUrl(filePath, { download: !isAgentImagePath(filePath) })
    return isAgentImagePath(filePath) ? `![${basename}](<${url}>)` : `[${basename}](<${url}>)`
  })
  return rewriteLocalImage(mediaRewritten)
}
