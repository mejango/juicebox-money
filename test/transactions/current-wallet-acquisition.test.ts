import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config, Connector } from '@wagmi/core'
import { mainnet, optimism } from 'viem/chains'
import { currentWalletAdapter } from '@/lib/current-wallet'
import { clearViewAs } from '@/lib/viewAs'
import { type WalletAdapter, submitReviewedContractWrite, signReviewed, registerReviewHandler, ReviewLineError } from '@bananapus/nana-sdk-core/review'

const ALICE = '0x1111111111111111111111111111111111111111' as const
const BOB = '0x2222222222222222222222222222222222222222' as const
const HASH = `0x${'12'.repeat(32)}` as `0x${string}`
const typedData = { domain: { name: 'Test', chainId: 1 }, primaryType: 'Thing', types: { Thing: [{ name: 'value', type: 'uint256' }] }, message: { value: 1n } } as const
beforeEach(clearViewAs)

function harness(at: 'chain' | 'provider' = 'provider') {
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const requests: string[] = []
  const state = { safe: false, failure: undefined as Error | undefined }
  const connector = (id: string, hold = false) => ({
    id, uid: id,
    getAccounts: async () => [ALICE],
    getChainId: async () => { if (hold && at === 'chain') { entered(); await blocked } return 1 },
    getProvider: async () => {
      if (hold && at === 'provider') { entered(); await blocked }
      return { request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0x1'
        requests.push(`${id}:${method}`)
        if (state.failure) throw state.failure
        return method === 'wallet_sendCalls' ? { id: HASH } : HASH
      } }
    },
  } as unknown as Connector)
  const old = connector('old', true), current = connector('current')
  const connection = { accounts: [ALICE] as readonly `0x${string}`[], chainId: 1, connector: old }
  const config = { chains: [mainnet, optimism], state: { current: 'old', status: 'connected', connections: new Map([
    ['old', connection], ['current', { ...connection, connector: current }],
  ]) } } as unknown as Config
  return { config, connection, state, requests, waiting, release, adapter: currentWalletAdapter(config, () => state.safe) }
}

const run = (adapter: WalletAdapter, kind: string) => kind === 'send'
  ? adapter.sendTransaction({ chainId: 1, to: ALICE, data: '0x', value: 0n, gas: 21000n })
  : kind === 'typed' ? adapter.signTypedData(typedData)
    : kind === 'message' ? adapter.signMessage('gm')
      : adapter.sendCalls!(1, [{ to: ALICE, data: '0x', value: 0n }])

describe('actual wagmi connector acquisition', () => {
  it.each(['chain', 'provider'] as const)('reacquires the current connector after awaited %s resolution', async at => {
    const h = harness(at)
    const pending = run(h.adapter, 'send')
    await h.waiting
    h.config.state.current = 'current'
    h.release()
    await pending
    expect(h.requests).toEqual(['current:eth_sendTransaction'])
  })
  it.each(['typed', 'message', 'batch'])('invokes current connector for %s', async kind => {
    const h = harness()
    const pending = run(h.adapter, kind)
    await h.waiting; h.config.state.current = 'current'; h.release()
    await pending
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]).toMatch(/^current:/)
  })
  it('rechecks only the owning operation payload after held acquisition', async () => {
    const h = harness()
    let expired = false, otherChecks = 0
    const guarded = h.adapter.withFinalCheck(() => { if (expired) throw new ReviewLineError('The reviewed quote expired. Review again.') })
    const independent = h.adapter.withFinalCheck(() => { otherChecks++ })
    const first = run(guarded, 'send').catch(error => error)
    const second = run(independent, 'send')
    await h.waiting; expired = true; h.release()
    expect(await first).toMatchObject({ message: 'The reviewed quote expired. Review again.', walletNotInvoked: true, code: 4001 })
    await second
    expect(otherChecks).toBe(1)
    expect(h.requests).toEqual(['old:eth_sendTransaction'])
  })
  it.each(['account', 'chain', 'route'] as const)('refuses %s drift before any actual wallet request', async change => {
    const h = harness()
    const pending = run(h.adapter, 'send').catch(error => error)
    await h.waiting
    if (change === 'account') h.connection.accounts = [BOB]
    if (change === 'chain') h.connection.chainId = 10
    if (change === 'route') h.state.safe = true
    h.release()
    expect(await pending).toMatchObject({ walletNotInvoked: true, code: 4001 })
    expect(h.requests).toEqual([])
  })
  it('preserves a useful signature refusal line without cancellation classification', async () => {
    const h = harness()
    const pending = run(h.adapter, 'typed').catch(error => error)
    await h.waiting; h.state.safe = true; h.release()
    const error = await pending
    expect(error.message).toContain('Wallet connection changed')
    expect(error.code).toBeUndefined()
    expect(h.requests).toEqual([])
  })
  it.each(['typed', 'message'])('actual SDK signReviewed preserves %s acquisition refusal', async kind => {
    const h = harness()
    const unregister = registerReviewHandler(async prompt => prompt.confirmation)
    const signature = kind === 'typed'
      ? { kind: 'safe-tx' as const, chainId: 1, safe: BOB, tx: { to: ALICE, data: '0x' as const, value: '0', operation: 0, nonce: 7, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: '0x0000000000000000000000000000000000000000' as const, refundReceiver: '0x0000000000000000000000000000000000000000' as const, confirmations: [] } }
      : { kind: 'message' as const, chainId: 1, message: 'gm' }
    try {
      const pending = signReviewed([signature], { account: ALICE }, { adapter: h.adapter }).catch(error => error)
      await h.waiting; h.state.safe = true; h.release()
      const error = await pending
      expect(error).toBeInstanceOf(ReviewLineError)
      expect(error.message).toContain('Wallet connection changed')
      expect(error.name).not.toBe('TransactionReviewCancelledError')
      expect(error.code).toBeUndefined()
      expect(h.requests).toEqual([])
    } finally { unregister() }
  })
  it.each([false, true])('actual SDK cleanup distinguishes actual wallet invocation=%s', async invoked => {
    const h = harness()
    const rejected = vi.fn(), uncertain = vi.fn()
    const pending = submitReviewedContractWrite({
      request: { chainId: 1, to: ALICE, data: '0x', value: 0n }, expectedAccount: ALICE,
      currentAccount: () => ALICE, review: async () => {}, switchChain: async () => {}, simulate: async request => request,
      beforeWrite: async () => {}, onWriteRejected: rejected, onWriteUncertain: uncertain,
      write: () => run(h.adapter, 'send'),
    }).catch(error => error)
    await h.waiting
    if (invoked) h.state.failure = new Error('Wallet transport lost')
    else h.state.safe = true
    h.release()
    const error = await pending
    if (invoked) {
      expect(error.message).toContain('Wallet transport lost')
      expect(error.walletNotInvoked).toBeUndefined()
      expect(rejected).not.toHaveBeenCalled()
      expect(uncertain).toHaveBeenCalledOnce()
    } else {
      expect(error.walletNotInvoked).toBe(true)
      expect(rejected).toHaveBeenCalledOnce()
      expect(uncertain).not.toHaveBeenCalled()
    }
  })
})
