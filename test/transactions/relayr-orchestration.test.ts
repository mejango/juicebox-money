import { encodeFunctionData, toFunctionSelector, type Address, type Hex } from 'viem'
import { erc2771ForwarderAbi, jbContractAddress, JBCoreContracts, type JBChainId } from '@bananapus/nana-sdk-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: undefined as Address | undefined,
  client: {
    readContract: vi.fn(),
    request: vi.fn(),
    estimateGas: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getTransaction: vi.fn(),
    getTransactionReceipt: vi.fn(),
    getBlock: vi.fn(),
  },
  wallet: { signTypedData: vi.fn(), sendTransaction: vi.fn() },
  getAccount: vi.fn(),
  connectedWallet: vi.fn(),
  requireReview: vi.fn(),
  requireFundingChainSelection: vi.fn(),
  isSafeConnection: vi.fn(),
  waitForSafeExecutionHash: vi.fn(),
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
  requireFundingChainSelection: mocks.requireFundingChainSelection,
}))
vi.mock('@/lib/safe-connector', () => ({
  isSafeConnection: mocks.isSafeConnection,
  waitForSafeExecutionHash: mocks.waitForSafeExecutionHash,
  SAFE_NONCE_GUIDANCE: 'Choose the correct Safe nonce.',
}))

import {
  RELAYR_NATIVE_TOKEN,
  RELAYR_PAYMENT_ADDRESS,
  RELAYR_PAYMENT_CODE_HASH,
  RELAYR_PAYMENT_SELECTOR,
  relayrPay,
  relayrPaymentDetails,
  relayrPoll,
  relayrPostBundle,
  runRelayrCalls,
  saveRelayrPendingSession,
  loadRelayrPendingSession,
  listRelayrPendingScopes,
  clearRelayrPendingSession,
  type RelayrCall,
  type RelayrEntry,
  type RelayrPayment,
} from '@/lib/relayr'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const TARGET = '0x3333333333333333333333333333333333333333' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex
const DESTINATION_HASH = `0x${'cd'.repeat(32)}` as Hex
const SECOND_DESTINATION_HASH = `0x${'ef'.repeat(32)}` as Hex
const BLOCK_HASH = `0x${'45'.repeat(32)}` as Hex
const TRUSTED_FORWARDER_SELECTOR = toFunctionSelector('isTrustedForwarder(address)')
const BUNDLE_UUID = '01234567-89ab-cdef-0123-456789abcdef'
const OTHER_UUID = 'fedcba98-7654-3210-fedc-ba9876543210'
const THIRD_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const PAYMENT_DEADLINE = 4_000_000_000
const PAYMENT_RUNTIME = '0x608060405260043610156010575f80fd5b5f3560e01c63103903a7146022575f80fd5b604036600319011260ef576004356fffffffffffffffffffffffffffffffff19811680910360ef5760243564ffffffffff811680910360ef5780421160ce575f341560c6575b5f8080809373755ff2f75a0a586ecfa2b9a3c959cb662458a1053491f11560bb5760407fb96b060a9c075a83da0cf1f9405deeb5df21df681a762de16c3d5eaf99531cd8918151903482526020820152a2005b6040513d5f823e3d90fd5b506108fc6068565b90630f01bd8760e21b5f5260045260245264ffffffffff421660445260645ffd5b5f80fdfea26469706673582212206ea0d2ba1e0cb26cc9293b24f1a7aecc1de7e328ca83d6b3bf5382ac44c7390064736f6c634300081a0033' as Hex

function paymentCalldata(
  uuid = BUNDLE_UUID,
  deadline = PAYMENT_DEADLINE,
  selector = RELAYR_PAYMENT_SELECTOR,
): Hex {
  const uuidWord = uuid.replaceAll('-', '').toLowerCase().padEnd(64, '0')
  const deadlineWord = BigInt(deadline).toString(16).padStart(64, '0')
  return `${selector}${uuidWord}${deadlineWord}` as Hex
}

function paymentFor(
  overrides: Partial<RelayrPayment> = {},
  deadline = PAYMENT_DEADLINE,
): RelayrPayment {
  return {
    chain: 1,
    amount: '100',
    calldata: paymentCalldata(BUNDLE_UUID, deadline),
    target: RELAYR_PAYMENT_ADDRESS,
    token: RELAYR_NATIVE_TOKEN,
    payment_deadline: deadline,
    ...overrides,
  }
}

const payment = paymentFor()

function signedEntry(chain: JBChainId = 1): RelayrEntry {
  return {
    chain,
    target: jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][chain],
    data: encodeFunctionData({
      abi: erc2771ForwarderAbi,
      functionName: 'execute',
      args: [{ from: ALICE, to: TARGET, value: 5n, gas: 500_000n,
        deadline: PAYMENT_DEADLINE, data: '0x1234', signature: `0x${'11'.repeat(65)}` }],
    }),
    value: '5',
    virtual_nonce: 0,
  }
}

