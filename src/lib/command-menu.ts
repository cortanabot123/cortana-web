function commandName(pair: string[]) {
  return (pair[0] ?? "").replace(/^\/+/, "")
}

export function filterCommands(pairs: string[][], query: string) {
  const lowerQuery = query.replace(/^\/+/, "").toLowerCase()
  return pairs
    .map((pair, index) => {
      const name = commandName(pair).toLowerCase()
      const description = (pair[1] ?? "").toLowerCase()
      const rank = !lowerQuery ? 0 : name === lowerQuery ? -1 : name.startsWith(lowerQuery) ? 0 : name.includes(lowerQuery) ? 1 : description.includes(lowerQuery) ? 2 : Number.POSITIVE_INFINITY
      return { pair, index, rank }
    })
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ pair }) => pair)
}
