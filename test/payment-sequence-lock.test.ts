// A receipt-wait timeout is not a failure. The waiter gives up after ~5 minutes with the
// payment still pending; re-enabling retry there sends a SECOND `pay` while the first is in
// flight — a real double payment, and one that bypasses useSafeTx's own re-submit guard.
import { paymentSequenceLocked } from '@/lib/permit2-swap'
import { describe, expect, it } from 'vitest'

describe('paymentSequenceLocked', () => {
  it('stays locked on a pending payment after the in-flight flag clears', () => {
    // `sequenceStarted` is cleared in the sequence's `finally`, so the pending hash is the
    // only thing holding the gate shut once the wait has timed out.
    expect(paymentSequenceLocked(false, '0xabc')).toBe(true)
  })

  it('locks while the sequence is running', () => {
    expect(paymentSequenceLocked(true, null)).toBe(true)
  })

  it('unlocks only when nothing is running and nothing is pending', () => {
    expect(paymentSequenceLocked(false, null)).toBe(false)
  })
})