function successfulRecords(entries: readonly RelayrEntry[]) {
  return entries.map((entry, index) => ({
    tx_uuid: [OTHER_UUID, THIRD_UUID][index],
    request: entry,
    status: { state: 'success', data: { hash: [DESTINATION_HASH, SECOND_DESTINATION_HASH][index] } },
  }))
}

/** Destination RPC proof is derived from the exact signed payload sent in POST. */
function installDestinationProof(entries: () => readonly RelayrEntry[]) {
  mocks.client.getTransaction.mockImplementation(async ({ hash }) => {
    const entry = entries()[hash === DESTINATION_HASH ? 0 : 1]
    if (!entry) throw new Error(`No destination transaction fixture for ${hash}`)
    return { hash, to: entry.target, input: entry.data, value: BigInt(entry.value),
      chainId: entry.chain, blockHash: BLOCK_HASH }
  })
  mocks.client.getTransactionReceipt.mockImplementation(async ({ hash }) => ({
    transactionHash: hash, status: 'success', blockHash: BLOCK_HASH, blockNumber: 100n,
  }))
  mocks.client.getBlock.mockResolvedValue({ hash: BLOCK_HASH })
}

function installSuccessfulBundle(payments = [payment]) {
  const posts: RelayrEntry[][] = []
  installDestinationProof(() => posts.at(-1) ?? [])
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/bundle/prepaid') && init?.method === 'POST') {
      const entries = (JSON.parse(String(init.body)) as { transactions: RelayrEntry[] }).transactions
      posts.push(entries)
      return response({ bundle_uuid: BUNDLE_UUID, payment_info: payments,
        txn_uuids: entries.map((_, index) => [OTHER_UUID, THIRD_UUID][index]) })
    }
    if (url.endsWith(`/v1/bundle/${BUNDLE_UUID}`)) {
      return response({ transactions: successfulRecords(posts.at(-1) ?? []) })
    }
    throw new Error(`Unexpected Relayr request: ${url}`)
  })
  return posts
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
        get length() { return values.size },
        key: (index: number) => [...values.keys()][index] ?? null,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value) },
        removeItem: (key: string) => values.delete(key),
      },
    },
  }
}

