import * as React from "react"

export const PAGE_SIZE = 30

export type SessionSummaryRow = {
  // The dashboard's /api/sessions returns the id as `id`; older shapes used `session_id`.
  session_id: string
  id?: string
  title?: string | null
  preview?: string | null
  source?: string | null
  started_at?: number | string | null
  ended_at?: number | string | null
  message_count?: number | string | null
}

export function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function asTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function rowTimestamp(row: SessionSummaryRow): number | null {
  return asTimestamp(row.ended_at) ?? asTimestamp(row.started_at)
}

/** Compact age label such as "now", "5m", "3h", "Yesterday", "4d" or a short date. */
export function formatRelativeTime(timestamp: number | null): string {
  if (timestamp === null) return ""
  const now = Date.now()
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const startOfDay = (time: number) => {
    const date = new Date(time)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }
  const dayDiff = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000)
  if (dayDiff <= 1) return "Yesterday"
  if (dayDiff < 7) return `${dayDiff}d`
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

type SessionListState = {
  rows: SessionSummaryRow[] | null
  total: number
  available: boolean
  loading: boolean
  loadingMore: boolean
}

/**
 * Paged `/api/sessions` loader (PAGE_SIZE rows per page). A gateway that is not
 * configured (available=false) renders as "history unavailable" instead of an error.
 */
export function useSessionList(): SessionListState & { loadMore: () => void } {
  const [rows, setRows] = React.useState<SessionSummaryRow[] | null>(null)
  const [total, setTotal] = React.useState(0)
  const [available, setAvailable] = React.useState(true)
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const rowsRef = React.useRef<SessionSummaryRow[] | null>(null)
  const availableRef = React.useRef(available)
  const totalRef = React.useRef(total)
  React.useEffect(() => {
    rowsRef.current = rows
    availableRef.current = available
    totalRef.current = total
  })

  const fetchSessions = React.useCallback(async (offset: number) => {
    const appending = offset > 0
    if (appending) setLoadingMore(true)
    try {
      const response = await fetch(`/api/sessions?limit=${PAGE_SIZE}&offset=${offset}`, {
        credentials: "same-origin",
        cache: "no-store",
      })
      if (!response.ok) {
        if (!appending) setAvailable(false)
        return
      }
      const contentType = response.headers.get("content-type") ?? ""
      if (!contentType.includes("json")) {
        if (!appending) setAvailable(false)
        return
      }
      const result: unknown = await response.json()
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        if (!appending) setAvailable(false)
        return
      }
      const data = result as { sessions?: unknown; total?: unknown; available?: unknown }
      if (data.available === false) {
        setTotal(0)
        setAvailable(false)
        if (!appending) setRows([])
        return
      }
      const incoming = Array.isArray(data.sessions)
        ? (data.sessions as unknown[]).map((entry): SessionSummaryRow | null => {
          if (!entry || typeof entry !== "object") return null
          const row = entry as SessionSummaryRow
          const id = typeof row.session_id === "string" && row.session_id ? row.session_id : row.id
          return typeof id === "string" && id ? { ...row, session_id: id } : null
        }).filter((row): row is SessionSummaryRow => row !== null)
        : []
      const nextTotal = typeof data.total === "number" && Number.isFinite(data.total) ? data.total : 0
      setAvailable(true)
      setTotal(nextTotal)
      setRows((current) => {
        const base = appending && current ? current : []
        const seen = new Set(base.map((row) => row.session_id))
        return [...base, ...incoming.filter((row) => !seen.has(row.session_id))]
      })
    } catch {
      if (!appending) setAvailable(false)
    } finally {
      if (appending) setLoadingMore(false)
      else setLoading(false)
    }
  }, [])

  // oxlint-disable-next-line react/set-state-in-effect -- data arrives from async fetches, not synchronously
  React.useEffect(() => {
    // oxlint-disable-next-line
    void fetchSessions(0)
  }, [fetchSessions])

  const loadMore = React.useCallback(() => {
    const current = rowsRef.current
    if (!availableRef.current || !current) return
    if (current.length === 0 || current.length >= totalRef.current) return
    void fetchSessions(current.length)
  }, [fetchSessions])

  return { rows, total, available, loading, loadingMore, loadMore }
}
