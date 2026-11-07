/**
 * For a read a surface cannot act without: a few quick tries, then a failed read keeps being read
 * again, less often the longer it fails, so the surface recovers by itself once an outage ends.
 * Reads only: nothing here repeats a transaction.
 */
export const recoveringRead = {
  retry: 2,
  retryDelay: (attempt: number) => Math.min(1_000 * 2 ** attempt, 8_000),
  refetchInterval: (query: { state: { status: string; errorUpdateCount: number } }) =>
    query.state.status === 'error'
      ? Math.min(10_000 * 2 ** query.state.errorUpdateCount, 120_000)
      : false,
}
