import type { ComponentProps } from 'react'
import type { TxProgress, useStartOnce } from '@/components/ui/TxProgress'

type Module = { TxProgress: typeof TxProgress; useStartOnce: typeof useStartOnce }

/**
 * The TxProgress module with its modal replaced: the same start, rows, status,
 * error and buttons, marked for queries. It takes the real module, so a mock
 * never imports what it mocks:
 * `vi.mock('@/components/ui/TxProgress', async original => (await import('../support/tx-progress')).testTxProgress(await original()))`.
 */
export function testTxProgress<T extends Module>(original: T): T {
  function TestTxProgress({ open = true, preparing = false, start, startKey, next, onClose, complete, busy, error, status, rows, children, title }: Partial<ComponentProps<typeof TxProgress>>) {
    original.useStartOnce(open, preparing || !!complete, start, startKey)
    if (!open) return null
    return (
      <section data-tx-confirm>
        <h2>{title}</h2>
        {rows?.map((row, index) => <p key={index} data-row={String(row.label)}>{row.value}</p>)}
        <p data-status>{status}</p>
        <p data-error>{error}</p>
        {children}
        {complete
          ? <button type="button" onClick={onClose}>Done</button>
          : <button type="button" onClick={onClose}>Close review</button>}
        {next && !complete ? <button type="button" disabled={busy || preparing || !!next.disabled} onClick={next.onClick}>{next.label}</button> : null}
      </section>
    )
  }
  return { ...original, TxProgress: TestTxProgress as unknown as T['TxProgress'] }
}
