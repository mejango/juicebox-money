import {
  jbBuybackHookRegistryAbi,
  jbControllerAbi,
} from '@bananapus/nana-sdk-core'
import { encodeFunctionData, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { SELECTOR_LABELS, transactionLabel } from '@/components/project/SafeQueueCard'
import { encodeMultiSend, MULTI_SEND_CALL_ONLY } from '@/lib/safe-batch'

/**
 * The queue labels co-signers read must resolve from calldata the app itself
 * encodes. Hand-written signature strings drifted from the ABI once already
 * (`initializePoolFor`'s twapWindow is uint256, not uint32).
 */
describe('Safe queue selector labels', () => {
  it('labels every call it claims to know', () => {
    expect(SELECTOR_LABELS.size).toBe(9)
  })

  it('resolves buyback-pool initialization from real calldata', () => {
    const data = encodeFunctionData({
      abi: jbBuybackHookRegistryAbi,
      functionName: 'initializePoolFor',
      args: [1n, 10_000, 200, 1_800n, zeroAddress, 2n ** 96n],
    })
    expect(SELECTOR_LABELS.get(data.slice(0, 10))).toBe(
      'Initialize buyback pool',
    )
  })

  it('labels an operation-1 MultiSendCallOnly row as a decoded batch', () => {
    const inner = encodeFunctionData({
      abi: jbBuybackHookRegistryAbi,
      functionName: 'setHookFor',
      args: [2n, '0xB222Da5A71e8FB89a5A38b7c920EaB5DfbC74B91'],
    })
    const data = encodeMultiSend([
      { to: '0x72F55a54CD53410a5Ff175508a5A384227081788', data: inner, value: 0n },
      { to: '0x72F55a54CD53410a5Ff175508a5A384227081788', data: inner, value: 0n },
    ])
    const row = {
      to: MULTI_SEND_CALL_ONLY,
      value: '0',
      data,
      operation: 1,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: 3,
    }
    expect(transactionLabel(1, row)).toBe('Batch (2 calls) | MultiSendCallOnly')
    // A plain CALL to the same address is not a batch and keeps the selector label.
    expect(transactionLabel(1, { ...row, operation: 0 })).toMatch(/^0x8d80ff0a \|/)
  })

  it('resolves an ERC-20 deployment from real calldata', () => {
    const data = encodeFunctionData({
      abi: jbControllerAbi,
      functionName: 'deployERC20For',
      args: [1n, 'Name', 'TICK', `0x${'00'.repeat(32)}`],
    })
    expect(SELECTOR_LABELS.get(data.slice(0, 10))).toBe('Deploy ERC-20')
  })
})
