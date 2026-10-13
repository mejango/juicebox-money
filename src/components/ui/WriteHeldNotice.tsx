'use client'

import { WRITE_EXIT_LABEL, writeExitMessage, writeHeldMessage } from '@bananapus/nana-sdk-core/review'
import { explorerTxUrl } from '@/lib/chainDisplay'
import { WRITE_PENDING_LINE } from '@/lib/write-recovery'

/**
 * A wallet write with no confirmed result. With `onExit` (no known hash, or a
 * hash proven dropped): the SDK's one line and the exit that sends it again
 * once the user checked their wallet. Without it (a hash still pending): one
 * line saying the wallet speeds it up or cancels it. A link when there is a
 * hash. Inline elements only, so it can sit in a dialog's alert line.
 */
export function WriteHeldNotice({ chainId, hash, value, action, onExit }: {
  chainId: number
  hash: string | null
  value?: bigint | string
  /** A noun for the write, as the line names it: "transaction" by default. */
  action?: string
  onExit?: () => void
}) {
  const url = hash ? explorerTxUrl(chainId, hash) : null
  const link = url ? (
    <>
      {' '}
      <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
        View transaction
      </a>
    </>
  ) : null
  if (!onExit) return <span className="block text-smoke-800">{WRITE_PENDING_LINE}{link}</span>
  return (
    <span className="block space-y-2 text-smoke-800">
      <span className="block">
        {writeHeldMessage(action)}
        {link}
      </span>
      <button type="button" className="btn-secondary min-h-[36px] px-4 text-sm" onClick={onExit}>
        {WRITE_EXIT_LABEL}
      </button>
      <span className="block text-xs text-smoke-600">{writeExitMessage({ value }, action)}</span>
    </span>
  )
}
