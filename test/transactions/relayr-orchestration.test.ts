import { encodeFunctionData, toFunctionSelector, type Address, type Hex } from 'viem'
import { erc2771ForwarderAbi, jbContractAddress, JBCoreContracts, type JBChainId } from '@bananapus/nana-sdk-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: undefined as Address | undefined,
  /** The status the chain mines a payment with, unless `paymentStatuses` names its hash. */
  paymentStatus: 'success' as 'success' | 'reverted',
  paymentStatuses: new Map<string, 'success' | 'reverted'>(),
  client: {
    readContract: vi.fn(),
    request: vi.fn(),
    getCode: vi.fn(),
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
    { id: 8453, name: 'Base' },
    { id: 42161, name: 'Arbitrum' },
    { id: 11155111, name: 'Sepolia' },
    { id: 11155420, name: 'OP Sepolia' },
    { id: 84532, name: 'Base Sepolia' },
    { id: 421614, name: 'Arbitrum Sepolia' },
  ],
}))
vi.mock('@/lib/wallet-core', () => ({
  publicClient: () => mocks.client,
  connectedWallet: mocks.connectedWallet,
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
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
  RELAYR_FORWARDER_DEADLINE_SECONDS,
  RELAYR_PAYMENT_SELECTOR,
  relayrPaymentDetails as sdkRelayrPaymentDetails,
  type RelayrEntry,
  type RelayrPayment,
} from '@bananapus/nana-sdk-core/review/relayr'
import {
  buildForwardedTx,
  relayrPay,
  relayrPaymentDetails,
  relayrPaymentOptions,
  relayrPoll,
  relayrPostBundle,
  runRelayrCalls,
  saveRelayrPendingSession,
  loadRelayrPendingSession,
  listRelayrPendingScopes,
  clearRelayrPendingSession,
  relayrQuoteReleased,
  resumeRelayrSession,
  type RelayrCall,
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
const DESTINATION_HASHES = [DESTINATION_HASH, SECOND_DESTINATION_HASH, `0x${'12'.repeat(32)}`, `0x${'34'.repeat(32)}`] as Hex[]
const DESTINATION_UUIDS = [OTHER_UUID, THIRD_UUID, 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa']
const TESTNETS = [11155111, 11155420, 84532, 421614] as const
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
    tx_uuid: DESTINATION_UUIDS[index],
    request: entry,
    status: { state: 'success', data: { hash: DESTINATION_HASHES[index] } },
  }))
}

/**
 * The chain. A destination hash holds the exact signed call posted to Relayr,
 * in block 101; any other hash holds the payment the wallet last sent, in
 * block 100, mined with `mocks.paymentStatus`.
 */
function installChain(entries: () => readonly RelayrEntry[]) {
  const transactionOf = (hash: Hex) => {
    const entry = entries()[DESTINATION_HASHES.indexOf(hash)]
    if (entry) {
      return { hash, chainId: entry.chain, from: BOB, to: entry.target, input: entry.data,
        value: BigInt(entry.value), blockHash: BLOCK_HASH, blockNumber: 101n }
    }
    const [sent] = mocks.wallet.sendTransaction.mock.calls.at(-1) ?? []
    if (!sent) throw new Error(`No transaction fixture for ${hash}`)
    return { hash, chainId: mocks.connectedWallet.mock.calls.at(-1)?.[0], from: sent.account, to: sent.to,
      input: sent.data, value: sent.value, blockHash: BLOCK_HASH, blockNumber: 100n }
  }
  mocks.client.getTransaction.mockImplementation(async ({ hash }) => transactionOf(hash))
  mocks.client.getTransactionReceipt.mockImplementation(async ({ hash }) => {
    const transaction = transactionOf(hash)
    return { transactionHash: hash, to: transaction.to, blockHash: BLOCK_HASH, blockNumber: transaction.blockNumber,
      status: DESTINATION_HASHES.includes(hash) ? 'success' : mocks.paymentStatuses.get(hash) ?? mocks.paymentStatus }
  })
  mocks.client.getBlock.mockResolvedValue({ hash: BLOCK_HASH })
}

/** Pay `option` for BUNDLE_UUID's destinations from Alice. */
function pay(option: RelayrPayment, destinationChainIds: readonly number[], options: Partial<Parameters<typeof relayrPay>[0]> = {}) {
  return relayrPay({ payment: option, account: ALICE, bundleUuid: BUNDLE_UUID, destinationChainIds, ...options })
}

/** Relayr quotes `payments`, or `payments(n)` for its nth quote from 0, and runs every bundle. */
function installSuccessfulBundle(payments: RelayrPayment[] | ((post: number) => RelayrPayment[]) = [payment]) {
  const posts: RelayrEntry[][] = []
  installChain(() => posts.at(-1) ?? [])
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/bundle/prepaid') && init?.method === 'POST') {
      const entries = (JSON.parse(String(init.body)) as { transactions: RelayrEntry[] }).transactions
      posts.push(entries)
      return response({ bundle_uuid: BUNDLE_UUID, payment_info: typeof payments === 'function' ? payments(posts.length - 1) : payments,
        txn_uuids: entries.map((_, index) => DESTINATION_UUIDS[index]),
        transactions: successfulRecords(entries) })
    }
    if (url.endsWith(`/v1/bundle/${BUNDLE_UUID}`)) {
      return response({ bundle_uuid: BUNDLE_UUID, transactions: successfulRecords(posts.at(-1) ?? []) })
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
  mocks.client.getCode.mockResolvedValue(PAYMENT_RUNTIME)
  mocks.client.request.mockImplementation(async ({ method, params }) => {
    if (method === 'eth_call') {
      return params[0].data.startsWith(TRUSTED_FORWARDER_SELECTOR)
        ? `0x${'0'.repeat(63)}1` : '0x'
    }
    throw new Error(`Unexpected RPC method ${method}`)
  })
  mocks.paymentStatus = 'success'
  mocks.paymentStatuses.clear()
  installChain(() => [])
  mocks.client.waitForTransactionReceipt.mockImplementation(async ({ hash }) => ({ transactionHash: hash,
    status: mocks.paymentStatuses.get(hash) ?? mocks.paymentStatus }))
  mocks.wallet.signTypedData.mockResolvedValue(`0x${'11'.repeat(65)}`)
  mocks.wallet.sendTransaction.mockResolvedValue(HASH)
})

