'use client'

import type { PayNoticeView } from '@/lib/pay-notice'
import { chainName } from '@/lib/urn'

/**
 * Under a payment's review: a notice that could not be read gets one quiet
 * line with a retry, and a notice that reads differently on the project's
 * other chains can be opened to compare. Neither blocks the payment.
 */
export function PayNoticeNote({ view, retry }: { view: PayNoticeView; retry: () => void }) {
  if (view.failed) {
    return (
      <p className="text-xs text-smoke-500">
        The project’s notice could not be loaded.{' '}
        <button type="button" onClick={retry} className="underline underline-offset-2 hover:text-ink">
          Retry
        </button>
      </p>
    )
  }
  if (!view.others.length) return null
  return (
    <details className="text-xs text-smoke-500">
      <summary className="cursor-pointer hover:text-ink">
        The notice differs on {view.others.map(row => chainName(row.chainId)).join(', ')}.
      </summary>
      <dl className="mt-2 space-y-2">
        {view.others.map(row => (
          <div key={row.chainId}>
            <dt className="font-medium text-smoke-700">{chainName(row.chainId)}</dt>
            <dd className="whitespace-pre-wrap break-words">{row.notice || 'No notice.'}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
