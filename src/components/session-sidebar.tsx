import * as React from "react"
import { LoaderCircleIcon, MessageSquarePlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  asText,
  formatRelativeTime,
  rowTimestamp,
  useSessionList,
  type SessionSummaryRow,
} from "@/hooks/use-session-list"
import { cn } from "cn"

type SessionSidebarProps = {
  activeSessionId: string | null
  busy: boolean
  mobileOpen: boolean
  collapsed: boolean
  onSelect: (sessionId: string) => void
  onNewConversation: () => void
  onCloseMobile: () => void
}

/** Left-hand conversation history: fixed drawer on mobile, pinned column on desktop. */
export function SessionSidebar({
  activeSessionId,
  busy,
  mobileOpen,
  collapsed,
  onSelect,
  onNewConversation,
  onCloseMobile,
}: SessionSidebarProps) {
  const { rows, total, available, loading, loadingMore, loadMore } = useSessionList()
  const asideRef = React.useRef<HTMLElement>(null)

  React.useEffect(() => {
    if (!mobileOpen) return
    asideRef.current?.querySelector<HTMLElement>("button")?.focus()
  }, [mobileOpen])

  React.useEffect(() => {
    if (!mobileOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseMobile()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [mobileOpen, onCloseMobile])

  const hasMore = Boolean(available && rows && rows.length < total)

  const renderItem = (row: SessionSummaryRow) => {
    const active = row.session_id === activeSessionId
    const title = asText(row.title) ?? asText(row.preview) ?? "Untitled conversation"
    const source = asText(row.source)
    const messageCount = typeof row.message_count === "number" && row.message_count > 0 ? row.message_count : null
    return (
      <li key={row.session_id}>
        <button
          type="button"
          data-slot="session-sidebar-item"
          data-session-id={row.session_id}
          aria-current={active ? "true" : undefined}
          onClick={() => {
            if (!active) onSelect(row.session_id)
            onCloseMobile()
          }}
          className={cn(
            "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
            active ? "bg-accent text-accent-foreground" : "text-foreground",
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate" title={title}>{title}</span>
            <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] leading-none text-muted-foreground">
              {source && <span className="shrink-0 rounded bg-muted px-1 py-0.5">{source}</span>}
              {messageCount !== null && <span>{messageCount} msgs</span>}
              <span className="ml-auto shrink-0">{formatRelativeTime(rowTimestamp(row))}</span>
            </span>
          </span>
        </button>
      </li>
    )
  }

  return (
    <aside
      id="cortana-session-sidebar"
      ref={asideRef}
      data-slot="session-sidebar"
      className={cn(
        "fixed inset-y-0 left-0 z-40 flex w-72 max-w-[calc(100vw-4rem)] shrink-0 flex-col border-r border-border/70 bg-background shadow-lg transition-transform duration-200 lg:static lg:z-auto lg:max-w-none lg:shadow-none lg:transition-none",
        mobileOpen ? "translate-x-0 visible" : "-translate-x-full invisible",
        // lg:translate-x-0 must override the mobile -translate-x-full, otherwise the
        // desktop sidebar is visible but still parked off-screen at x=-288.
        collapsed ? "lg:hidden" : "lg:visible lg:translate-x-0",
      )}
    >
      <nav aria-label="Conversation history" className="flex h-full min-h-0 flex-col gap-2 p-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start font-normal"
          disabled={busy}
          onClick={() => {
            onNewConversation()
            onCloseMobile()
          }}
        >
          <MessageSquarePlusIcon />New conversation
        </Button>
        <div data-slot="session-sidebar-list" className="min-h-0 flex-1 overflow-y-auto py-1">
          {loading ? (
            <div role="status" aria-live="polite" className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
              <span>Loading conversations…</span>
            </div>
          ) : !available ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Conversation history is unavailable.</p>
          ) : !rows || rows.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No conversations yet.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">{rows.map(renderItem)}</ul>
          )}
        </div>
        {hasMore && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full font-normal text-muted-foreground"
            disabled={loadingMore}
            onClick={loadMore}
          >
            {loadingMore ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
            Load more
          </Button>
        )}
      </nav>
    </aside>
  )
}
