'use client'

import { useRef, useState } from 'react'
import { buildTransactionDebugPrompt } from '@/lib/transaction-review'

/**
 * "[audit]" — copies a prompt that has the reader's AI explain a mined
 * transaction from explorer evidence. Sits in an activity row's meta line.
 */
export function TxDebugPromptLink({
  calls,
}: {
  calls: { chainId: number; txHash: string }[]
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  return (
    <button
      type="button"
      title="Copy a prompt that has your AI explain this transaction"
      className="hover:text-ink"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(buildTransactionDebugPrompt(calls))
          setCopied(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1400)
        } catch {
          // Clipboard unavailable; leave the label unchanged.
        }
      }}
    >
      {copied ? '[copied]' : '[audit]'}
    </button>
  )
}
