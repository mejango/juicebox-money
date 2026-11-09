/** The last row of a list that grows when asked, so the page below stays reachable. */
export function LoadMoreRow({
  label,
  loading,
  error,
  onLoadMore,
}: {
  label: string
  loading: boolean
  /** Why the last page failed; the button stays as the retry. */
  error?: string | null
  onLoadMore: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onLoadMore}
        disabled={loading}
        aria-busy={loading}
        className={`flex h-16 w-full items-center justify-center text-sm font-medium text-bluebs-700 hover:text-bluebs-800 ${
          loading ? 'animate-pulse' : ''
        }`}
      >
        {label}
      </button>
      {error ? <p className="-mt-3 pb-3 text-center text-xs text-crush-600">{error}</p> : null}
    </li>
  )
}
