import { UNISWAP_PERMIT2_ADDRESS } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, erc20Abi, type Address, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isSafeConnection: vi.fn(),
  proposeSafeBatch: vi.fn(),
}))

vi.mock('@/providers/Providers', () => ({ wagmiConfig: { tag: 'config' } }))
vi.mock('@/lib/safe-connector', async original => ({
  ...(await original<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: mocks.isSafeConnection,
}))
vi.mock('@/lib/safe-batch-connector', () => ({
  proposeSafeBatch: mocks.proposeSafeBatch,
}))

import {
  liquidityBatchApplies,
  liquidityBatchCalls,
  liquidityBatchIntro,
  proposeLiquidityBatch,
  type LiquidityStep,
} from '@/lib/liquidity-safe-batch'

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const TOKEN = '0x3333333333333333333333333333333333333333' as Address
const POSM = '0x4444444444444444444444444444444444444444' as Address
const UNLOCK = '0xdeadbeef' as Hex
const PROPOSAL = `0x${'ab'.repeat(32)}` as Hex
const NOW = 1_800_000_000

const steps: LiquidityStep[] = [
  { kind: 'approve-erc20', token: TOKEN, amount: 500n, label: 'Approve ART for Permit2' },
  {
    kind: 'permit2-approve',
    token: TOKEN,
    amount: 500n,
    expiration: NOW + 30 * 24 * 3600,
    label: 'Authorize the position manager for ART',
  },
  { kind: 'mint', label: 'Add liquidity' },
]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW * 1000)
  mocks.isSafeConnection.mockReturnValue(true)
  mocks.proposeSafeBatch.mockResolvedValue({ safeTxHash: PROPOSAL, executionHash: null })
})

describe('liquidity as one Safe batch', () => {
  it('applies only to a Safe app connection with more than one step', () => {
    expect(liquidityBatchApplies(steps)).toBe(true)
    expect(liquidityBatchApplies([steps[2]])).toBe(false)
    mocks.isSafeConnection.mockReturnValue(false)
    expect(liquidityBatchApplies(steps)).toBe(false)
    expect(liquidityBatchIntro(3)).toBe(
      'Goes to your Safe as one batch of 3 calls: approved once, executed together.',
    )
  })

  it('proposes the ERC-20 approve, Permit2 approve and the dependent mint as one batch', async () => {
    const hash = await proposeLiquidityBatch({
      chainId: 8453,
      account: SAFE,
      positionManager: POSM,
      steps,
      unlockData: UNLOCK,
      value: 7n,
      title: 'Add liquidity',
    })

    expect(hash).toBe(PROPOSAL)
    expect(mocks.proposeSafeBatch).toHaveBeenCalledOnce()
    const request = mocks.proposeSafeBatch.mock.calls[0][0]
    expect(request).toMatchObject({
      chainId: 8453,
      safe: SAFE,
      title: 'Add liquidity',
      awaitExecution: false,
    })
    const calls = request.calls
    expect(calls).toHaveLength(3)

    expect(calls[0]).toMatchObject({
      to: TOKEN,
      value: 0n,
      label: 'Approve ART for Permit2',
      functionName: 'approve',
    })
    expect(calls[0].dependsOnPrior).toBeFalsy()
    expect(calls[1].dependsOnPrior).toBeFalsy()
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0].data })).toEqual({
      functionName: 'approve',
      args: [UNISWAP_PERMIT2_ADDRESS, 500n],
    })

    expect(calls[1]).toMatchObject({
      to: UNISWAP_PERMIT2_ADDRESS,
      value: 0n,
      label: 'Authorize the position manager for ART',
      functionName: 'approve',
      args: [TOKEN, POSM, 500n, NOW + 30 * 24 * 3600],
    })
    expect(calls[1].data.slice(0, 10)).toBe('0x87517c45')
    expect(decodeFunctionData({ abi: calls[1].abi, data: calls[1].data })).toEqual({
      functionName: 'approve',
      args: [TOKEN, POSM, 500n, NOW + 30 * 24 * 3600],
    })

    expect(calls[2]).toMatchObject({
      to: POSM,
      value: 7n,
      label: 'Add liquidity',
      functionName: 'modifyLiquidities',
      dependsOnPrior: true,
    })
    expect(decodeFunctionData({ abi: calls[2].abi, data: calls[2].data })).toEqual({
      functionName: 'modifyLiquidities',
      // A Safe's deadline is the 30-day Permit2 window, not an EOA's 20 minutes.
      args: [UNLOCK, BigInt(NOW + 30 * 24 * 3600)],
    })
    expect(
      liquidityBatchCalls({ chainId: 8453, positionManager: POSM, steps, unlockData: UNLOCK, value: 7n }).map(
        call => call.data,
      ),
    ).toEqual(calls.map((call: { data: Hex }) => call.data))
  })
})
