// INV-1 launch guard: `JBAccountingContext.currency` is always token-keyed
// (`uint32(uint160(token))`), so an ETH+USDC plan needs JBPrices pairs the
// deployed feed topology doesn't register yet — launching one ships a project
// whose USDC pays and mixed-balance cash-outs revert (permanently for
// revnets). The guard probes `pricePerUnitOf(projectId: 0, …)` on every
// selected chain and fails CLOSED: a proven-missing feed blocks with the pair
// named, and an RPC failure blocks with distinct retry copy — never a silent
// pass.
import {
  JBCenterRequestError,
  JBCenterTimeoutError,
} from '@bananapus/nana-sdk-core/jbcenter'
import { ContractFunctionRevertedError } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  feedReachabilityBlock,
  probeFeedReachability,
} from '@/lib/feed-reachability'
import type { AccountingConfig } from '@/lib/launch'

const ETH_USDC: AccountingConfig = { tokens: ['eth', 'usdc'], custom: null }

/** What viem throws when the chain answers with JBPrices_PriceFeedNotFound. */
const feedNotFound = () =>
  new ContractFunctionRevertedError({
    abi: [],
    functionName: 'pricePerUnitOf',
  })

const clientOf = (readContract: ReturnType<typeof vi.fn>) => ({
  readContract: readContract as never,
})

describe('probeFeedReachability', () => {
  it('blocks a mixed ETH+USDC plan when the chain proves the feed missing', async () => {
    // Resolve the registered {ETH, base} pair, revert the two USDC pairs —
    // exactly today's deployed topology.
    const readContract = vi.fn(
      async ({ args }: { args: readonly [bigint, bigint, bigint, bigint] }) => {
        const currencies = [args[1], args[2]]
        if (currencies.includes(61_166n) && currencies.includes(1n)) return 1n
        throw feedNotFound()
      },
    )
    const result = await probeFeedReachability({
      accounting: ETH_USDC,
      issuanceBase: null,
      chains: [1],
      getClient: () => clientOf(readContract),
    })

    expect(result.status).toBe('missing')
    const message = feedReachabilityBlock(result, false)
    expect(message).toContain('ETH')
    expect(message).toContain('USDC')
    expect(message).toContain('Ethereum')
    // One probe per required pair: {61166,1}, {usdc,1}, {61166,usdc}.
    expect(readContract).toHaveBeenCalledTimes(3)
    // The probe asks for protocol DEFAULT feeds — project id 0 — matching
    // what a freshly launched project resolves at runtime.
    expect(
      readContract.mock.calls.every(([request]) => request.args[0] === 0n),
    ).toBe(true)
  })

  it('names every affected chain', async () => {
    const readContract = vi.fn(async () => {
      throw feedNotFound()
    })
    const result = await probeFeedReachability({
      accounting: ETH_USDC,
      issuanceBase: null,
      chains: [1, 8453],
      getClient: () => clientOf(readContract),
    })
    const message = feedReachabilityBlock(result, false)

    expect(message).toContain('Ethereum')
    expect(message).toContain('Base')
  })

  it('passes single-token plans when their one pair resolves', async () => {
    const readContract = vi.fn(async () => 10n ** 18n)
    const result = await probeFeedReachability({
      accounting: { tokens: ['eth'], custom: null },
      issuanceBase: null,
      chains: [1, 8453],
      getClient: () => clientOf(readContract),
    })

    expect(result).toEqual({ status: 'ok' })
    expect(feedReachabilityBlock(result, true)).toBeNull()
    // One pair ({61166,1}) per chain — nothing else probed.
    expect(readContract).toHaveBeenCalledTimes(2)
  })

  it('never probes custom-token plans: base equals the context currency', async () => {
    const getClient = vi.fn()
    const result = await probeFeedReachability({
      accounting: {
        tokens: [],
        custom: {
          address: '0x3333333333333333333333333333333333333333',
          decimals: 18,
        },
      },
      issuanceBase: null,
      chains: [1, 8453],
      getClient,
    })

    expect(result).toEqual({ status: 'ok' })
    expect(getClient).not.toHaveBeenCalled()
  })

  it('treats a read failure as "couldn\'t verify", not as a missing feed', async () => {
    const readContract = vi.fn(async () => {
      throw new Error('fetch failed')
    })
    const result = await probeFeedReachability({
      accounting: ETH_USDC,
      issuanceBase: null,
      chains: [1],
      getClient: () => clientOf(readContract),
    })

    expect(result.status).toBe('unavailable')
    expect(feedReachabilityBlock(result, false)).toBe(
      "Couldn't verify price feeds right now — Ethereum reads via juicebox.center were blocked before reaching the server — an ad blocker, browser shield, VPN, or DNS filter is the usual cause. Retry once it's reachable.",
    )
  })

  it('names a rate limit or timeout from juicebox.center', async () => {
    const probe = (error: Error) =>
      probeFeedReachability({
        accounting: ETH_USDC,
        issuanceBase: null,
        chains: [8453],
        getClient: () =>
          clientOf(
            vi.fn(async () => {
              throw error
            }),
          ),
      })
    expect(
      feedReachabilityBlock(
        await probe(new JBCenterRequestError('rate limited', 429)),
        false,
      ),
    ).toContain('Base reads via juicebox.center are rate-limited')
    expect(
      feedReachabilityBlock(await probe(new JBCenterTimeoutError(15_000)), false),
    ).toContain('Base reads via juicebox.center timed out')
    // viem wraps transport failures in ContractFunctionExecutionError → cause chain.
    const nested = new Error('outer', {
      cause: new Error('inner', { cause: new JBCenterRequestError('x', 502) }),
    })
    expect(feedReachabilityBlock(await probe(nested), false)).toContain(
      'failed with HTTP 502',
    )
  })

  it('still blocks — as unverifiable — when no client is available', async () => {
    const result = await probeFeedReachability({
      accounting: ETH_USDC,
      issuanceBase: null,
      chains: [1],
      getClient: () => null,
    })

    expect(result.status).toBe('unavailable')
  })

  it('prefers the definitive missing verdict over a concurrent read failure', async () => {
    let call = 0
    const readContract = vi.fn(async () => {
      call += 1
      if (call === 1) throw new Error('fetch failed')
      throw feedNotFound()
    })
    const result = await probeFeedReachability({
      accounting: ETH_USDC,
      issuanceBase: null,
      chains: [1],
      getClient: () => clientOf(readContract),
    })

    expect(result.status).toBe('missing')
  })
})

describe('feedReachabilityBlock', () => {
  it('returns null while the probe is still running', () => {
    expect(feedReachabilityBlock(null, false)).toBeNull()
  })

  it('is firm about permanence for revnets', () => {
    const message = feedReachabilityBlock(
      {
        status: 'missing',
        missing: [{ chainId: 1, aLabel: 'ETH', bLabel: 'USDC' }],
      },
      true,
    )
    expect(message).toContain('permanent')
    expect(message).toContain('never be fixed after launch')
  })

  it('collapses the same token pair reached through several currency pairs', () => {
    const message = feedReachabilityBlock(
      {
        status: 'missing',
        missing: [
          { chainId: 1, aLabel: 'USDC', bLabel: 'ETH' },
          { chainId: 1, aLabel: 'ETH', bLabel: 'USDC' },
        ],
      },
      false,
    )
    expect(message?.match(/Ethereum/g)).toHaveLength(1)
  })
})
