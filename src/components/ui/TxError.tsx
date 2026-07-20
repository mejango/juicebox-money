/**
 * The red error block every write flow renders under its action button.
 * Renders nothing when there's no error, so callers can pass their state
 * straight through: `<TxError error={flowError ?? tx.error} />`.
 */
export function TxError({
  error,
  className = 'mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700',
}: {
  error: string | null | undefined
  className?: string
}) {
  if (!error) return null
  return <p className={className}>{error}</p>
}

/** The authority cards' compact variant (smaller text, tighter margin). */
export function ErrorNote({ message }: { message: string }) {
  return (
    <TxError
      error={message}
      className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700"
    />
  )
}
