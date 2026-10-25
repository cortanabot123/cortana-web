import { RefreshCwIcon } from "lucide-react"

import type { CommandsCatalogResult } from "@/lib/hermes-gateway"
import { filterCommands } from "@/lib/command-menu"

type CommandMenuProps = {
  catalog: CommandsCatalogResult | null
  query: string
  activeIndex: number
  loading: boolean
  error?: string | null
  onRefresh: () => void
  onSelect: (name: string) => void
}

function commandName(pair: string[]) {
  return (pair[0] ?? "").replace(/^\/+/, "")
}

export function CommandMenu({ catalog, query, activeIndex, loading, error, onRefresh, onSelect }: CommandMenuProps) {
  if (!/^\/[^\s]*$/.test(query)) return null
  const justSlash = query === "/"
  const allPairs = catalog?.pairs ?? []
  const filtered = filterCommands(allPairs, query)
  const groups = justSlash && catalog?.categories.length
    ? catalog.categories.map((category) => ({ name: category.name, pairs: category.pairs.filter(([name, description]) =>
      filtered.some(([filteredName]) => filteredName === name) && (commandName([name]) || description),
    ) })).filter((group) => group.pairs.length)
    : [{ name: "Commands", pairs: filtered }]

  let rowIndex = 0
  return (
    <div
      id="slash-command-menu"
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-0 z-30 mb-2 max-h-72 w-full overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
    >
      <div className="flex items-center justify-between px-2 py-1.5 text-xs text-muted-foreground">
        <span>{loading ? "Loading commands…" : "Commands"}</span>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onRefresh} aria-label="Refresh commands" className="rounded p-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <RefreshCwIcon className="size-3.5" />
        </button>
      </div>
      {catalog?.warning && <p role="status" className="px-2 py-1 text-xs text-muted-foreground">{catalog.warning}</p>}
      {error && <p role="alert" className="px-2 py-1 text-xs text-destructive">{error}</p>}
      {!loading && groups.every((group) => group.pairs.length === 0) && (
        <p className="px-2 py-2 text-sm text-muted-foreground">No matching commands.</p>
      )}
      {groups.map((group) => (
        <section key={group.name} aria-label={group.name}>
          {justSlash && <h3 className="px-2 pb-1 pt-2 text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">{group.name}</h3>}
          {group.pairs.map(([rawName, description]) => {
            const name = commandName([rawName])
            const index = rowIndex++
            return (
              <div
                key={`${group.name}:${rawName}`}
                id={`slash-command-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(name)}
                className={`flex cursor-pointer items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-sm ${index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
              >
                <code className="shrink-0 font-medium">/{name}</code>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{description}</span>
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}
