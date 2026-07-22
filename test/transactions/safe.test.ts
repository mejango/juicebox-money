import { decodeFunctionData, zeroAddress, type Address, type Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))

import {
  SAFE_EXEC_ABI,
  safeExecArgs,
  safeExecRelayrEntry,
  safeExecSignatures,
  safeQueueLink,
  safeTxHashOf,
  safeTxLink,
  safeUsableConfirmationCount,
  type SafeQueuedTx,
} from '@/lib/safe'

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const ALICE = '0x2222222222222222222222222222222222222222' as Address
const BOB = '0x3333333333333333333333333333333333333333' as Address
const TARGET = '0x4444444444444444444444444444444444444444' as Address
const SIG_ALICE = `0x${'aa'.repeat(64)}1b` as Hex
const SIG_BOB = `0x${'bb'.repeat(64)}1c` as Hex

function queued(overrides: Partial<SafeQueuedTx> = {}): SafeQueuedTx {
  return {
    to: TARGET,
    value: '17',
    data: '0x1234',
    operation: 0,
    safeTxGas: '100',
    baseGas: '20',
    gasPrice: '3',
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce: 9,
    confirmations: [],
    ...overrides,
  }
}

describe('Safe transaction primitives', () => {
  it('hashes every SafeTx field and changes when the nonce changes', () => {
    const first = safeTxHashOf(1, SAFE, queued())
    const second = safeTxHashOf(1, SAFE, queued({ nonce: 10 }))

    expect(first).toMatch(/^0x[0-9a-f]{64}$/)
    expect(second).toMatch(/^0x[0-9a-f]{64}$/)
    expect(first).not.toBe(second)
  })

  it('sorts signatures by owner address, never service response order', () => {
    const tx = queued({
      confirmations: [
        { owner: BOB, signature: SIG_BOB },
        { owner: ALICE, signature: SIG_ALICE },
      ],
    })

    expect(safeUsableConfirmationCount(tx)).toBe(2)
    expect(safeExecSignatures(tx)).toBe(
      `0x${SIG_ALICE.slice(2)}${SIG_BOB.slice(2)}`,
    )
  })

  it('encodes onchain approveHash confirmations in Safe signature form', () => {
    const tx = queued({ confirmations: [{ owner: ALICE }] })
    const signatures = safeExecSignatures(tx)

    expect(signatures).toHaveLength(2 + 65 * 2)
    expect(signatures).toBe(
      `0x${ALICE.slice(2).toLowerCase().padStart(64, '0')}${'0'.repeat(64)}01`,
    )
  })

  it('round-trips the exact outer execTransaction Relayr call', () => {
    const tx = queued({ confirmations: [{ owner: ALICE, signature: SIG_ALICE }] })
    const expectedArgs = safeExecArgs(tx, safeExecSignatures(tx))
    const entry = safeExecRelayrEntry(10, SAFE, tx)
    const decoded = decodeFunctionData({ abi: SAFE_EXEC_ABI, data: entry.data })

    expect(entry).toEqual(
      expect.objectContaining({ chain: 10, target: SAFE, value: '0' }),
    )
    expect(decoded.functionName).toBe('execTransaction')
    expect(decoded.args).toEqual(expectedArgs)
  })

  it('only creates Safe links for configured chain prefixes', () => {
    const hash = safeTxHashOf(1, SAFE, queued())
    expect(safeQueueLink(1, SAFE)).toContain(`safe=eth:${SAFE}`)
    expect(safeTxLink(10, SAFE, hash)).toContain(`safe=oeth:${SAFE}`)
    expect(safeQueueLink(999, SAFE)).toBeNull()
    expect(safeTxLink(999, SAFE, hash)).toBeNull()
  })
})
