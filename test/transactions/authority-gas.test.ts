import type { Address, Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: undefined as Address | undefined,
  client: {
    call: vi.fn(),
    estimateGas: vi.fn(),
    readContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
  wallet: { signTypedData: vi.fn(), sendTransaction: vi.fn() },
  getAccount: vi.fn(),
  connectedWallet: vi.fn(),
  requireReview: vi.fn(),
  fetchSafeInfo: vi.fn(),
  runSafeCalls: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({
  getAccount: mocks.getAccount,
  getPublicClient: () => mocks.client,
}))
vi.mock('@/providers/Providers', () => ({
  wagmiConfig: {},
  SUPPORTED_CHAINS: [
    { id: 1, name: 'Ethereum' },
    { id: 10, name: 'Optimism' },
  ],
}))
vi.mock('@/lib/wallet-core', () => ({
  publicClient: () => mocks.client,
  connectedWallet: mocks.connectedWallet,
}))
vi.mock('@/lib/transaction-review', () => ({
  requireTransactionReview: mocks.requireReview,
}))
vi.mock('@/lib/safe', () => ({
  fetchSafeInfo: mocks.fetchSafeInfo,
  runSafeCalls: mocks.runSafeCalls,
}))

import { runAuthorityCalls, type AuthorityCall } from '@/lib/authority'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x3333333333333333333333333333333333333333' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex
const DESTINATION_HASH = `0x${'cd'.repeat(32)}` as Hex

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  mocks.account = ALICE
  mocks.getAccount.mockImplementation(() => ({
    address: mocks.account,
    chainId: 1,
  }))
  mocks.connectedWallet.mockResolvedValue({
    wallet: mocks.wallet,
    account: ALICE,
  })
  mocks.requireReview.mockResolvedValue(undefined)
  mocks.fetchSafeInfo.mockResolvedValue(null)
  mocks.client.call.mockResolvedValue({ data: '0x' })
  mocks.client.readContract.mockImplementation(async input => {
    if (input.functionName === 'eip712Domain') {
      return ['0x0f', 'JBForwarder', '1', 1n, TARGET, '0x00', []]
    }
    if (input.functionName === 'nonces') return 4n
    throw new Error(`Unexpected read ${input.functionName}`)
  })
  mocks.client.waitForTransactionReceipt.mockResolvedValue({ status: 'success' })
  mocks.wallet.signTypedData.mockResolvedValue(`0x${'11'.repeat(65)}`)
  mocks.wallet.sendTransaction.mockResolvedValue(HASH)
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/bundle/prepaid') && init?.method === 'POST') {
      return response({
        bundle_uuid: 'bundle',
        payment_info: [
          { chain: 1, amount: '100', calldata: '0x1234', target: TARGET },
        ],
        transactions: [],
      })
    }
    if (url.endsWith('/v1/bundle/bundle')) {
      return response({
        transactions: [
          { chain: 1, status: { state: 'success', data: { hash: DESTINATION_HASH } } },
          { chain: 10, status: { state: 'success', data: { hash: DESTINATION_HASH } } },
        ],
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
})

describe('Authority gas estimation reaches the signed Relayr request', () => {
  it('signs each ForwardRequest with the measured 2x estimate, not the 500k fallback', async () => {
    // A forwarded call that needs more than the 500k fallback: the OZ
    // forwarder caps the inner call at request.gas and reverts execute() when
    // the inner call runs out — AFTER the user paid Relayr for the bundle.
    mocks.client.estimateGas
      .mockResolvedValueOnce(800_000n) // chain 1 destination estimate
      .mockResolvedValueOnce(600_000n) // chain 10 destination estimate
      .mockResolvedValue(21_000n) // Relayr payment estimate

    const calls: AuthorityCall[] = [
      { chainId: 1, authority: ALICE, target: TARGET, data: '0x1234' },
      { chainId: 10, authority: ALICE, target: TARGET, data: '0x5678' },
    ]
    const result = await runAuthorityCalls({ calls })

    expect(result.relayrGroups).toBe(1)
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(2)
    const signedGas = mocks.wallet.signTypedData.mock.calls.map(
      ([{ message }]) => message.gas,
    )
    expect(signedGas).toEqual([1_600_000n, 1_200_000n])
  })

  it('keeps a builder-pinned gas value instead of re-estimating it', async () => {
    mocks.client.estimateGas.mockResolvedValue(21_000n)

    const calls: AuthorityCall[] = [
      { chainId: 1, authority: ALICE, target: TARGET, data: '0x1234', gas: 300_000n },
      { chainId: 10, authority: ALICE, target: TARGET, data: '0x5678', gas: 250_000n },
    ]
    await runAuthorityCalls({ calls })

    const signedGas = mocks.wallet.signTypedData.mock.calls.map(
      ([{ message }]) => message.gas,
    )
    expect(signedGas).toEqual([300_000n, 250_000n])
  })

  it('falls back to 500k only when estimation itself fails', async () => {
    mocks.client.estimateGas
      .mockRejectedValueOnce(new Error('cannot estimate'))
      .mockRejectedValueOnce(new Error('cannot estimate'))
      .mockResolvedValue(21_000n)

    const calls: AuthorityCall[] = [
      { chainId: 1, authority: ALICE, target: TARGET, data: '0x1234' },
      { chainId: 10, authority: ALICE, target: TARGET, data: '0x5678' },
    ]
    await runAuthorityCalls({ calls })

    const signedGas = mocks.wallet.signTypedData.mock.calls.map(
      ([{ message }]) => message.gas,
    )
    expect(signedGas).toEqual([500_000n, 500_000n])
  })
})
