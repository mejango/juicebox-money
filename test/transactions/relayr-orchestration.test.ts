import type { Address, Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: undefined as Address | undefined,
  client: {
    readContract: vi.fn(),
    estimateGas: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
  wallet: { signTypedData: vi.fn(), sendTransaction: vi.fn() },
  getAccount: vi.fn(),
  connectedWallet: vi.fn(),
  requireReview: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({ getAccount: mocks.getAccount }))
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

import {
  relayrPay,
  relayrPoll,
  relayrPostBundle,
  runRelayrCalls,
  saveRelayrPendingSession,
  type RelayrCall,
  type RelayrPayment,
} from '@/lib/relayr'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const TARGET = '0x3333333333333333333333333333333333333333' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex
const DESTINATION_HASH = `0x${'cd'.repeat(32)}` as Hex
const payment: RelayrPayment = {
  chain: 1,
  amount: '100',
  calldata: '0x1234',
  target: TARGET,
}

function response(body: unknown, status = 200): Response {
  return new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

function localStorageWindow() {
  const values = new Map<string, string>()
  return {
    values,
    window: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    },
  }
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
  mocks.client.readContract.mockImplementation(async input => {
    if (input.functionName === 'eip712Domain') {
      return ['0x0f', 'JBForwarder', '1', 1n, TARGET, '0x00', []]
    }
    if (input.functionName === 'nonces') return 4n
    throw new Error(`Unexpected read ${input.functionName}`)
  })
  mocks.client.estimateGas.mockResolvedValue(21_000n)
  mocks.client.waitForTransactionReceipt.mockResolvedValue({ status: 'success' })
  mocks.wallet.signTypedData.mockResolvedValue(`0x${'11'.repeat(65)}`)
  mocks.wallet.sendTransaction.mockResolvedValue(HASH)
})

