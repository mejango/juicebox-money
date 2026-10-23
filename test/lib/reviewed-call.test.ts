import { encodeFunctionData, erc20Abi, parseAbi, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { hashOf, revertedReceipt, reviewedCall } from '@/lib/reviewed-call'

const TOKEN = '0x4444444444444444444444444444444444444444'
const SPENDER = '0x5555555555555555555555555555555555555555'
const request = { chainId: 10, address: TOKEN, abi: erc20Abi, functionName: 'approve', args: [SPENDER, 5n] } as const

describe('reviewedCall', () => {
  it('carries the exact bytes, value 0 when none, and the step keys, with no label unless given', () => {
    const call = reviewedCall(request, { intent: 'pay:1', dependsOnPrior: true })
    expect(call).toEqual({
      chainId: 10, to: TOKEN, value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SPENDER, 5n] }),
      abi: erc20Abi, functionName: 'approve', args: [SPENDER, 5n],
      intent: 'pay:1', dependsOnPrior: true,
    })
    expect('label' in call).toBe(false)
  })

  it('keeps a given value and label', () => {
    expect(reviewedCall({ ...request, value: 3n, label: 'Approve' })).toMatchObject({ value: 3n, label: 'Approve' })
  })
})

describe('Safe queue adoption', () => {
  it("adopts a queued proposal that differs only in a liquidity mint's deadline or a Permit2 approval's expiration", () => {
    const abi = parseAbi([
      'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
      'function approve(address token, address spender, uint160 amount, uint48 expiration)',
    ])
    expect(reviewedCall({ chainId: 1, address: TOKEN, abi, functionName: 'modifyLiquidities', args: ['0x12', 9n] }).adoptIgnoringArgs).toEqual([1])
    expect(reviewedCall({ chainId: 1, address: TOKEN, abi, functionName: 'approve', args: [TOKEN, SPENDER, 1n, 2] }).adoptIgnoringArgs).toEqual([3])
    expect('adoptIgnoringArgs' in reviewedCall(request)).toBe(false)
  })
})

describe('hashOf', () => {
  const A = `0x${'aa'.repeat(32)}` as Hex
  const B = `0x${'bb'.repeat(32)}` as Hex

  it('is the last hash of a finished run, the proposal of a proposed one, and null otherwise', () => {
    expect(hashOf(null)).toBeNull()
    expect(hashOf({ status: 'done', hashes: [A, B], receipts: [] })).toBe(B)
    expect(hashOf({ status: 'done', hashes: [], receipts: [] })).toBeNull()
    expect(hashOf({ status: 'proposed', step: 0, safeTxHash: A } as never)).toBe(A)
  })
})

describe('revertedReceipt', () => {
  const reverted = (receipt?: unknown) => Object.assign(new Error('reverted'), { name: 'ReviewedCallRevertedError', receipt })

  it("is the receipt of a mined revert, and null for any other failure or one without its receipt", () => {
    const receipt = { status: 'reverted', blockNumber: 1n }
    expect(revertedReceipt(reverted(receipt))).toBe(receipt)
    expect(revertedReceipt(reverted())).toBeNull()
    expect(revertedReceipt(new Error('network'))).toBeNull()
    expect(revertedReceipt({ name: 'ReviewedCallRevertedError', receipt })).toBeNull()
    expect(revertedReceipt(null)).toBeNull()
  })
})
