export const FILE_DIRECTIVE_RE = /`?::file\s*\{\s*path\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)')\s*\}`?/

const PURE_DIRECTIVE_RE = new RegExp(`^\\s*${FILE_DIRECTIVE_RE.source}\\s*$`)

export function parseFileDirective(raw: string): { path: string } | null {
  const match = PURE_DIRECTIVE_RE.exec(raw)
  if (!match) return null
  return { path: match[1] ?? match[2] ?? "" }
}

export function agentFileUrl(absolutePath: string, options: { download?: boolean } = {}): string {
  return `/api/files?path=${encodeURIComponent(absolutePath)}${options.download ? "&download=1" : ""}`
}

export const AGENT_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"])

export function isAgentImagePath(p: string): boolean {
  const extension = p.split(/[?#]/, 1)[0].split(".").at(-1)?.toLowerCase()
  return extension !== undefined && AGENT_IMAGE_EXTENSIONS.has(extension)
}

export function extractFileDirectives(text: string): { path: string }[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  const directives = lines.map(parseFileDirective)
  return directives.length > 0 && directives.every((directive) => directive !== null)
    ? directives.filter((directive): directive is { path: string } => directive !== null)
    : []
}

export function stripFileDirectives(text: string): string {
  const directivePattern = new RegExp(FILE_DIRECTIVE_RE.source, "g")
  return text.split(/(\r?\n)/).map((part, index) => {
    if (index % 2 === 1) return part
    if (parseFileDirective(part)) return ""
    return part.replace(directivePattern, "")
  }).join("")
}

export function fileNameOf(p: string): string {
  return p.split(/[\\/]/).at(-1) ?? ""
}