beforeEach(() => {
  for (const scope of listRelayrPendingScopes()) clearRelayrPendingSession(scope)
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, execute: (lock: object) => Promise<unknown>) => execute({}) } })
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
  mocks.requireFundingChainSelection.mockResolvedValue(1)
  mocks.isSafeConnection.mockReturnValue(false)
  mocks.waitForSafeExecutionHash.mockResolvedValue(HASH)
  mocks.client.readContract.mockImplementation(async input => {
    if (input.functionName === 'eip712Domain') {
      return ['0x0f', 'JBForwarder', '1', 1n, TARGET, '0x00', []]
    }
    if (input.functionName === 'nonces') return 4n
    if (input.functionName === 'verify') return true
    throw new Error(`Unexpected read ${input.functionName}`)
  })
  mocks.client.estimateGas.mockResolvedValue(21_000n)
  mocks.client.request.mockImplementation(async ({ method, params }) => {
    if (method === 'eth_getCode') return PAYMENT_RUNTIME
    if (method === 'eth_call') {
      return params[0].data.startsWith(TRUSTED_FORWARDER_SELECTOR)
        ? `0x${'0'.repeat(63)}1` : '0x'
    }
    throw new Error(`Unexpected RPC method ${method}`)
  })
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
      response({
        bundle_uuid: BUNDLE_UUID,
        payment_info: [],
        txn_uuids: [BUNDLE_UUID, OTHER_UUID, THIRD_UUID],
      }),
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

  it('requires a unique Relayr transaction ID for every quoted entry', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      response({ bundle_uuid: BUNDLE_UUID, payment_info: [] }),
    )

    await expect(
      relayrPostBundle([
        { chain: 1, target: TARGET, data: '0x01', value: '0' },
      ]),
    ).rejects.toThrow(/unique ID/i)
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

  it('authenticates, reviews, simulates, rechecks, sends, and confirms the exact payment', async () => {
    const submitted = vi.fn()
    const reverify = vi.fn().mockResolvedValue(undefined)

    await expect(
      relayrPay(payment, ALICE, BUNDLE_UUID, submitted, reverify),
    ).resolves.toBe(HASH)
    expect(mocks.requireReview).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [
          expect.objectContaining({
            chainId: 1,
            from: ALICE,
            to: RELAYR_PAYMENT_ADDRESS,
            value: 100n,
            data: payment.calldata,
          }),
        ],
      }),
    )
    expect(mocks.client.request).toHaveBeenCalledWith({
      method: 'eth_call',
      params: [
        {
          from: ALICE,
          to: RELAYR_PAYMENT_ADDRESS,
          value: '0x64',
          data: payment.calldata,
          gas: '0x249f0',
        },
        'latest',
      ],
    })
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith({
      account: ALICE,
      to: RELAYR_PAYMENT_ADDRESS,
      value: 100n,
      data: payment.calldata,
      gas: 150_000n,
    })
    expect(submitted).toHaveBeenCalledWith(HASH)
    expect(reverify).toHaveBeenCalledTimes(3)
  })

  it('does not pay if the account changes after bounded simulation', async () => {
    mocks.client.request.mockImplementation(async ({ method }) => {
      if (method === 'eth_getCode') return PAYMENT_RUNTIME
      if (method === 'eth_call') {
        mocks.account = BOB
        return '0x'
      }
      throw new Error(`Unexpected RPC method ${method}`)
    })

    await expect(relayrPay(payment, ALICE, BUNDLE_UUID)).rejects.toThrow(/account changed/i)
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('returns a submitted error with the real hash when receipt lookup fails', async () => {
    mocks.client.waitForTransactionReceipt.mockRejectedValueOnce(
      new Error('RPC unavailable'),
    )

    await expect(relayrPay(payment, ALICE, BUNDLE_UUID)).rejects.toEqual(
      expect.objectContaining({
        name: 'RelayrPaymentSubmittedError',
        hash: HASH,
        chainId: 1,
      }),
    )
  })

  it('keeps a Safe payment uncertain when execution-hash tracking fails', async () => {
    mocks.isSafeConnection.mockReturnValue(true)
    mocks.waitForSafeExecutionHash.mockRejectedValueOnce(
      new Error('Safe proposal tracking unavailable'),
    )
    const submitted = vi.fn()

    await expect(
      relayrPay(payment, ALICE, BUNDLE_UUID, submitted),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'RelayrPaymentSubmittedError',
        hash: HASH,
        chainId: 1,
      }),
    )
    expect(submitted).toHaveBeenCalledWith(HASH)
    expect(mocks.client.waitForTransactionReceipt).not.toHaveBeenCalled()
  })

  it('treats a post-send persistence callback failure as submitted', async () => {
    await expect(
      relayrPay(payment, ALICE, BUNDLE_UUID, () => {
        throw new Error('storage callback failed')
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'RelayrPaymentSubmittedError',
        hash: HASH,
      }),
    )
    expect(mocks.client.waitForTransactionReceipt).not.toHaveBeenCalled()
  })

  it.each([
    [{ ...payment, chain: 999 }, /unsupported payment chain/i],
    [{ ...payment, target: 'not-an-address' as Address }, /unrecognized payment contract/i],
    [{ ...payment, target: TARGET }, /unrecognized payment contract/i],
    [{ ...payment, token: TARGET }, /unsupported payment token/i],
    [{ ...payment, calldata: '0xxyz' as Hex }, /invalid payment calldata/i],
    [{ ...payment, amount: '-1' }, /invalid payment amount/i],
    [
      paymentFor({}, Math.floor(Date.now() / 1000) + 10),
      /quote expired/i,
    ],
  ])('rejects an unsafe quote before review', async (unsafe, message) => {
    await expect(relayrPay(unsafe, ALICE, BUNDLE_UUID)).rejects.toThrow(message)
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
        paymentFor({}, Math.floor(start / 1000) + 60),
        ALICE,
        BUNDLE_UUID,
      ),
    ).rejects.toThrow(/quote expired/i)
    expect(mocks.requireReview).toHaveBeenCalledTimes(1)
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    now.mockRestore()
  })

  it('binds the payment selector, bundle UUID, deadline, and runtime', async () => {
    expect(relayrPaymentDetails(payment, BUNDLE_UUID)).toMatchObject({
      target: RELAYR_PAYMENT_ADDRESS,
      bundleUuid: BUNDLE_UUID,
      amount: 100n,
      deadline: BigInt(PAYMENT_DEADLINE),
    })
    expect(() => relayrPaymentDetails(payment, OTHER_UUID)).toThrow(
      /does not match this bundle/i,
    )
    expect(() =>
      relayrPaymentDetails(
        { ...payment, calldata: paymentCalldata(BUNDLE_UUID, PAYMENT_DEADLINE, '0xdeadbeef') },
        BUNDLE_UUID,
      ),
    ).toThrow(/unrecognized payment function/i)

    mocks.client.request.mockResolvedValueOnce('0x6000')
    await expect(relayrPay(payment, ALICE, BUNDLE_UUID)).rejects.toThrow(
      /code is not recognized/i,
    )
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(RELAYR_PAYMENT_CODE_HASH).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('Relayr polling and resume semantics', () => {
  it('does not accept a partial all-success status response', async () => {
    const complete = {
      status: { state: 'completed', data: { hash: DESTINATION_HASH } },
    }
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ transactions: [complete] }))
      .mockResolvedValueOnce(
        response({ transactions: [complete, complete] }),
      )

    await expect(
      relayrPoll('bundle-two', 2, undefined, 0, 1_000),
    ).resolves.toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not accept an over-count all-success status response', async () => {
    const complete = { status: { state: 'completed' } }
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response({ transactions: [complete, complete, complete] }),
      )
      .mockResolvedValueOnce(response({ transactions: [complete, complete] }))

    await expect(
      relayrPoll('bundle-two-exact', 2, undefined, 0, 1_000),
    ).resolves.toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retains an in-memory paid session when localStorage fails', () => {
    const scope = 'memory-only-paid-session'
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('storage blocked')
        },
        setItem: () => {
          throw new Error('storage blocked')
        },
        removeItem: () => {
          throw new Error('storage blocked')
        },
      },
    })
    const session = saveRelayrPendingSession(scope, {
      bundleUuid: 'paid-bundle',
      paymentHash: HASH,
      paymentChainId: 1,
      paymentStatus: 'submitted',
      chainIds: [1],
      expectedCount: 1,
      records: [],
      itemCount: 1,
      account: ALICE,
      createdAt: Date.now(),
    })
    expect(loadRelayrPendingSession(scope)).toEqual(session)
    clearRelayrPendingSession(scope)
  })

  it('keeps a newer memory receipt ahead of stale disk and failed removal', () => {
    const scope = 'stale-disk-paid-session'
    const stale = {
      bundleUuid: 'stale-bundle',
      paymentHash: null,
      paymentChainId: 1,
      paymentStatus: 'confirmed',
      chainIds: [1],
      expectedCount: 1,
      records: [],
      itemCount: 1,
      account: ALICE,
      createdAt: 1,
    }
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => JSON.stringify(stale),
        setItem: () => {
          throw new Error('storage full')
        },
        removeItem: () => {
          throw new Error('storage blocked')
        },
      },
    })
    const fresh = saveRelayrPendingSession(scope, {
      ...stale,
      bundleUuid: 'fresh-bundle',
      paymentHash: HASH,
      paymentStatus: 'submitted',
      createdAt: 2,
    })
    expect(loadRelayrPendingSession(scope)).toEqual(fresh)
    clearRelayrPendingSession(scope)
    expect(loadRelayrPendingSession(scope)).toBeNull()
  })

  it('sanitizes malformed quote records before persisting a submitted receipt', () => {
    const scope = 'malformed-record-session'
    const storage = localStorageWindow()
    vi.stubGlobal('window', storage.window)
    const saved = saveRelayrPendingSession(scope, {
      bundleUuid: 'bundle',
      paymentHash: HASH,
      paymentChainId: 1,
      paymentStatus: 'submitted',
      chainIds: [1],
      expectedCount: 1,
      records: [null as never],
      itemCount: 1,
      account: ALICE,
      createdAt: 1,
    })
    expect(saved.records).toEqual([])
    expect(loadRelayrPendingSession(scope)?.paymentHash).toBe(HASH)
    clearRelayrPendingSession(scope)
  })

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

    await expect(relayrPoll('bundle', 1, updates, 0, 1_000)).resolves.toEqual([
      expect.objectContaining({ status: expect.objectContaining({ state: 'completed' }) }),
    ])
    expect(updates).toHaveBeenCalledTimes(2)
  })

  it('turns a failed destination into a non-retryable terminal error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      response({ transactions: [{ status: { state: 'failed' } }] }),
    )

    await expect(relayrPoll('bundle', 1, undefined, 0, 1_000)).rejects.toEqual(
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

    await expect(relayrPoll('bundle', 1, undefined, 0, 60_000)).rejects.toEqual(
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

    await expect(relayrPoll('bundle', 1, undefined, 0, 60_000)).resolves.toEqual([
      expect.objectContaining({
        status: expect.objectContaining({ state: 'completed' }),
      }),
    ])
  })

  it('times out as uncertain because a paid bundle can still execute', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))

    await expect(relayrPoll('bundle', 1, undefined, 0, -1)).rejects.toEqual(
      expect.objectContaining({
        name: 'RelayrExecutionError',
        code: 'RELAYR_TIMEOUT',
        retryable: true,
      }),
    )
  })

  it('resumes an exact paid bundle without new signatures/payment even when another journal is corrupt', async () => {
    const storage = localStorageWindow()
    vi.stubGlobal('window', storage.window)
    const entry = signedEntry()
    installDestinationProof(() => [entry])
    saveRelayrPendingSession('scope', {
      bundleUuid: 'saved-bundle',
      paymentHash: HASH,
      paymentChainId: 1,
      paymentStatus: 'confirmed',
      chainIds: [1],
      expectedCount: 1,
      records: successfulRecords([entry]),
      expectedTransactions: [{ txUuid: OTHER_UUID, chain: 1, entry }],
      itemCount: 1,
      account: ALICE,
      createdAt: 1,
    })
    storage.values.set('jb-relayr-pending-v1:unrelated-corrupt', '{not json')

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
    expect(mocks.client.getTransaction).toHaveBeenCalledWith({ hash: DESTINATION_HASH })
    expect(mocks.client.getTransactionReceipt).toHaveBeenCalledWith({ hash: DESTINATION_HASH })
    expect(mocks.client.getBlock).toHaveBeenCalledWith({ blockNumber: 100n })
    expect(storage.values.get('jb-relayr-pending-v1:unrelated-corrupt')).toBe('{not json')
    expect(storage.values.has('jb-relayr-pending-v1:scope')).toBe(false)
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

  it('retains a proven paid bundle until its application completion checkpoint succeeds', async () => {
    const storage = localStorageWindow()
    vi.stubGlobal('window', storage.window)
    installSuccessfulBundle()
    const checkpoint = vi.fn().mockRejectedValueOnce(new Error('application completion could not be saved'))
    const options = { calls: [{ chainId: 1 as const, target: TARGET, data: '0x1234' as const }],
      account: ALICE, pendingScope: 'application-checkpoint', onComplete: checkpoint }
    await expect(runRelayrCalls(options)).rejects.toThrow('application completion could not be saved')
    expect(loadRelayrPendingSession(options.pendingScope)?.paymentHash).toBe(HASH)
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
    checkpoint.mockImplementationOnce(async records => {
      expect(records).toHaveLength(1)
      expect(loadRelayrPendingSession(options.pendingScope)?.paymentHash).toBe(HASH)
    })
    await expect(runRelayrCalls(options)).resolves.toMatchObject({ paymentHash: HASH })
    expect(loadRelayrPendingSession(options.pendingScope)).toBeNull()
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('blocks another project action while this account has a published forwarder authorization', async () => {
    const storage = localStorageWindow()
    vi.stubGlobal('window', storage.window)
    saveRelayrPendingSession('another-project-action', {
      bundleUuid: 'publication-pending', paymentHash: null, paymentChainId: null, paymentStatus: 'unpaid',
      chainIds: [1], expectedCount: 1, records: [], publishedEntries: [signedEntry()], itemCount: 1, account: ALICE, createdAt: 1,
    })
    await expect(runRelayrCalls({ calls: [{ chainId: 1, target: TARGET, data: '0x1234' }], account: ALICE,
      pendingScope: 'new-project-action' })).rejects.toThrow('Another published action')
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('signs every exact destination, pays once, and waits for execution', async () => {
    const storage = localStorageWindow()
    vi.stubGlobal('window', storage.window)
    const posts = installSuccessfulBundle()
    const progress = vi.fn()
    const reverify = vi.fn().mockResolvedValue(undefined)
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
        reverify,
      }),
    ).resolves.toMatchObject({
      paymentHash: HASH,
      records: [{ status: { state: 'success' } }],
    })
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(1)
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.requireReview).toHaveBeenCalledTimes(2)
    expect(mocks.requireFundingChainSelection).toHaveBeenCalledWith([
      expect.objectContaining({ chainId: 1, label: expect.stringContaining('Ethereum') }),
    ])
    expect(posts[0][0].data).not.toBe('0x1234')
    expect(mocks.client.getTransaction).toHaveBeenCalledWith({ hash: DESTINATION_HASH })
    expect(reverify).toHaveBeenCalledTimes(5)
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

describe('Relayr funding choice and exact execution proof', () => {
  const calls: RelayrCall[] = [{ chainId: 1, target: TARGET, data: '0x1234', value: 5n }]

  beforeEach(() => {
    vi.stubGlobal('window', localStorageWindow().window)
  })

  it.each(['other-action', 'same-action'])('does not interpret corrupt JSON in %s as an unused nonce', async scope => {
    const storage = localStorageWindow()
    storage.values.set(`jb-relayr-pending-v1:${scope}`, '{not json')
    vi.stubGlobal('window', storage.window)
    await expect(runRelayrCalls({ calls, account: ALICE, pendingScope: 'same-action' })).rejects.toThrow('records could not be read completely')
    expect(storage.values.get(`jb-relayr-pending-v1:${scope}`)).toBe('{not json')
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves malformed exact-entry evidence when a tolerant own-scope read precedes authorization', async () => {
    const storage = localStorageWindow()
    const raw = JSON.stringify({ bundleUuid: 'publication-pending', paymentHash: null, paymentChainId: null, paymentStatus: 'unpaid',
      chainIds: [1], expectedCount: 1, records: [], itemCount: 1, account: ALICE, createdAt: 1, publishedEntries: 'corrupt entries' })
    storage.values.set('jb-relayr-pending-v1:malformed-own', raw)
    vi.stubGlobal('window', storage.window)
    expect(loadRelayrPendingSession('malformed-own')).not.toBeNull()
    await expect(runRelayrCalls({ calls, account: ALICE, pendingScope: 'malformed-own' })).rejects.toThrow('records could not be read completely')
    expect(storage.values.get('jb-relayr-pending-v1:malformed-own')).toBe(raw)
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
  })

  it.each(['key', 'getItem'] as const)('fails closed if saved nonce reservations cannot be enumerated/read through %s', async method => {
    const storage = localStorageWindow()
    storage.values.set('jb-relayr-pending-v1:unreadable', '{}')
    vi.stubGlobal('window', storage.window)
    vi.spyOn(storage.window.localStorage, method).mockImplementation(() => { throw new Error('Storage is unavailable') })
    await expect(runRelayrCalls({ calls, account: ALICE, pendingScope: 'new-action' })).rejects.toThrow('records could not be read completely')
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not hide a reused durable scope behind this tab’s old cleared marker', async () => {
    const storage = localStorageWindow()
    vi.stubGlobal('window', storage.window)
    const remove = vi.spyOn(storage.window.localStorage, 'removeItem').mockImplementation(() => { throw new Error('Temporary remove failure') })
    clearRelayrPendingSession('reused-scope')
    remove.mockRestore()
    storage.values.set('jb-relayr-pending-v1:reused-scope', JSON.stringify({
      bundleUuid: 'new-bundle-from-another-tab', paymentHash: null, paymentChainId: null, paymentStatus: 'unpaid',
      chainIds: [1], expectedCount: 1, records: [], itemCount: 1, account: ALICE, createdAt: 1, publishedEntries: [signedEntry()],
    }))
    await expect(runRelayrCalls({ calls, account: ALICE, pendingScope: 'different-action' })).rejects.toThrow('Another published action')
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
  })

  it('does not bypass a corrupt launch journal when authorizing a project action', async () => {
    const storage = localStorageWindow()
    storage.values.set('jbm-launch-pending-v1', '{not json')
    vi.stubGlobal('window', storage.window)
    await expect(runRelayrCalls({ calls, account: ALICE, pendingScope: 'new-action' })).rejects.toThrow('Saved launch authorizations could not be read')
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not publish or leave a stranded session when durable publication storage fails', async () => {
    const storage = localStorageWindow()
    vi.stubGlobal('window', storage.window)
    vi.spyOn(storage.window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage full')
    })
    await expect(runRelayrCalls({
      calls, account: ALICE, pendingScope: 'publication-storage-failed',
    })).rejects.toThrow(/enable browser storage/i)
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    expect(loadRelayrPendingSession('publication-storage-failed')).toBeNull()
    expect(storage.values.size).toBe(0)
  })

  it('restores the unpaid publication when saving the payment attempt fails', async () => {
    const storage = localStorageWindow()
    vi.stubGlobal('window', storage.window)
    const store = storage.window.localStorage.setItem
    const write = vi.spyOn(storage.window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (JSON.parse(value).paymentStatus === 'sending') throw new Error('storage full')
      store(key, value)
    })
    const posts = installSuccessfulBundle()
    const options = { calls, account: ALICE, pendingScope: 'payment-storage-failed' }
    await expect(runRelayrCalls(options)).rejects.toThrow(/enable browser storage/i)
    expect(posts).toHaveLength(1)
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({
      paymentStatus: 'unpaid', paymentHash: null, bundleUuid: BUNDLE_UUID,
      expectedTransactions: [{ txUuid: OTHER_UUID }],
    })

    write.mockRestore()
    await expect(runRelayrCalls(options)).resolves.toMatchObject({ paymentHash: HASH })
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(1)
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
    expect(posts[1]).toEqual(posts[0])
  })

  it('refuses a scope locked in another tab before signing or paying', async () => {
    const request = vi.fn(async (_name, _options, callback: (lock: null) => Promise<unknown>) => callback(null))
    vi.stubGlobal('navigator', { locks: { request } })
    await expect(runRelayrCalls({
      calls, account: ALICE, pendingScope: 'other-tab-lock',
    })).rejects.toThrow(/already being processed in another tab/i)
    expect(request).toHaveBeenCalledWith('jb-relayr:other-tab-lock', { ifAvailable: true }, expect.any(Function))
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a concurrent invocation of the same scope while the first choice is open', async () => {
    const posts = installSuccessfulBundle()
    let release!: (chainId: number) => void
    let reached!: () => void
    const choice = new Promise<number>(resolve => { release = resolve })
    const choosing = new Promise<void>(resolve => { reached = resolve })
    mocks.requireFundingChainSelection.mockImplementationOnce(() => { reached(); return choice })
    const options = { calls, account: ALICE, pendingScope: 'same-scope-lock' }
    const first = runRelayrCalls(options)
    await choosing
    await expect(runRelayrCalls(options)).rejects.toThrow(/already being processed/i)
    release(1)
    await expect(first).resolves.toMatchObject({ paymentHash: HASH })
    expect(posts).toHaveLength(1)
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(1)
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('refuses a missing selected funding chain without using another quoted option', async () => {
    const posts = installSuccessfulBundle()
    await expect(runRelayrCalls({
      calls, account: ALICE, pendingScope: 'missing-funding', paymentChainId: 10,
    })).rejects.toThrow(/no payment option on your selected funding chain/i)
    expect(posts).toHaveLength(1)
    expect(mocks.requireFundingChainSelection).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    expect(loadRelayrPendingSession('missing-funding')).toMatchObject({
      paymentStatus: 'unpaid', paymentHash: null,
      publishedEntries: [expect.objectContaining({ chain: 1 })],
    })
  })

  it('funds the chain the user chooses even when the connected chain has a quote', async () => {
    installSuccessfulBundle([payment, paymentFor({ chain: 10, amount: '200' })])
    mocks.requireFundingChainSelection.mockResolvedValueOnce(10)
    await expect(runRelayrCalls({
      calls, account: ALICE, pendingScope: 'explicit-funding',
    })).resolves.toMatchObject({ paymentHash: HASH })
    expect(mocks.requireFundingChainSelection).toHaveBeenCalledWith([
      expect.objectContaining({ chainId: 1 }),
      expect.objectContaining({ chainId: 10 }),
    ])
    expect(mocks.connectedWallet).toHaveBeenLastCalledWith(10, expect.any(Object))
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ value: 200n }))
  })

  it('proves each independently signed destination after one funding payment', async () => {
    const posts = installSuccessfulBundle()
    await expect(runRelayrCalls({
      calls: [...calls, { chainId: 10, target: BOB, data: '0x5678', value: 2n }],
      account: ALICE, pendingScope: 'two-destination-proof', paymentChainId: 1,
    })).resolves.toMatchObject({
      paymentHash: HASH,
      records: [{ tx_uuid: OTHER_UUID }, { tx_uuid: THIRD_UUID }],
    })
    expect(posts[0].map(entry => [entry.chain, entry.virtual_nonce])).toEqual([[1, 0], [10, 0]])
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(2)
    expect(mocks.wallet.signTypedData.mock.calls.map(([input]) => input.message.nonce)).toEqual([4n, 4n])
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.client.getTransaction).toHaveBeenCalledWith({ hash: DESTINATION_HASH })
    expect(mocks.client.getTransaction).toHaveBeenCalledWith({ hash: SECOND_DESTINATION_HASH })
    expect(mocks.client.getBlock).toHaveBeenCalledTimes(2)
    expect(loadRelayrPendingSession('two-destination-proof')).toBeNull()
  })

  it('requires another funding choice after cancellation while reusing the original signature', async () => {
    const posts = installSuccessfulBundle()
    mocks.requireFundingChainSelection.mockRejectedValueOnce(new Error('Funding chain selection cancelled. Nothing was sent.'))
    const options = { calls, account: ALICE, pendingScope: 'cancelled-choice' }
    await expect(runRelayrCalls(options)).rejects.toThrow(/selection cancelled/i)
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({ paymentStatus: 'unpaid', paymentHash: null })
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()

    await expect(runRelayrCalls(options)).resolves.toMatchObject({ paymentHash: HASH })
    expect(mocks.requireFundingChainSelection).toHaveBeenCalledTimes(2)
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(1)
    expect(posts).toHaveLength(2)
    expect(posts[1]).toEqual(posts[0])
    expect(mocks.client.readContract.mock.calls.filter(([input]) => input.functionName === 'nonces')).toHaveLength(1)
  })

  it('reuses exactly the published signature after the quote response is lost', async () => {
    const posts = installSuccessfulBundle()
    let lostEntries: RelayrEntry[] = []
    vi.mocked(fetch).mockImplementationOnce(async (_input, init) => {
      lostEntries = (JSON.parse(String(init?.body)) as { transactions: RelayrEntry[] }).transactions
      throw new DOMException('quote response lost', 'TimeoutError')
    })
    const options = { calls, account: ALICE, pendingScope: 'lost-quote' }
    await expect(runRelayrCalls(options)).rejects.toThrow(/did not return a quote/i)
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({
      paymentStatus: 'unpaid', bundleUuid: 'publication-pending',
      publishedEntries: [expect.objectContaining({ data: lostEntries[0].data })],
    })
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()

    await expect(runRelayrCalls(options)).resolves.toMatchObject({ paymentHash: HASH })
    expect(posts).toEqual([lostEntries])
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(1)
    expect(mocks.client.readContract.mock.calls.filter(([input]) => input.functionName === 'nonces')).toHaveLength(1)
    expect(loadRelayrPendingSession(options.pendingScope)).toBeNull()
  })

  it('keeps the original publication when its signature can no longer be verified', async () => {
    const posts = installSuccessfulBundle()
    mocks.requireFundingChainSelection.mockRejectedValueOnce(new Error('closed'))
    const options = { calls, account: ALICE, pendingScope: 'invalid-original-signature' }
    await expect(runRelayrCalls(options)).rejects.toThrow('closed')
    const read = mocks.client.readContract.getMockImplementation()!
    mocks.client.readContract.mockImplementation(async input => input.functionName === 'verify' ? false : read(input))

    await expect(runRelayrCalls(options)).rejects.toThrow(/authorization or trusted forwarder changed/i)
    expect(posts).toHaveLength(1)
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(1)
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({ paymentStatus: 'unpaid' })
  })

  it('rejects dependent calls on the same chain before signing or publishing', async () => {
    await expect(runRelayrCalls({
      calls: [...calls, { ...calls[0], data: '0x5678' }], account: ALICE, pendingScope: 'duplicate-chain',
    })).rejects.toThrow(/one independent call per destination chain/i)
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retains a no-hash payment attempt and never signs or pays again while proof is unavailable', async () => {
    const posts = installSuccessfulBundle()
    mocks.wallet.sendTransaction.mockRejectedValueOnce(new Error('wallet transport disconnected'))
    const options = { calls, account: ALICE, pendingScope: 'no-hash-payment' }
    await expect(runRelayrCalls(options)).rejects.toMatchObject({ name: 'RelayrPaymentSendingError' })
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({
      paymentStatus: 'sending', paymentHash: null, bundleUuid: BUNDLE_UUID,
    })
    mocks.client.getTransaction.mockRejectedValueOnce(new Error('Destination RPC unavailable'))
    await expect(runRelayrCalls(options)).rejects.toThrow('Destination RPC unavailable')
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({ paymentStatus: 'sending', paymentHash: null })
    expect(posts).toHaveLength(1)
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(1)
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.requireFundingChainSelection).toHaveBeenCalledTimes(1)
  })

  it.each(['transaction UUID', 'calldata', 'receipt status', 'canonical block'])('keeps paid bundles pending when %s proof is wrong', async problem => {
    const posts = installSuccessfulBundle()
    if (problem === 'transaction UUID') {
      const originalFetch = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation(async (input, init) => init?.method === 'POST'
        ? originalFetch(input, init)
        : response({ transactions: successfulRecords(posts[0]).map(record => ({ ...record, tx_uuid: THIRD_UUID })) }))
    } else if (problem === 'calldata') {
      const originalTransaction = mocks.client.getTransaction.getMockImplementation()!
      mocks.client.getTransaction.mockImplementation(async input => ({ ...await originalTransaction(input), input: '0x1234' }))
    } else if (problem === 'receipt status') {
      const originalReceipt = mocks.client.getTransactionReceipt.getMockImplementation()!
      mocks.client.getTransactionReceipt.mockImplementation(async input => ({ ...await originalReceipt(input), status: 'reverted' }))
    } else {
      mocks.client.getBlock.mockResolvedValue({ hash: HASH })
    }
    const options = { calls, account: ALICE, pendingScope: `wrong-${problem}` }
    await expect(runRelayrCalls(options)).rejects.toThrow(/exact destination|does not prove|no longer canonical/i)
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({ paymentStatus: 'confirmed', paymentHash: HASH })
    await expect(runRelayrCalls(options)).rejects.toThrow(/exact destination|does not prove|no longer canonical/i)
    expect(loadRelayrPendingSession(options.pendingScope)).not.toBeNull()
    expect(posts).toHaveLength(1)
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(1)
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('does not clear a legacy paid session using API success labels alone', async () => {
    const scope = 'legacy-api-only'
    saveRelayrPendingSession(scope, {
      bundleUuid: BUNDLE_UUID, paymentHash: HASH, paymentChainId: 1, paymentStatus: 'confirmed',
      chainIds: [1], expectedCount: 1, itemCount: 1, account: ALICE, createdAt: Date.now(),
      records: successfulRecords([signedEntry()]),
    })
    await expect(runRelayrCalls({ calls, account: ALICE, pendingScope: scope })).rejects.toThrow(/lacks exact destination proof/i)
    expect(loadRelayrPendingSession(scope)?.paymentHash).toBe(HASH)
    expect(mocks.client.getTransaction).not.toHaveBeenCalled()
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