describe('Relayr quote and payment boundaries', () => {
  it('refuses to run or pay while view-as is active', async () => {
    setViewAs(TARGET)
    try {
      await expect(
        runRelayrCalls({
          calls: [{ chainId: 1, target: TARGET, data: '0x1234' }],
          account: ALICE,
        }),
      ).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
      expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      clearViewAs()
    }
  })


  it('assigns virtual nonces independently and preserves ordered calls', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce(
      response({ bundle_uuid: 'bundle', payment_info: [] }),
    )
    const entries = [
      { chain: 1, target: TARGET, data: '0x01' as Hex, value: '0' },
      { chain: 10, target: TARGET, data: '0x02' as Hex, value: '2' },
      { chain: 1, target: TARGET, data: '0x03' as Hex, value: '3' },
    ]

    await relayrPostBundle(entries)

    const init = fetchMock.mock.calls[0][1]!
    expect(JSON.parse(String(init.body))).toEqual({
      transactions: [
        { ...entries[0], virtual_nonce: 0 },
        { ...entries[1], virtual_nonce: 0 },
        { ...entries[2], virtual_nonce: 1 },
      ],
      virtual_nonce_mode: 'ChainIndependent',
    })
  })

  it('makes quote timeout explicitly safe to retry before payment', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(
      new DOMException('timed out', 'TimeoutError'),
    )

    await expect(relayrPostBundle([])).rejects.toThrow(
      /nothing was paid.*safe to try again/i,
    )
  })

  it('surfaces bounded Relayr HTTP detail', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response('bad quote', 503))
    await expect(relayrPostBundle([])).rejects.toThrow(
      'Relayr HTTP 503: bad quote',
    )
  })

  it('reviews, estimates, rechecks, sends, and confirms the exact payment', async () => {
    const submitted = vi.fn()

    await expect(relayrPay(payment, ALICE, submitted)).resolves.toBe(HASH)
    expect(mocks.requireReview).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [
          expect.objectContaining({
            chainId: 1,
            from: ALICE,
            to: TARGET,
            value: 100n,
            data: '0x1234',
          }),
        ],
      }),
    )
    expect(mocks.client.estimateGas).toHaveBeenCalledWith({
      account: ALICE,
      to: TARGET,
      value: 100n,
      data: '0x1234',
    })
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith({
      account: ALICE,
      to: TARGET,
      value: 100n,
      data: '0x1234',
    })
    expect(submitted).toHaveBeenCalledWith(HASH)
  })

  it('does not pay if the account changes after estimation', async () => {
    mocks.client.estimateGas.mockImplementationOnce(async () => {
      mocks.account = BOB
      return 21_000n
    })

    await expect(relayrPay(payment, ALICE)).rejects.toThrow(/account changed/i)
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('returns a submitted error with the real hash when receipt lookup fails', async () => {
    mocks.client.waitForTransactionReceipt.mockRejectedValueOnce(
      new Error('RPC unavailable'),
    )

    await expect(relayrPay(payment, ALICE)).rejects.toEqual(
      expect.objectContaining({
        name: 'RelayrPaymentSubmittedError',
        hash: HASH,
        chainId: 1,
      }),
    )
  })

  it.each([
    [{ ...payment, chain: 999 }, /unsupported payment chain/i],
    [{ ...payment, target: 'not-an-address' as Address }, /invalid payment target/i],
    [{ ...payment, calldata: '0xxyz' as Hex }, /invalid payment calldata/i],
    [{ ...payment, amount: '-1' }, /invalid payment amount/i],
    [
      { ...payment, payment_deadline: Math.floor(Date.now() / 1000) + 10 },
      /quote expired/i,
    ],
  ])('rejects an unsafe quote before review', async (unsafe, message) => {
    await expect(relayrPay(unsafe, ALICE)).rejects.toThrow(message)
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('re-checks the payment deadline after review, not only before it', async () => {
    // The review has no time limit; a quote that was live when it opened can
    // be dead by the time it is approved.
    const start = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(start)
    mocks.requireReview.mockImplementationOnce(async () => {
      now.mockReturnValue(start + 120_000)
    })

    await expect(
      relayrPay(
        { ...payment, payment_deadline: Math.floor(start / 1000) + 60 },
        ALICE,
      ),
    ).rejects.toThrow(/quote expired/i)
    expect(mocks.requireReview).toHaveBeenCalledTimes(1)
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    now.mockRestore()
  })
})

describe('Relayr polling and resume semantics', () => {
  it('polls through pending status and returns only at terminal success', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response({ transactions: [{ status: { state: 'submitted' } }] }),
      )
      .mockResolvedValueOnce(
        response({
          transactions: [
            {
              status: {
                state: 'completed',
                data: { hash: DESTINATION_HASH },
              },
            },
          ],
        }),
      )
    const updates = vi.fn()

    await expect(relayrPoll('bundle', updates, 0, 1_000)).resolves.toEqual([
      expect.objectContaining({ status: expect.objectContaining({ state: 'completed' }) }),
    ])
    expect(updates).toHaveBeenCalledTimes(2)
  })

  it('turns a failed destination into a non-retryable terminal error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      response({ transactions: [{ status: { state: 'failed' } }] }),
    )

    await expect(relayrPoll('bundle', undefined, 0, 1_000)).rejects.toEqual(
      expect.objectContaining({
        name: 'RelayrExecutionError',
        code: 'RELAYR_FAILED',
        retryable: false,
      }),
    )
  })

  it('treats a persistently unknown bundle as a distinct non-retryable outcome', async () => {
    // 404 means Relayr never had this uuid — the "still processing, do not
    // submit again" timeout would tell the user to wait on nothing.
    vi.mocked(fetch).mockResolvedValue(response({ error: 'not found' }, 404))

    await expect(relayrPoll('bundle', undefined, 0, 60_000)).rejects.toEqual(
      expect.objectContaining({
        name: 'RelayrExecutionError',
        code: 'RELAYR_NOT_FOUND',
        retryable: false,
      }),
    )
  })

  it('does not treat a single 404 blip as terminal', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ error: 'not found' }, 404))
      .mockResolvedValueOnce(
        response({
          transactions: [
            { status: { state: 'completed', data: { hash: DESTINATION_HASH } } },
          ],
        }),
      )

    await expect(relayrPoll('bundle', undefined, 0, 60_000)).resolves.toEqual([
      expect.objectContaining({
        status: expect.objectContaining({ state: 'completed' }),
      }),
    ])
  })

  it('times out as uncertain because a paid bundle can still execute', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))

    await expect(relayrPoll('bundle', undefined, 0, -1)).rejects.toEqual(
      expect.objectContaining({
        name: 'RelayrExecutionError',
        code: 'RELAYR_TIMEOUT',
        retryable: true,
      }),
    )
  })

  it('resumes an already successful paid bundle without signing or paying again', async () => {
    const storage = localStorageWindow()
    vi.stubGlobal('window', storage.window)
    saveRelayrPendingSession('scope', {
      bundleUuid: 'saved-bundle',
      paymentHash: HASH,
      paymentChainId: 1,
      paymentStatus: 'confirmed',
      chainIds: [1],
      expectedCount: 1,
      records: [{ chain: 1, status: { state: 'success' } }],
      itemCount: 1,
      account: ALICE,
      createdAt: 1,
    })

    await expect(
      runRelayrCalls({
        calls: [{ chainId: 1, target: TARGET, data: '0x1234' }],
        account: ALICE,
        pendingScope: 'scope',
      }),
    ).resolves.toMatchObject({
      paymentHash: HASH,
      records: [{ status: { state: 'success' } }],
    })
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(storage.values.size).toBe(0)
  })

  it('refuses to resume a paid bundle from a different account', async () => {
    const storage = localStorageWindow()
    vi.stubGlobal('window', storage.window)
    saveRelayrPendingSession('scope', {
      bundleUuid: 'saved-bundle',
      paymentHash: HASH,
      paymentChainId: 1,
      paymentStatus: 'submitted',
      chainIds: [1],
      expectedCount: 1,
      records: [],
      itemCount: 1,
      account: BOB,
      createdAt: 1,
    })

    await expect(
      runRelayrCalls({
        calls: [{ chainId: 1, target: TARGET, data: '0x1234' }],
        account: ALICE,
        pendingScope: 'scope',
      }),
    ).rejects.toThrow(`Switch back to ${BOB}`)
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('signs every exact destination, pays once, and waits for execution', async () => {
    const storage = localStorageWindow()
    vi.stubGlobal('window', storage.window)
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/bundle/prepaid') && init?.method === 'POST') {
        return response({
          bundle_uuid: 'new-bundle',
          payment_info: [payment],
          transactions: [],
        })
      }
      if (url.endsWith('/v1/bundle/new-bundle')) {
        return response({
          transactions: [
            { chain: 1, status: { state: 'success', data: { hash: DESTINATION_HASH } } },
          ],
        })
      }
      throw new Error(`Unexpected Relayr request: ${url}`)
    })
    const progress = vi.fn()
    const calls: RelayrCall[] = [
      {
        chainId: 1,
        target: TARGET,
        data: '0x1234',
        value: 5n,
        label: 'Exact destination',
      },
    ]

    await expect(
      runRelayrCalls({
        calls,
        account: ALICE,
        pendingScope: 'fresh',
        onProgress: progress,
      }),
    ).resolves.toMatchObject({
      paymentHash: HASH,
      records: [{ status: { state: 'success' } }],
    })
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(1)
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.requireReview).toHaveBeenCalledTimes(2)
    expect(progress.mock.calls.map(call => call[0].phase)).toEqual([
      'signing',
      'quoting',
      'paying',
      'payment-submitted',
      'payment-confirmed',
      'executing',
    ])
    expect(storage.values.size).toBe(0)
  })
})
