'use client'

import { WRITE_EXIT_LABEL, writeExitMessage, type WriteHeldState } from '@bananapus/nana-sdk-core/review'
import { explorerTxUrl } from '@/lib/chainDisplay'

/**
 * A held write as the SDK's write hold says: its one line, a link when it has
 * a hash, and, for a state that offers it, the exit with what sending again
 * costs. Inline elements only, so it can sit in a dialog's alert line.
 */
export function WriteHeldNotice({ chainId, state, onExit }: {
  chainId: number
  state: WriteHeldState
  /** Given only for a state with `exit: true`. */
  onExit?: () => void
}) {
  const hash = 'hash' in state ? state.hash : state.record.hash
  const url = hash ? explorerTxUrl(chainId, hash) : null
  // Only while this browser can't remember pending writes.
  const notice = 'notice' in state && typeof state.notice === 'string' ? state.notice : null
  const warning = 'warning' in state && state.warning ? state.warning : writeExitMessage(state.record.call)
  return (
    <span className="block space-y-2 text-smoke-800">
      <span className="block">
        {state.line}
        {url ? (
          <>
            {' '}
            <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
              View transaction
            </a>
          </>
        ) : null}
      </span>
      {notice ? <span className="block text-xs text-smoke-600">{notice}</span> : null}
      {onExit ? (
        <>
          <button type="button" className="btn-secondary min-h-[36px] px-4 text-sm" onClick={onExit}>
            {WRITE_EXIT_LABEL}
          </button>
          <span className="block text-xs text-smoke-600">{warning}</span>
        </>
      ) : null}
    </span>
  )
}
