import * as React from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"

import { FileCard } from "@/components/file-card"
import { CodeBlock, CodeBlockContent, CodeBlockLine } from "@/components/ui/code-block"
import { useHighlightedCode } from "@/hooks/use-highlighted-code"
import { parseFileDirective, stripFileDirectives } from "@/lib/file-directives"
import { cn } from "cn"

/** Flattens react-markdown children into the plain text of a code fence. */
function toText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return ""
  }

  if (typeof node === "string" || typeof node === "number") {
    return String(node)
  }

  if (Array.isArray(node)) {
    return node.map(toText).join("")
  }

  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return toText(node.props.children)
  }

  return ""
}

function findCodeLanguage(node: React.ReactNode): string {
  if (Array.isArray(node)) {
    return node.map(findCodeLanguage).find(Boolean) ?? ""
  }
  if (!React.isValidElement<{ className?: string; children?: React.ReactNode }>(node)) {
    return ""
  }

  return node.props.className?.match(/(?:^|\s)language-([\w-]+)/)?.[1]
    ?? findCodeLanguage(node.props.children)
}

function MarkdownCodeBlock({ children }: { children: React.ReactNode }) {
  const code = toText(children)
  const language = findCodeLanguage(children)
  const lines = useHighlightedCode(code, language)

  return (
    <CodeBlock size="sm" className="my-3">
      <CodeBlockContent wrap className="max-h-72">
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

const components: Partial<Components> = {
  pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
  code: ({ children, className }) => (
    <code data-slot="inline-code" className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]", className)}>
      {children}
    </code>
  ),
  p: ({ children }) => {
    const directive = parseFileDirective(toText(children))
    if (directive) return <FileCard path={directive.path} />
    return <p className="my-2 first:mt-0 last:mb-0">{children}</p>
  },
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-primary underline underline-offset-4"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-lg font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold">{children}</h3>,
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-border bg-muted px-3 py-2 text-start font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-border px-3 py-2">{children}</td>,
}

export function Markdown({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  const markdown = React.useMemo(() => children.split(/(\r?\n)/).map((part, index) => {
    if (index % 2 === 1) return part
    if (parseFileDirective(part)) return `\n\n${part}\n\n`
    return stripFileDirectives(part)
  }).join(""), [children])

  return (
    <div
      className={cn(
        "text-[0.9375rem] leading-relaxed wrap-break-word [&>*:first-child]:mt-0",
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
