import { decodeFunctionData, type Address, type Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  SAFE_EXEC_ABI,
  safeExecutionArgs,
  safeProposalFor,
} from '@bananapus/nana-sdk-core/safe-service'

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))

import { SAFE_REFUND_REFUSAL, safeExecRelayrEntry } from '@/lib/safe'

// The SDK's tests prove Safe hashing, signature order and links; these prove
// the execTransaction this app hands Relayr.

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const ALICE = '0x2222222222222222222222222222222222222222' as Address
const BOB = '0x3333333333333333333333333333333333333333' as Address
const TARGET = '0x4444444444444444444444444444444444444444' as Address
const SIG_ALICE = `0x${'aa'.repeat(64)}1b` as Hex
const SIG_BOB = `0x${'bb'.repeat(64)}1c` as Hex

const proposal = () => safeProposalFor({ to: TARGET, data: '0x1234', value: 17n }, 9)

describe('the Relayr execution of a queued Safe transaction', () => {
  it("round-trips the exact execTransaction, signed only by the Safe's current owners", () => {
    const tx = {
      ...proposal(),
      confirmations: [
        { owner: BOB, signature: SIG_BOB },
        { owner: ALICE, signature: SIG_ALICE },
      ],
    }
    const entry = safeExecRelayrEntry(10, SAFE, tx, [ALICE])
    const decoded = decodeFunctionData({ abi: SAFE_EXEC_ABI, data: entry.data })

    expect(entry).toEqual(expect.objectContaining({ chain: 10, target: SAFE, value: '0' }))
    expect(decoded.functionName).toBe('execTransaction')
    expect(decoded.args).toEqual(safeExecutionArgs(tx, [ALICE]))
    // Bob no longer owns the Safe, so only Alice's signature is sent.
    expect(decoded.args?.[9]).toBe(SIG_ALICE)
  })

  it('refuses a transaction that pays a gas refund', () => {
    expect(() =>
      safeExecRelayrEntry(10, SAFE, { ...proposal(), gasPrice: '3' }, [ALICE]),
    ).toThrow(SAFE_REFUND_REFUSAL)
  })
})
