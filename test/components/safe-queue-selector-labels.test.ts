import {
  jbBuybackHookRegistryAbi,
  jbControllerAbi,
} from '@bananapus/nana-sdk-core'
import { encodeFunctionData, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { SELECTOR_LABELS } from '@/components/project/SafeQueueCard'

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

  it('resolves an ERC-20 deployment from real calldata', () => {
    const data = encodeFunctionData({
      abi: jbControllerAbi,
      functionName: 'deployERC20For',
      args: [1n, 'Name', 'TICK', `0x${'00'.repeat(32)}`],
    })
    expect(SELECTOR_LABELS.get(data.slice(0, 10))).toBe('Deploy ERC-20')
  })
})
