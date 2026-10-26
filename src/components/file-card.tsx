import { FileIcon } from "lucide-react"

import { agentFileUrl, fileNameOf, isAgentImagePath } from "@/lib/file-directives"

export function FileCard({ path: filePath }: { path: string }) {
  const name = fileNameOf(filePath)
  if (isAgentImagePath(filePath)) {
    const url = agentFileUrl(filePath)
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img
          data-slot="markdown-image"
          src={url}
          alt={name}
          loading="lazy"
          decoding="async"
          className="my-2 h-auto max-h-[60vh] w-auto max-w-full rounded-lg border border-border"
        />
      </a>
    )
  }

  return (
    <a
      data-slot="file-card"
      href={agentFileUrl(filePath, { download: true })}
      target="_blank"
      rel="noreferrer"
      className="my-2 flex max-w-full items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm hover:bg-muted/70"
    >
      <FileIcon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
      <span data-slot="file-card-name" className="min-w-0 truncate">{name}</span>
      <span className="shrink-0 text-muted-foreground">Download</span>
    </a>
  )
}