describe('Relayr quote and payment boundaries', () => {
  it('reviews prerequisite deployment calls alongside the exact forwarded authorization without adding a wallet prompt', async () => {
    const prerequisite = { chainId: 1, to: BOB, data: '0xabcd' as Hex, value: 0n,
      label: 'Create owner multisig' }
    const call = { chainId: 1 as JBChainId, target: TARGET, data: '0x1234' as Hex, value: 5n,
      gas: 700_000n, label: 'Launch project' }
    await buildForwardedTx(call, ALICE, 4n, {
      description: 'Create the owner Safe with 2 of 3 approvals.', calls: [prerequisite],
    })
    expect(mocks.requireReview).toHaveBeenCalledTimes(1)
    expect(mocks.requireReview).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('Create the owner Safe with 2 of 3 approvals.'),
      calls: [prerequisite, expect.objectContaining({ from: ALICE, to: TARGET, data: call.data, value: 5n, gas: 700_000n })],
      authorization: expect.objectContaining({ message: expect.objectContaining({ from: ALICE, to: TARGET,
        data: call.data, value: 5n, gas: 700_000n, nonce: 4n }) }),
    }))
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(1)
    expect(mocks.wallet.signTypedData).toHaveBeenCalledWith(expect.objectContaining({
      message: mocks.requireReview.mock.calls[0][0].authorization.message,
    }))
    expect(mocks.requireReview.mock.invocationCallOrder[0]).toBeLessThan(mocks.wallet.signTypedData.mock.invocationCallOrder[0])
  })

  it.each([[false, 3], [true, 1]] as const)('with reverifyBeforeSendOnly=%s runs reverify %i time(s), last right before sending', async (beforeSendOnly, runs) => {
    const reverify = vi.fn(async () => {
      expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    })
    await pay(paymentFor({ chain: TESTNETS[0] }), TESTNETS, { reverify, reverifyBeforeSendOnly: beforeSendOnly })
    expect(reverify).toHaveBeenCalledTimes(runs)
    expect(reverify.mock.invocationCallOrder.at(-1)).toBeGreaterThan(mocks.requireReview.mock.invocationCallOrder[0])
  })

  it.each(TESTNETS)('authenticates and pays the canonical contract on testnet %s', async chain => {
    const testnetPayment = paymentFor({ chain })
    await expect(pay(testnetPayment, TESTNETS)).resolves.toMatchObject({ hash: HASH })
    expect(mocks.connectedWallet).toHaveBeenCalledWith(chain, expect.any(Object))
    expect(mocks.requireReview).toHaveBeenCalledWith(expect.objectContaining({
      calls: [expect.objectContaining({ chainId: chain, to: RELAYR_PAYMENT_ADDRESS, data: testnetPayment.calldata })],
    }))
    expect(mocks.client.getCode).toHaveBeenCalledWith({ address: RELAYR_PAYMENT_ADDRESS, blockTag: 'latest' })
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it.each([
    { chain: 1, destinations: [...TESTNETS] },
    { chain: 11155111, destinations: [1, 10] },
    { chain: 1, destinations: [1, 11155111] },
    { chain: 1, destinations: [] },
  ])('refuses funding chain $chain for destinations $destinations before wallet review', async ({ chain, destinations }) => {
    await expect(pay(paymentFor({ chain }), destinations)).rejects.toThrow(/same network family/)
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.connectedWallet).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it.each(['review', 'wallet'] as const)('rejects a funding-chain change during %s even within the same family', async boundary => {
    const offered = paymentFor({ chain: 11155111 })
    const change = () => { offered.chain = 84532 }
    if (boundary === 'review') mocks.requireReview.mockImplementationOnce(async () => change())
    else mocks.connectedWallet.mockImplementationOnce(async () => { change(); return { wallet: mocks.wallet, account: ALICE } })
    await expect(pay(offered, TESTNETS)).rejects.toThrow(/payment changed/)
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('rechecks the network family when a quote changes while its payment review is open', async () => {
    const offered = paymentFor({ chain: 11155111 })
    mocks.requireReview.mockImplementationOnce(async () => { offered.chain = 1 })
    await expect(pay(offered, TESTNETS)).rejects.toThrow(/same network family/)
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('rejects unrecognized payment runtime on a supported testnet', async () => {
    mocks.client.getCode.mockResolvedValueOnce('0x6000')
    await expect(pay(paymentFor({ chain: 84532 }), TESTNETS)).rejects.toThrow(/code is not recognized/)
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('rejects mixed-family raw bundles before publication', async () => {
    await expect(relayrPostBundle([signedEntry(1), signedEntry(11155111)])).rejects.toThrow(/one network family/)
    expect(fetch).not.toHaveBeenCalled()
  })

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
        // Relayr lists records out of request order; binding follows the request.
        transactions: [
          { tx_uuid: THIRD_UUID, request: { chain: 1, target: TARGET, data: '0x03', value: '3', virtual_nonce: 1 } },
          { tx_uuid: BUNDLE_UUID, request: { chain: 1, target: TARGET, data: '0x01', value: '0', virtual_nonce: 0 } },
          { tx_uuid: OTHER_UUID, request: { chain: 10, target: TARGET, data: '0x02', value: '2', virtual_nonce: 0 } },
        ],
      }),
    )
    const entries = [
      { chain: 1, target: TARGET, data: '0x01' as Hex, value: '0' },
      { chain: 10, target: TARGET, data: '0x02' as Hex, value: '2' },
      { chain: 1, target: TARGET, data: '0x03' as Hex, value: '3' },
    ]

    const quote = await relayrPostBundle(entries)
    expect(quote.expectedTransactions?.map(binding => binding.txUuid)).toEqual(
      [BUNDLE_UUID, OTHER_UUID, THIRD_UUID].map(uuid => uuid.toLowerCase()),
    )

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

    await expect(relayrPostBundle([{ chain: 1, target: TARGET, data: '0x01', value: '0' }])).rejects.toThrow(
      /nothing was paid.*safe to try again/i,
    )
  })

  it('surfaces bounded Relayr HTTP detail', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response('bad quote', 503))
    await expect(relayrPostBundle([{ chain: 1, target: TARGET, data: '0x01', value: '0' }])).rejects.toThrow(
      'Relayr HTTP 503: bad quote',
    )
  })

  it('authenticates, reviews, simulates, rechecks, sends, and proves the exact payment', async () => {
    const sent = vi.fn()
    const reverify = vi.fn().mockResolvedValue(undefined)

    await expect(pay(payment, [1], { onSent: sent, reverify })).resolves.toMatchObject({ hash: HASH })
    expect(mocks.requireReview).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [
          expect.objectContaining({
            chainId: 1,
            from: ALICE,
            to: RELAYR_PAYMENT_ADDRESS,
            value: 100n,
            gas: 150_000n,
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
    expect(sent).toHaveBeenCalledWith([expect.objectContaining({ hash: HASH })])
    expect(reverify).toHaveBeenCalledTimes(3)
    // The payment is proven from the chain: its transaction, receipt and canonical block.
    expect(mocks.client.getTransaction).toHaveBeenCalledWith({ hash: HASH })
    expect(mocks.client.getTransactionReceipt).toHaveBeenCalledWith({ hash: HASH })
    expect(mocks.client.getBlock).toHaveBeenCalledWith({ blockNumber: 100n })
  })

  it('remembers the payment relayrPaymentDetails authenticated, with the hash it was sent under', async () => {
    const sent = vi.fn()
    const { payments } = await pay(payment, [1], { onSent: sent })
    const details = relayrPaymentDetails(payment, { bundleUuid: BUNDLE_UUID, destinationChainIds: [1] })
    const remembered = { ...details, amount: details.amount.toString(), deadline: details.deadline.toString(), hash: HASH }
    expect(payments).toEqual([remembered])
    expect(sent).toHaveBeenCalledWith([remembered])
    expect(JSON.parse(JSON.stringify(payments))).toEqual(payments)
  })

  it('proves a sped-up payment under the hash it was mined, and remembers that hash', async () => {
    const MINED = `0x${'9a'.repeat(32)}` as Hex
    mocks.client.waitForTransactionReceipt.mockResolvedValueOnce({ transactionHash: MINED, status: 'success' })
    const sent = vi.fn()
    await expect(pay(payment, [1], { onSent: sent })).resolves.toMatchObject({ hash: MINED, payments: [{ hash: MINED }] })
    expect(sent.mock.calls.map(([payments]) => payments.map((item: { hash: Hex }) => item.hash))).toEqual([[HASH], [MINED]])
    expect(mocks.client.getTransaction).toHaveBeenCalledWith({ hash: MINED })
    expect(mocks.client.getTransaction).not.toHaveBeenCalledWith({ hash: HASH })
  })

  it('never reads a mined replacement that is another transaction as the payment', async () => {
    const MINED = `0x${'9a'.repeat(32)}` as Hex
    mocks.client.waitForTransactionReceipt.mockResolvedValueOnce({ transactionHash: MINED, status: 'success' })
    const chain = mocks.client.getTransaction.getMockImplementation()!
    // The wallet cancelled the payment with a zero-value transaction to itself.
    mocks.client.getTransaction.mockImplementation(async input => ({ ...await chain(input), to: ALICE, input: '0x', value: 0n }))
    const sent = vi.fn()
    await expect(pay(payment, [1], { onSent: sent })).rejects.toMatchObject({
      name: 'RelayrProofError', message: expect.stringMatching(/does not match the reviewed Relayr payment/),
    })
    expect(sent).toHaveBeenLastCalledWith([expect.objectContaining({ hash: MINED })])
  })

  it.each<[string, Record<string, unknown>]>([
    ['another sender', { from: BOB }],
    ['another target', { to: TARGET }],
    ['other calldata', { input: paymentCalldata(OTHER_UUID) }],
    ['another value', { value: 99n }],
    ['another chain', { chainId: 10 }],
  ])('refuses a payment the chain shows with %s', async (_, change) => {
    const chain = mocks.client.getTransaction.getMockImplementation()!
    mocks.client.getTransaction.mockImplementation(async input => ({ ...await chain(input), ...change }))
    await expect(pay(payment, [1])).rejects.toMatchObject({ name: 'RelayrProofError' })
  })

  it('reports a payment that reverted onchain as reverted, after proving it is the reviewed one', async () => {
    mocks.paymentStatus = 'reverted'
    await expect(pay(payment, [1])).rejects.toMatchObject({
      name: 'RelayrPaymentRevertedError', hash: HASH, chainId: 1,
    })
  })

  it('keeps a payment uncertain while its receipt is not in the canonical chain', async () => {
    mocks.client.getBlock.mockResolvedValue({ hash: HASH })
    await expect(pay(payment, [1])).rejects.toMatchObject({ name: 'RelayrPaymentSubmittedError', hash: HASH, chainId: 1 })
  })

  it.each<[string, Partial<RelayrPayment>, RegExp]>([
    ['target', { target: '0x1C05f7841379d4393574c0ffa17908ec40ffd97D' as Address }, /unrecognized payment contract/],
    ['token', { token: '0xEEeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeE' as Address }, /unsupported payment token/],
  ])('refuses a payment %s whose mixed case fails its checksum, which the SDK accepts', async (_, change, message) => {
    const bound = { bundleUuid: BUNDLE_UUID, destinationChainIds: [1] }
    expect(sdkRelayrPaymentDetails({ ...payment, ...change }, bound)).toMatchObject({ target: RELAYR_PAYMENT_ADDRESS })
    expect(() => relayrPaymentDetails({ ...payment, ...change }, bound)).toThrow(message)
    expect(relayrPaymentOptions({ bundle_uuid: BUNDLE_UUID, payment_info: [{ ...payment, ...change }] }, [1])).toEqual([])
    await expect(pay({ ...payment, ...change }, [1])).rejects.toThrow(message)
    expect(mocks.requireReview).not.toHaveBeenCalled()
  })

  it('does not pay if the account changes after bounded simulation', async () => {
    mocks.client.request.mockImplementation(async ({ method }) => {
      if (method === 'eth_call') {
        mocks.account = BOB
        return '0x'
      }
      throw new Error(`Unexpected RPC method ${method}`)
    })

    await expect(pay(payment, [1])).rejects.toThrow(/account changed/i)
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('returns a submitted error with the real hash when receipt lookup fails', async () => {
    mocks.client.waitForTransactionReceipt.mockRejectedValueOnce(
      new Error('RPC unavailable'),
    )

    await expect(pay(payment, [1])).rejects.toEqual(
      expect.objectContaining({
        name: 'RelayrPaymentSubmittedError',
        hash: HASH,
        chainId: 1,
      }),
    )
  })

  it('refuses to pay from a Safe, whose execution no proof can read as this payment', async () => {
    mocks.isSafeConnection.mockReturnValue(true)
    await expect(pay(payment, [1])).rejects.toThrow('Pay for relayed transactions from an ordinary wallet. Nothing was sent.')
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('treats a post-send persistence callback failure as submitted', async () => {
    await expect(
      pay(payment, [1], { onSent: () => {
        throw new Error('storage callback failed')
      } }),
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
    await expect(pay(unsafe, [1])).rejects.toThrow(message)
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

    await expect(pay(paymentFor({}, Math.floor(start / 1000) + 60), [1])).rejects.toThrow(/quote expired/i)
    expect(mocks.requireReview).toHaveBeenCalledTimes(1)
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    now.mockRestore()
  })

  it('binds the payment selector, bundle UUID, deadline, and runtime', async () => {
    const bound = { bundleUuid: BUNDLE_UUID, destinationChainIds: [1] }
    expect(relayrPaymentDetails(payment, bound)).toMatchObject({
      target: RELAYR_PAYMENT_ADDRESS,
      bundleUuid: BUNDLE_UUID,
      amount: 100n,
      deadline: BigInt(PAYMENT_DEADLINE),
    })
    expect(() => relayrPaymentDetails(payment, { ...bound, bundleUuid: OTHER_UUID })).toThrow(
      /does not match this bundle/i,
    )
    expect(() =>
      relayrPaymentDetails(
        { ...payment, calldata: paymentCalldata(BUNDLE_UUID, PAYMENT_DEADLINE, '0xdeadbeef') },
        bound,
      ),
    ).toThrow(/unrecognized payment function/i)

    mocks.client.getCode.mockResolvedValueOnce('0x6000')
    await expect(pay(payment, [1])).rejects.toThrow(
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
      .mockResolvedValueOnce(response({ bundle_uuid: 'bundle-two', transactions: [complete] }))
      .mockResolvedValueOnce(
        response({ bundle_uuid: 'bundle-two', transactions: [complete, complete] }),
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
        response({ bundle_uuid: 'bundle-two-exact', transactions: [complete, complete, complete] }),
      )
      .mockResolvedValueOnce(response({ bundle_uuid: 'bundle-two-exact', transactions: [complete, complete] }))

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
        response({ bundle_uuid: 'bundle', transactions: [{ status: { state: 'submitted' } }] }),
      )
      .mockResolvedValueOnce(
        response({
          bundle_uuid: 'bundle',
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
      response({ bundle_uuid: 'bundle', transactions: [{ status: { state: 'failed' } }] }),
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
          bundle_uuid: 'bundle',
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
    installChain(() => [entry])
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
    expect(mocks.client.getBlock).toHaveBeenCalledWith({ blockNumber: 101n })
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

  it('saves the payment it sent for the quote with the paid session', async () => {
    const storage = localStorageWindow()
    vi.stubGlobal('window', storage.window)
    installSuccessfulBundle()
    const options = { calls: [{ chainId: 1 as const, target: TARGET, data: '0x1234' as const }],
      account: ALICE, pendingScope: 'saved-payment', onComplete: vi.fn().mockRejectedValueOnce(new Error('checkpoint failed')) }
    await expect(runRelayrCalls(options)).rejects.toThrow('checkpoint failed')
    const saved = JSON.parse(storage.values.get('jb-relayr-pending-v1:saved-payment')!)
    expect(saved).toMatchObject({ paymentStatus: 'confirmed', paymentHash: HASH, payments: [{
      hash: HASH, chainId: 1, target: RELAYR_PAYMENT_ADDRESS, calldata: payment.calldata, amount: '100',
      deadline: String(PAYMENT_DEADLINE), bundleUuid: BUNDLE_UUID,
    }] })
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
    ], 1)
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

  it('signs all four testnet destinations and pays once from only the offered testnet funding options', async () => {
    const posts = installSuccessfulBundle([payment, paymentFor({ chain: 11155111 }), paymentFor({ chain: 84532 }), paymentFor({ chain: 421614, target: TARGET })])
    mocks.requireFundingChainSelection.mockResolvedValue(84532)
    const testnetCalls = TESTNETS.map(chainId => ({ ...calls[0], chainId }))
    const checkpoint = vi.fn().mockRejectedValueOnce(new Error('Completion storage failed'))
    const options = { calls: testnetCalls, account: ALICE, pendingScope: 'four-testnets', onComplete: checkpoint }
    await expect(runRelayrCalls(options)).rejects.toThrow('Completion storage failed')
    expect(posts).toHaveLength(1)
    expect(posts[0].map(entry => entry.chain)).toEqual(TESTNETS)
    expect(mocks.wallet.signTypedData.mock.calls.map(([request]) => Number(request.domain.chainId))).toEqual(TESTNETS)
    expect(mocks.requireFundingChainSelection.mock.calls[0][0].map((option: { chainId: number }) => option.chainId)).toEqual([11155111, 84532])
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({ paymentChainId: 84532, paymentStatus: 'confirmed' })
    // A paid recovery is bound to the original payment even if the caller's UI
    // now carries its old mainnet default. It checks proof without paying again.
    await runRelayrCalls({ ...options, paymentChainId: 1 })
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(4)
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
    expect(loadRelayrPendingSession(options.pendingScope)).toBeNull()
  })

  it('does not sign when the requested funding chain belongs to another network family', async () => {
    await expect(runRelayrCalls({ calls: TESTNETS.map(chainId => ({ ...calls[0], chainId })),
      account: ALICE, paymentChainId: 1, pendingScope: 'wrong-family' })).rejects.toThrow(/same network family/)
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps an unpaid testnet authorization when Relayr offers only mainnet funding', async () => {
    installSuccessfulBundle([payment])
    await expect(runRelayrCalls({ calls: TESTNETS.map(chainId => ({ ...calls[0], chainId })),
      account: ALICE, pendingScope: 'no-testnet-offer' })).rejects.toThrow(/network family/)
    expect(loadRelayrPendingSession('no-testnet-offer')).toMatchObject({ paymentStatus: 'unpaid', chainIds: [...TESTNETS] })
    expect(mocks.requireFundingChainSelection).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
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

  it.each<[string, Record<string, unknown>]>([
    ['a payment with no transaction hash', { payments: [{ chainId: 1, target: RELAYR_PAYMENT_ADDRESS, calldata: payment.calldata,
      amount: '100', deadline: String(PAYMENT_DEADLINE), bundleUuid: BUNDLE_UUID, hash: '0x1234' }] }],
    ['a payment option that is not one', { paymentOptions: [{ chain: '1' }] }],
  ])('reads a saved publication with %s as unreadable, never as an unused nonce', async (_, field) => {
    const storage = localStorageWindow()
    storage.values.set('jb-relayr-pending-v1:other-action', JSON.stringify({ bundleUuid: BUNDLE_UUID, paymentHash: null,
      paymentChainId: null, paymentStatus: 'unpaid', chainIds: [1], expectedCount: 1, records: [], itemCount: 1,
      account: ALICE, createdAt: 1, publishedEntries: [signedEntry()], ...field }))
    vi.stubGlobal('window', storage.window)
    await expect(runRelayrCalls({ calls, account: ALICE, pendingScope: 'same-action' })).rejects.toThrow('records could not be read completely')
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
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
    ], 1)
    expect(mocks.connectedWallet).toHaveBeenLastCalledWith(10, expect.any(Object))
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ value: 200n }))
  })

  it('preselects the chain the wallet started on, not the chain signing switched to', async () => {
    installSuccessfulBundle([payment, paymentFor({ chain: 10, amount: '200' })])
    let connectedChain = 10
    mocks.getAccount.mockImplementation(() => ({ address: mocks.account, chainId: connectedChain }))
    mocks.connectedWallet.mockImplementation(async (chainId: number) => {
      connectedChain = chainId
      return { wallet: mocks.wallet, account: ALICE }
    })
    await expect(runRelayrCalls({
      calls, account: ALICE, pendingScope: 'start-chain-funding',
    })).resolves.toMatchObject({ paymentHash: HASH })
    expect(mocks.connectedWallet).toHaveBeenCalledWith(1, expect.any(Object))
    expect(mocks.requireFundingChainSelection).toHaveBeenCalledWith(expect.any(Array), 10)
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
    expect(mocks.client.getBlock.mock.calls.filter(([{ blockNumber }]) => blockNumber === 101n)).toHaveLength(2)
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

  it('offers no payment for a quote whose records are not exactly the quoted IDs, and keeps the publication', async () => {
    const posts = installSuccessfulBundle()
    const relayr = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const body = await (await relayr(input, init)).json() as { transactions: unknown[] }
      // The quote and the bundle also list a record under an ID this quote did not issue.
      return response({ ...body, transactions: [...body.transactions, { ...successfulRecords(posts[0])[0], tx_uuid: THIRD_UUID }] })
    })
    const options = { calls, account: ALICE, pendingScope: 'inexact-records' }
    await expect(runRelayrCalls(options)).rejects.toThrow('Relayr did not bind every quoted transaction to a unique ID. Nothing was paid.')
    expect(mocks.requireFundingChainSelection).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({
      paymentStatus: 'unpaid', bundleUuid: 'publication-pending', publishedEntries: posts[0].map(entry => expect.objectContaining({ data: entry.data })),
    })
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
    await expect(runRelayrCalls(options)).rejects.toThrow(/Could not read destination transaction .* on chain 1/)
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({ paymentStatus: 'sending', paymentHash: null })
    expect(posts).toHaveLength(1)
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(1)
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.requireFundingChainSelection).toHaveBeenCalledTimes(1)
  })

  it.each<[string, RegExp]>([
    ['transaction UUID', /names a transaction this quote did not bind/],
    ['destination request', /does not match the signed request/],
    ['shared hash', /one destination transaction for two signed calls/],
    ['calldata', /does not prove the signed Relayr call/],
    ['receipt target', /Could not read destination transaction/],
    ['receipt status', /it reverted onchain/],
    ['canonical block', /no longer canonical/],
  ])('keeps paid bundles pending when the %s proof is wrong', async (problem, message) => {
    const posts = installSuccessfulBundle()
    const twoChains = problem === 'shared hash'
    /** Relayr's status reports the posted calls' records as `edit` changes them. */
    const reportStatus = (edit: (record: ReturnType<typeof successfulRecords>[number]) => object) => {
      const original = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation(async (input, init) => init?.method === 'POST'
        ? original(input, init)
        : response({ bundle_uuid: BUNDLE_UUID, transactions: successfulRecords(posts[0]).map(edit) }))
    }
    if (problem === 'transaction UUID') {
      reportStatus(record => ({ ...record, tx_uuid: THIRD_UUID }))
    } else if (problem === 'destination request') {
      // Relayr names another call on the chain, while the chain holds the signed one.
      reportStatus(record => ({ ...record, request: { ...record.request, data: '0x1234' } }))
    } else if (problem === 'shared hash') {
      reportStatus(record => ({ ...record, status: { state: 'success', data: { hash: DESTINATION_HASH } } }))
    } else if (problem === 'calldata') {
      const originalTransaction = mocks.client.getTransaction.getMockImplementation()!
      mocks.client.getTransaction.mockImplementation(async input => DESTINATION_HASHES.includes(input.hash)
        ? { ...await originalTransaction(input), input: '0x1234' } : originalTransaction(input))
    } else if (problem === 'receipt target') {
      const originalReceipt = mocks.client.getTransactionReceipt.getMockImplementation()!
      mocks.client.getTransactionReceipt.mockImplementation(async input => DESTINATION_HASHES.includes(input.hash)
        ? { ...await originalReceipt(input), to: BOB } : originalReceipt(input))
    } else if (problem === 'receipt status') {
      const originalReceipt = mocks.client.getTransactionReceipt.getMockImplementation()!
      mocks.client.getTransactionReceipt.mockImplementation(async input => DESTINATION_HASHES.includes(input.hash)
        ? { ...await originalReceipt(input), status: 'reverted' } : originalReceipt(input))
    } else {
      mocks.client.getBlock.mockImplementation(async ({ blockNumber }) => ({ hash: blockNumber === 101n ? HASH : BLOCK_HASH }))
    }
    const options = { calls: twoChains ? [...calls, { chainId: 10 as const, target: BOB, data: '0x5678' as Hex, value: 2n }] : calls,
      account: ALICE, pendingScope: `wrong-${problem}`, paymentChainId: 1 }
    await expect(runRelayrCalls(options)).rejects.toThrow(message)
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({ paymentStatus: 'confirmed', paymentHash: HASH })
    await expect(runRelayrCalls(options)).rejects.toThrow(message)
    expect(loadRelayrPendingSession(options.pendingScope)).not.toBeNull()
    expect(posts).toHaveLength(1)
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(twoChains ? 2 : 1)
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

describe('paying a reverted Relayr payment again', () => {
  const SECOND_PAYMENT = `0x${'5c'.repeat(32)}` as Hex
  const calls: RelayrCall[] = [{ chainId: 1, target: TARGET, data: '0x1234', value: 5n }]
  const options = { calls, account: ALICE, pendingScope: 'reverted-payment' }

  beforeEach(() => {
    vi.stubGlobal('window', localStorageWindow().window)
  })

  /**
   * Relayr: the quote binds the posted call. Until a payment the session sent
   * succeeds, the bundle reads as `bundle` says, by default unpaid with its
   * call pending; then Relayr runs it. A read answers after a moment, as a
   * browser's does, unless its request is aborted first.
   */
  function relayr(bundle: Record<string, unknown> = {}, payments = [payment]) {
    const posts = installSuccessfulBundle(payments)
    const quote = vi.mocked(fetch).getMockImplementation()!
    const paid = () => (loadRelayrPendingSession(options.pendingScope)?.payments ?? [])
      .some(sent => (mocks.paymentStatuses.get(sent.hash) ?? mocks.paymentStatus) === 'success')
    const reads = vi.fn(async (signal?: AbortSignal | null) => {
      await new Promise<void>((resolve, reject) => {
        const answered = setTimeout(resolve, 5)
        signal?.addEventListener('abort', () => { clearTimeout(answered); reject(signal.reason) }, { once: true })
      })
      return paid()
        ? quote(`https://api.relayr.ba5ed.com/v1/bundle/${BUNDLE_UUID}`, undefined)
        : response({ bundle_uuid: BUNDLE_UUID, payment_received: false, ...bundle,
          transactions: ((bundle.transactions as object[] | undefined) ?? [{ tx_uuid: OTHER_UUID, status: { state: 'Pending' } }])
            .map(record => ({ request: posts[0][0], ...record })) })
    })
    vi.mocked(fetch).mockImplementation(async (input, init) => init?.method === 'POST' ? quote(input, init) : reads(init?.signal))
    return { posts, reads }
  }

  /** Pay once and see the payment revert onchain. */
  async function revertedPayment() {
    mocks.paymentStatuses.set(HASH, 'reverted')
    await expect(runRelayrCalls(options)).rejects.toMatchObject({ name: 'RelayrPaymentRevertedError', hash: HASH })
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({
      paymentStatus: 'reverted', bundleUuid: BUNDLE_UUID, payments: [expect.objectContaining({ hash: HASH })],
    })
  }

  it('pays the same quote again after proving every sent payment reverted and reading Relayr unpaid and unrun', async () => {
    const { posts, reads } = relayr()
    await revertedPayment()
    mocks.wallet.sendTransaction.mockResolvedValueOnce(SECOND_PAYMENT)
    await expect(runRelayrCalls(options)).resolves.toMatchObject({ paymentHash: SECOND_PAYMENT })
    expect(posts).toHaveLength(1)
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(1)
    expect(mocks.requireFundingChainSelection).toHaveBeenCalledTimes(1)
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(2)
    expect(mocks.wallet.sendTransaction.mock.calls[1][0]).toEqual(mocks.wallet.sendTransaction.mock.calls[0][0])
    expect(fetch).toHaveBeenCalledWith(`https://api.relayr.ba5ed.com/v1/bundle/${BUNDLE_UUID}`, expect.objectContaining({ cache: 'no-store' }))
    expect(reads.mock.invocationCallOrder[0]).toBeLessThan(mocks.wallet.sendTransaction.mock.invocationCallOrder[1])
    expect(loadRelayrPendingSession(options.pendingScope)).toBeNull()
  })

  it.each<[string, Record<string, unknown>]>([
    ['Relayr does not say whether it was paid', { payment_received: null }],
    ['the read names another bundle', { bundle_uuid: OTHER_UUID }],
  ])('does not pay again when %s', async (_, bundle) => {
    relayr(bundle)
    await revertedPayment()
    await expect(runRelayrCalls(options)).rejects.toThrow(/has not said/)
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({ paymentStatus: 'reverted' })
  })

  it.each<[string, Record<string, unknown>]>([
    ['Relayr reports a payment from elsewhere', { payment_received: true }],
    ['a call is running', { transactions: [{ tx_uuid: OTHER_UUID, status: { state: 'Included' } }] }],
  ])('proves the destinations instead of paying again when %s, and waits while they run', async (_, bundle) => {
    relayr(bundle)
    await revertedPayment()
    await expect(runRelayrCalls(options)).rejects.toThrow(
      'Another payment funded this Relayr quote. Check again once its calls have run; do not pay again.')
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({ paymentStatus: 'reverted' })
  })

  it('completes instead of paying again when a call names a destination hash that proves it ran', async () => {
    relayr({ transactions: [{ tx_uuid: OTHER_UUID, status: { state: 'Pending', data: { hash: DESTINATION_HASH } } }] })
    await revertedPayment()
    await expect(runRelayrCalls(options)).resolves.toMatchObject({ paymentHash: HASH })
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
    expect(loadRelayrPendingSession(options.pendingScope)).toBeNull()
  })

  it('saves no payment hash while the wallet holds a retry, keeping the reverted one in the payment history', async () => {
    relayr()
    await revertedPayment()
    let held: unknown
    mocks.wallet.sendTransaction.mockImplementationOnce(async () => {
      held = loadRelayrPendingSession(options.pendingScope)
      return SECOND_PAYMENT
    })
    await expect(runRelayrCalls(options)).resolves.toMatchObject({ paymentHash: SECOND_PAYMENT })
    expect(held).toMatchObject({ paymentStatus: 'sending', paymentHash: null, payments: [expect.objectContaining({ hash: HASH })] })
  })

  it('does not pay again while Relayr is unreachable', async () => {
    relayr()
    await revertedPayment()
    const quote = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => init?.method === 'POST' ? quote(input, init) : Promise.reject(new TypeError('network down')))
    await expect(runRelayrCalls(options)).rejects.toThrow(/has not said/)
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('does not pay again once the quote expires', async () => {
    const start = Date.now()
    const deadline = Math.floor(start / 1_000) + 600
    relayr({}, [paymentFor({}, deadline)])
    await revertedPayment()
    vi.spyOn(Date, 'now').mockReturnValue((deadline - 15) * 1_000)
    await expect(runRelayrCalls(options)).rejects.toThrow('This Relayr quote expired. Review the action again for a new quote.')
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.requireReview).toHaveBeenCalledTimes(2)
  })

  it('refuses a retry when any payment it sent did not revert, including one before a declined retry', async () => {
    const { posts } = relayr()
    await revertedPayment()
    mocks.paymentStatuses.set(SECOND_PAYMENT, 'reverted')
    mocks.wallet.sendTransaction.mockResolvedValueOnce(SECOND_PAYMENT)
    await expect(runRelayrCalls(options)).rejects.toMatchObject({ name: 'RelayrPaymentRevertedError', hash: SECOND_PAYMENT })
    mocks.wallet.sendTransaction.mockRejectedValueOnce(Object.assign(new Error('User rejected'), { code: 4001 }))
    await expect(runRelayrCalls(options)).rejects.toThrow('User rejected')
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({
      paymentStatus: 'reverted', bundleUuid: BUNDLE_UUID,
      payments: [expect.objectContaining({ hash: HASH }), expect.objectContaining({ hash: SECOND_PAYMENT })],
    })
    // The first payment now reads as successful onchain while Relayr still
    // reports the bundle unpaid: a later one reverting proves nothing.
    mocks.paymentStatuses.set(HASH, 'success')
    const post = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => init?.method === 'POST' ? post(input, init)
      : response({ bundle_uuid: BUNDLE_UUID, payment_received: false,
        transactions: [{ tx_uuid: OTHER_UUID, request: posts[0][0], status: { state: 'Pending' } }] }))
    await expect(runRelayrCalls(options)).rejects.toThrow(
      'This Relayr payment succeeded onchain, so its bundle is paid. Do not pay again.')
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(3)
    expect(mocks.requireFundingChainSelection).toHaveBeenCalledTimes(1)
  })

  it('finds a payment that reverted while the app was away, then pays the same quote again on the retry rule', async () => {
    relayr()
    mocks.paymentStatuses.set(HASH, 'reverted')
    mocks.client.waitForTransactionReceipt.mockRejectedValueOnce(new Error('page closed'))
    await expect(runRelayrCalls(options)).rejects.toMatchObject({ name: 'RelayrPaymentSubmittedError', hash: HASH })
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({ paymentStatus: 'submitted' })
    await expect(runRelayrCalls(options)).rejects.toMatchObject({ name: 'RelayrPaymentRevertedError', hash: HASH })
    expect(loadRelayrPendingSession(options.pendingScope)).toMatchObject({ paymentStatus: 'reverted' })
    mocks.wallet.sendTransaction.mockResolvedValueOnce(SECOND_PAYMENT)
    await expect(runRelayrCalls(options)).resolves.toMatchObject({ paymentHash: SECOND_PAYMENT })
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(2)
  })

  it('tells the account view to reopen the original action, and resolves a bundle another payment ran', async () => {
    relayr()
    await revertedPayment()
    await expect(resumeRelayrSession({ scope: options.pendingScope, account: ALICE })).rejects.toThrow(
      'This Relayr payment reverted onchain. Reopen the original action to pay the same quote again.')
    // Another payment funded the bundle after all, and Relayr ran it.
    mocks.paymentStatuses.clear()
    await expect(resumeRelayrSession({ scope: options.pendingScope, account: ALICE })).resolves.toMatchObject({ paymentHash: HASH })
    expect(loadRelayrPendingSession(options.pendingScope)).toBeNull()
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('proves a quote another payment funded from the original action, and never pays it again', async () => {
    const { posts } = relayr()
    await revertedPayment()
    const post = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => init?.method === 'POST' ? post(input, init)
      : response({ bundle_uuid: BUNDLE_UUID, payment_received: true, transactions: successfulRecords(posts[0]) }))
    await expect(runRelayrCalls(options)).resolves.toMatchObject({ records: successfulRecords(posts[0]) })
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.requireReview).toHaveBeenCalledTimes(2)
    expect(loadRelayrPendingSession(options.pendingScope)).toBeNull()
  })
})

describe('unpaid Relayr quotes', () => {
  const START = 1_900_000_000_000
  // The first quote is payable until DEADLINE, so it is dead from DEADLINE - 15.
  const DEADLINE = START / 1_000 + 600
  const LAST_PAYABLE = (DEADLINE - 16) * 1_000
  const EXPIRED = (DEADLINE - 15) * 1_000
  const REQUESTS_EXPIRED = START + (RELAYR_FORWARDER_DEADLINE_SECONDS + 60) * 1_000
  const calls: RelayrCall[] = [{ chainId: 1, target: TARGET, data: '0x1234', value: 5n }]
  const next = { calls: [{ chainId: 1 as const, target: BOB, data: '0x5678' as Hex }], account: ALICE, pendingScope: 'next-action' }
  const quotes = (post: number) => [paymentFor({}, post === 0 ? DEADLINE : PAYMENT_DEADLINE)]
  let now: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.stubGlobal('window', localStorageWindow().window)
    now = vi.spyOn(Date, 'now').mockReturnValue(START)
  })

  /** Sign and publish `calls`, then close the funding choice without paying. */
  async function unpaidQuote(scope = 'abandoned') {
    mocks.requireFundingChainSelection.mockRejectedValueOnce(new Error('Funding chain selection cancelled. Nothing was sent.'))
    await expect(runRelayrCalls({ calls, account: ALICE, pendingScope: scope })).rejects.toThrow(/cancelled/)
    expect(loadRelayrPendingSession(scope)).toMatchObject({ paymentStatus: 'unpaid', bundleUuid: BUNDLE_UUID })
  }

  it('stop reserving the wallet\'s forwarder nonce at their payment deadline, and not before', async () => {
    installSuccessfulBundle(quotes)
    await unpaidQuote()
    now.mockReturnValue(LAST_PAYABLE)
    await expect(runRelayrCalls(next)).rejects.toThrow('Another published action')
    now.mockReturnValue(EXPIRED)
    await expect(runRelayrCalls(next)).resolves.toMatchObject({ paymentHash: HASH })
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(2)
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('quote the same calls again, with the requests they published, once the saved quote can no longer be paid', async () => {
    const posts = installSuccessfulBundle(quotes)
    await unpaidQuote()
    now.mockReturnValue(EXPIRED)
    await expect(runRelayrCalls({ calls, account: ALICE, pendingScope: 'abandoned' })).resolves.toMatchObject({ paymentHash: HASH })
    expect(posts).toHaveLength(2)
    expect(posts[1]).toEqual(posts[0])
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(1)
  })

  it('sign the same calls again once every request they published expired unpaid', async () => {
    const posts = installSuccessfulBundle(quotes)
    await unpaidQuote()
    now.mockReturnValue(REQUESTS_EXPIRED)
    await expect(runRelayrCalls({ calls, account: ALICE, pendingScope: 'abandoned' })).resolves.toMatchObject({ paymentHash: HASH })
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(2)
    expect(posts).toHaveLength(2)
    expect(posts[1][0].data).not.toBe(posts[0][0].data)
  })

  it('release a publication whose quote response was lost once every request it published expired', async () => {
    installSuccessfulBundle()
    vi.mocked(fetch).mockImplementationOnce(async () => { throw new DOMException('quote response lost', 'TimeoutError') })
    await expect(runRelayrCalls({ calls, account: ALICE, pendingScope: 'lost' })).rejects.toThrow(/did not return a quote/)
    expect(loadRelayrPendingSession('lost')).toMatchObject({ paymentStatus: 'unpaid', bundleUuid: 'publication-pending' })
    await expect(runRelayrCalls(next)).rejects.toThrow('Another published action')
    now.mockReturnValue(REQUESTS_EXPIRED)
    await expect(runRelayrCalls(next)).resolves.toMatchObject({ paymentHash: HASH })
  })

  it('are not released once a payment was sent', async () => {
    installSuccessfulBundle(quotes)
    mocks.paymentStatuses.set(HASH, 'reverted')
    await expect(runRelayrCalls({ calls, account: ALICE, pendingScope: 'abandoned' })).rejects.toMatchObject({ name: 'RelayrPaymentRevertedError' })
    now.mockReturnValue(EXPIRED)
    await expect(runRelayrCalls(next)).rejects.toThrow('Another published action')
    expect(relayrQuoteReleased(loadRelayrPendingSession('abandoned')!)).toBe(false)
  })

  it('keep a saved publication whose requests cannot run while its quote can still be paid', async () => {
    installSuccessfulBundle(quotes)
    await unpaidQuote()
    const read = mocks.client.readContract.getMockImplementation()!
    mocks.client.readContract.mockImplementation(async input => input.functionName === 'verify' ? false : read(input))
    await expect(runRelayrCalls({ calls, account: ALICE, pendingScope: 'abandoned' })).rejects.toThrow(/authorization or trusted forwarder changed/)
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(1)
    expect(loadRelayrPendingSession('abandoned')).toMatchObject({ paymentStatus: 'unpaid' })
  })
})
