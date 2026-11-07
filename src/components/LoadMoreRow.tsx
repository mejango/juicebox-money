/** The last row of a list that grows when asked, so the page below stays reachable. */
export function LoadMoreRow({
  label,
  loading,
  onLoadMore,
}: {
  label: string
  loading: boolean
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
    </li>
  )
}
