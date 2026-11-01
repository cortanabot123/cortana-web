import * as React from "react"
import { code } from "@streamdown/code"
import { Streamdown, type Components } from "streamdown"

import { FileCard } from "@/components/file-card"
import { parseFileDirective, stripFileDirectives } from "@/lib/file-directives"
import { cn } from "cn"

// Module-level singletons: Streamdown memoizes per markdown block, and a fresh
// object identity on every render would defeat that memoization.
const plugins = { code }

/** Flattens rendered children into plain text for `::file{}` detection. */
function plainText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(plainText).join("")
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return plainText(node.props.children)
  return ""
}

/** Drops the `node` prop react-markdown/streamdown hand to renderers. */
type RenderProps<T> = T & { node?: unknown }

const components: Components = {
  p: ({ children, node: _node, ...props }: RenderProps<React.ComponentProps<"p">>) => {
    const directive = parseFileDirective(plainText(children))
    if (directive) return <FileCard path={directive.path} />
    return <p className="my-2 first:mt-0 last:mb-0" {...props}>{children}</p>
  },
  a: ({ children, node: _node, href, ...props }: RenderProps<React.ComponentProps<"a">>) => (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-primary underline underline-offset-4"
    >
      {children}
    </a>
  ),
  ul: ({ children, node: _node, ...props }: RenderProps<React.ComponentProps<"ul">>) => (
    <ul className="my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, node: _node, ...props }: RenderProps<React.ComponentProps<"ol">>) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, node: _node, ...props }: RenderProps<React.ComponentProps<"li">>) => (
    <li className="pl-1" {...props}>{children}</li>
  ),
  strong: ({ children, node: _node, ...props }: RenderProps<React.ComponentProps<"strong">>) => (
    <strong className="font-semibold text-foreground" {...props}>{children}</strong>
  ),
  blockquote: ({ children, node: _node, ...props }: RenderProps<React.ComponentProps<"blockquote">>) => (
    <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground" {...props}>
      {children}
    </blockquote>
  ),
  h1: ({ children, node: _node, ...props }: RenderProps<React.ComponentProps<"h1">>) => (
    <h1 className="mt-4 mb-2 text-lg font-semibold" {...props}>{children}</h1>
  ),
  h2: ({ children, node: _node, ...props }: RenderProps<React.ComponentProps<"h2">>) => (
    <h2 className="mt-4 mb-2 text-base font-semibold" {...props}>{children}</h2>
  ),
  h3: ({ children, node: _node, ...props }: RenderProps<React.ComponentProps<"h3">>) => (
    <h3 className="mt-3 mb-1.5 text-sm font-semibold" {...props}>{children}</h3>
  ),
  hr: ({ node: _node, ...props }: RenderProps<React.ComponentProps<"hr">>) => (
    <hr className="my-4 border-border" {...props} />
  ),
  table: ({ children, node: _node, ...props }: RenderProps<React.ComponentProps<"table">>) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm" {...props}>{children}</table>
    </div>
  ),
  th: ({ children, node: _node, ...props }: RenderProps<React.ComponentProps<"th">>) => (
    <th className="border-border bg-muted px-3 py-2 text-start font-medium" {...props}>{children}</th>
  ),
  td: ({ children, node: _node, ...props }: RenderProps<React.ComponentProps<"td">>) => (
    <td className="border-border px-3 py-2" {...props}>{children}</td>
  ),
}

export function Markdown({
  children,
  className,
  streaming = false,
}: {
  children: string
  className?: string
  /** True while tokens are still arriving: repairs incomplete markdown and shows a caret. */
  streaming?: boolean
}) {
  // Give each `::file{}` directive its own paragraph, drop the inline ones.
  const markdown = React.useMemo(() => children.split(/(\r?\n)/).map((part, index) => {
    if (index % 2 === 1) return part
    if (parseFileDirective(part)) return `\n\n${part}\n\n`
    return stripFileDirectives(part)
  }).join(""), [children])

  return (
    <Streamdown
      className={cn(
        "text-[0.9375rem] leading-relaxed wrap-break-word [&>*:first-child]:mt-0",
        className
      )}
      components={components}
      plugins={plugins}
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      caret={streaming ? "block" : undefined}
      lineNumbers
      codeBlockMaxHeight="18rem"
      translations={{ copyCode: "Copy code", copied: "Copied" }}
    >
      {markdown}
    </Streamdown>
  )
}
