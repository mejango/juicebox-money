'use client'

/** Artwork availability never blocks the inventory or checkout. */
export function ShopMediaStatus({ failed, fetching, retry }: { failed: boolean; fetching: boolean; retry: () => unknown }) {
  if (!failed) return null
  return <p role="status" className="text-xs text-smoke-600">
    Some item details or artwork could not load.{' '}
    <button type="button" disabled={fetching} onClick={() => { void retry() }} className="text-bluebs-600 underline underline-offset-2 disabled:opacity-50">
      {fetching ? 'Retrying…' : 'Retry item details'}
    </button>
  </p>
}

/** A failed shop read says so and offers the way out, on the spot. */
export function ShopReadFailed({ message, fetching, retry }: { message: string; fetching: boolean; retry: () => unknown }) {
  return <p role="status" className="text-sm leading-relaxed text-smoke-700">
    {message}{' '}
    <button type="button" disabled={fetching} onClick={() => { void retry() }} className="text-bluebs-600 underline underline-offset-2 disabled:opacity-50">
      {fetching ? 'Retrying…' : 'Retry'}
    </button>
  </p>
}
