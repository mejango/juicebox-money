import type { Address } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { submitReviewedContractWrite } from '@/lib/contract-write'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address

function harness() {
  const events: string[] = []
  const request = { chainId: 10, calldata: 'reviewed' }
  const simulated = { calldata: 'simulated', gas: 123n }
  let current: Address | undefined = ALICE

  return {
    events,
    request,
    simulated,
    setCurrent: (account: Address | undefined) => {
      current = account
    },
    options: {
      request,
      expectedAccount: ALICE,
      review: vi.fn(async reviewed => {
        events.push('review')
        expect(reviewed).toBe(request)
      }),
      switchChain: vi.fn(async chainId => {
        events.push(`switch:${chainId}`)
      }),
      currentAccount: vi.fn(() => current),
      simulate: vi.fn(async reviewed => {
        events.push('simulate')
        expect(reviewed).toBe(request)
        return simulated
      }),
      write: vi.fn(async prepared => {
        events.push('write')
        expect(prepared).toBe(simulated)
        return '0xhash'
      }),
      onPhase: vi.fn(phase => events.push(`phase:${phase}`)),
    },
  }
}

describe('reviewed direct-write boundary', () => {
  it('reviews, switches, checks, simulates, rechecks, then signs exactly once', async () => {
    const run = harness()

    await expect(submitReviewedContractWrite(run.options)).resolves.toBe(
      '0xhash',
    )
    expect(run.events).toEqual([
      'phase:review',
      'review',
      'phase:simulating',
      'switch:10',
      'simulate',
      'phase:signing',
      'write',
    ])
    expect(run.options.currentAccount).toHaveBeenCalledTimes(2)
    expect(run.options.write).toHaveBeenCalledTimes(1)
  })

  it('does nothing irreversible when review fails', async () => {
    const run = harness()
    run.options.review.mockRejectedValueOnce(new Error('Review closed.'))

    await expect(submitReviewedContractWrite(run.options)).rejects.toThrow(
      'Review closed.',
    )
    expect(run.options.switchChain).not.toHaveBeenCalled()
    expect(run.options.simulate).not.toHaveBeenCalled()
    expect(run.options.write).not.toHaveBeenCalled()
  })

  it('fails closed if the account changes during the chain switch', async () => {
    const run = harness()
    run.options.switchChain.mockImplementationOnce(async () => {
      run.setCurrent(BOB)
    })

    await expect(submitReviewedContractWrite(run.options)).rejects.toThrow(
      /account changed/i,
    )
    expect(run.options.simulate).not.toHaveBeenCalled()
    expect(run.options.write).not.toHaveBeenCalled()
  })

  it('never signs when the account changes while simulation is running', async () => {
    const run = harness()
    run.options.simulate.mockImplementationOnce(async () => {
      run.setCurrent(undefined)
      return run.simulated
    })

    await expect(submitReviewedContractWrite(run.options)).rejects.toThrow(
      /account changed/i,
    )
    expect(run.options.write).not.toHaveBeenCalled()
  })

  it('requires an expected connected account before opening review', async () => {
    const run = harness()

    await expect(
      submitReviewedContractWrite({
        ...run.options,
        expectedAccount: undefined,
      }),
    ).rejects.toThrow('Connect a wallet first.')
    expect(run.options.review).not.toHaveBeenCalled()
  })
})
