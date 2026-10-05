import { decodeFunctionData, toEventSelector, type Address, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: undefined as Address | undefined,
  client: {
    call: vi.fn(),
    request: vi.fn(),
    estimateGas: vi.fn(),
    readContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getTransaction: vi.fn(),
    getTransactionReceipt: vi.fn(),
    getBlock: vi.fn(),
    getBlockNumber: vi.fn(),
  },
  wallet: { signTypedData: vi.fn(), sendTransaction: vi.fn() },
  getAccount: vi.fn(),
  connectedWallet: vi.fn(),
  requireReview: vi.fn(),
  chooseFunding: vi.fn(),
  runSafeCalls: vi.fn(),
  findPendingSafeTransaction: vi.fn(),
  readAuthorityIdentity: vi.fn(),
  readMatchingAuthorityIdentities: vi.fn(),
  isSafeConnection: vi.fn(),
  waitForSafeExecutionHash: vi.fn(),
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
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requireTransactionReview: mocks.requireReview,
  requireFundingChainSelection: mocks.chooseFunding,
}))
vi.mock('@/lib/safe', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe')>()),
  getSafeNextNonce: async () => 7,
  runSafeCalls: mocks.runSafeCalls,
}))
vi.mock('@bananapus/nana-sdk-core/safe-service', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/safe-service')>()),
  findPendingSafeTransaction: mocks.findPendingSafeTransaction,
}))
vi.mock('@/lib/cross-chain-authority', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/cross-chain-authority')>()),
  readMatchingAuthorityIdentities: mocks.readMatchingAuthorityIdentities,
}))
vi.mock('@bananapus/nana-sdk-core/safe', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/safe')>()),
  readAuthorityIdentity: mocks.readAuthorityIdentity,
}))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: mocks.isSafeConnection,
  SAFE_NONCE_GUIDANCE: 'Choose the correct Safe nonce.',
  waitForSafeExecutionHash: mocks.waitForSafeExecutionHash,
}))

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { functionFromCall } from '@bananapus/nana-sdk-core/review/decode'
import { canonicalSafeTxHash } from '@bananapus/nana-sdk-core/safe-service'
import { buildRulesetConfiguration } from '@bananapus/nana-sdk-core/v6'
import { runAuthorityCalls, type AuthorityCall } from '@/lib/authority'
import { projectBatchScope, runProjectBatch, type ProjectBatchCall } from '@/lib/project-batch'
import { clearRelayrPendingSession, listRelayrPendingScopes, relayrCallsScope, saveRelayrPendingSession } from '@/lib/relayr'
import { buildQueueRulesetsAuthorityCall } from '@/lib/transaction-builders'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x3333333333333333333333333333333333333333' as Address
const SAFE = '0x4444444444444444444444444444444444444444' as Address
const CONTROLLER = '0x5555555555555555555555555555555555555555' as Address
const OTHER_CONTROLLER = '0x6666666666666666666666666666666666666666' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex
const DESTINATION_HASH = `0x${'cd'.repeat(32)}` as Hex
const BUNDLE_UUID = '01234567-89ab-cdef-0123-456789abcdef'
const TX_UUIDS = [
  'fedcba98-7654-3210-fedc-ba9876543210',
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
]
const PAYMENT_ADDRESS = '0x1c05f7841379d4393574c0ffa17908ec40ffd97d' as Address
const NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address
const PAYMENT_DEADLINE = 4_000_000_000
const PAYMENT_CALLDATA = `0x103903a7${BUNDLE_UUID.replaceAll('-', '').padEnd(64, '0')}${BigInt(PAYMENT_DEADLINE).toString(16).padStart(64, '0')}` as Hex
const PAYMENT_RUNTIME = '0x608060405260043610156010575f80fd5b5f3560e01c63103903a7146022575f80fd5b604036600319011260ef576004356fffffffffffffffffffffffffffffffff19811680910360ef5760243564ffffffffff811680910360ef5780421160ce575f341560c6575b5f8080809373755ff2f75a0a586ecfa2b9a3c959cb662458a1053491f11560bb5760407fb96b060a9c075a83da0cf1f9405deeb5df21df681a762de16c3d5eaf99531cd8918151903482526020820152a2005b6040513d5f823e3d90fd5b506108fc6068565b90630f01bd8760e21b5f5260045260245264ffffffffff421660445260645ffd5b5f80fdfea26469706673582212206ea0d2ba1e0cb26cc9293b24f1a7aecc1de7e328ca83d6b3bf5382ac44c7390064736f6c634300081a0033' as Hex

const SAFE_PROPOSAL_SUCCESS = {
  address: SAFE,
  topics: [toEventSelector('ExecutionSuccess(bytes32,uint256)'), HASH],
  data: `0x${'00'.repeat(32)}` as Hex,
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  for (const scope of listRelayrPendingScopes()) clearRelayrPendingSession(scope)
  const storage = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size },
  } })
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, run: (lock: object) => Promise<unknown>) => run({}) } })
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
  mocks.chooseFunding.mockResolvedValue(1)
  mocks.readAuthorityIdentity.mockResolvedValue({ kind: 'eoa' })
  mocks.isSafeConnection.mockReturnValue(false)
  mocks.findPendingSafeTransaction.mockResolvedValue(null)
  mocks.waitForSafeExecutionHash.mockResolvedValue(DESTINATION_HASH)
  mocks.readMatchingAuthorityIdentities.mockResolvedValue({
    source: { kind: 'eoa' },
    destination: { kind: 'eoa' },
    matches: true,
  })
  mocks.client.call.mockResolvedValue({ data: '0x' })
  mocks.client.request.mockImplementation(async ({ method, params }) => {
    if (method === 'eth_getCode') return PAYMENT_RUNTIME
    if (method === 'eth_call') return params?.[0]?.data?.startsWith('0x572b6c05') ? `0x${'0'.repeat(63)}1` : '0x'
    throw new Error(`Unexpected RPC method ${method}`)
  })
  mocks.client.readContract.mockImplementation(async input => {
    if (input.functionName === 'eip712Domain') {
      return ['0x0f', 'JBForwarder', '1', 1n, TARGET, '0x00', []]
    }
    if (input.functionName === 'nonces') return 4n
    if (input.functionName === 'verify') return true
    throw new Error(`Unexpected read ${input.functionName}`)
  })
  // A Safe app's execution logs the Safe's ExecutionSuccess for its proposal.
  mocks.client.waitForTransactionReceipt.mockImplementation(async ({ hash }) => ({
    transactionHash: hash,
    status: 'success',
    logs: [SAFE_PROPOSAL_SUCCESS],
  }))
  mocks.wallet.signTypedData.mockResolvedValue(`0x${'11'.repeat(65)}`)
  mocks.wallet.sendTransaction.mockResolvedValue(HASH)
  let entries: { chain: number; target: Address; data: Hex; value: string }[] = []
  mocks.client.getTransaction.mockImplementation(async ({ hash }) => {
    const entry = entries[hash === DESTINATION_HASH ? 0 : 1]
    return { hash, to: entry.target, input: entry.data, value: BigInt(entry.value), chainId: entry.chain, blockHash: HASH }
  })
  mocks.client.getTransactionReceipt.mockImplementation(async ({ hash }) => ({ transactionHash: hash, status: 'success', blockHash: HASH, blockNumber: 1n, logs: [SAFE_PROPOSAL_SUCCESS] }))
  mocks.client.getBlock.mockResolvedValue({ hash: HASH })
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/bundle/prepaid') && init?.method === 'POST') {
      entries = JSON.parse(String(init.body)).transactions
      return response({
        bundle_uuid: BUNDLE_UUID,
        payment_info: [
          {
            chain: 1,
            amount: '100',
            calldata: PAYMENT_CALLDATA,
            target: PAYMENT_ADDRESS,
            token: NATIVE_TOKEN,
            payment_deadline: PAYMENT_DEADLINE,
          },
        ],
        transactions: entries.map((request, index) => ({ tx_uuid: TX_UUIDS[index], request })),
        txn_uuids: TX_UUIDS,
      })
    }
    if (url.endsWith(`/v1/bundle/${BUNDLE_UUID}`)) {
      return response({
        transactions: [
          { chain: 1, tx_uuid: TX_UUIDS[0], status: { state: 'success', data: { hash: DESTINATION_HASH } } },
          { chain: 10, tx_uuid: TX_UUIDS[1], status: { state: 'success', data: { hash: HASH } } },
        ],
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
})

describe('relayed ruleset queue', () => {
  it("wallet-action:queue-rulesets-across-selected-mainnets queues each mainnet's rules on its own controller and project behind one Relayr payment", async () => {
    mocks.client.estimateGas.mockResolvedValue(300_000n)
    const configuration = buildRulesetConfiguration({
      mustStartAtOrAfter: 1_800_000_000,
      duration: 604_800,
      weight: 1_000n * 10n ** 18n,
      weightCutPercent: 25_000_000,
    })
    const calls = ([[1, CONTROLLER, 7n], [10, OTHER_CONTROLLER, 9n]] as const).map(
      ([chainId, controller, projectId]) => buildQueueRulesetsAuthorityCall({
        chainId, authority: ALICE, controller, projectId,
        rulesetConfigurations: [configuration], memo: '', label: 'Queue new rules',
      }),
    )

    const result = await runAuthorityCalls({ calls })

    expect(result.relayrGroups).toBe(1)
    // Each chain's signed request queues its own project's rules on its own controller.
    const signed = mocks.wallet.signTypedData.mock.calls.map(([{ domain, message }]) => ({
      chainId: domain.chainId,
      to: message.to,
      call: decodeFunctionData({ abi: calls[0].abi!, data: message.data }),
    }))
    expect(signed).toEqual([
      { chainId: 1n, to: CONTROLLER, call: { functionName: 'queueRulesetsOf', args: [7n, [configuration], ''] } },
      { chainId: 10n, to: OTHER_CONTROLLER, call: { functionName: 'queueRulesetsOf', args: [9n, [configuration], ''] } },
    ])
    // Each queue is reviewed decoded, and one payment funds both.
    const reviewed = mocks.requireReview.mock.calls.flatMap(([request]) => request.calls ?? [])
    expect(reviewed.filter(call => functionFromCall(call)?.name === 'queueRulesetsOf')).toHaveLength(2)
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ to: PAYMENT_ADDRESS, data: PAYMENT_CALLDATA }),
    )
  })
})

describe('Authority gas estimation reaches the signed Relayr request', () => {
  it.each([
    [1, 11155111],
    [1, 1],
  ] as const)('rejects direct batches on chains %s and %s before sending their first call', async (first, second) => {
    await expect(runAuthorityCalls({ calls: [
      { chainId: first, authority: ALICE, target: TARGET, data: '0x1234' },
      { chainId: second, authority: ALICE, target: TARGET, data: '0x5678' },
    ] })).rejects.toThrow(/Select one chain and one action at a time/)
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    expect(mocks.chooseFunding).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('rejects an untrusted-forwarder batch before any direct write can be replayed', async () => {
    mocks.client.request.mockResolvedValue('0x')
    await expect(runAuthorityCalls({ calls: [
      { chainId: 1, authority: ALICE, target: TARGET, data: '0x1234' },
      { chainId: 10, authority: ALICE, target: TARGET, data: '0x5678' },
    ] })).rejects.toThrow(/Select one chain and one action at a time/)
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('preserves a single direct testnet call from the real authority', async () => {
    mocks.client.estimateGas.mockResolvedValue(21_000n)
    const result = await runAuthorityCalls({ calls: [
      { chainId: 11155111, authority: ALICE, target: TARGET, data: '0x1234' },
    ] })
    expect(result.directResults).toEqual([HASH])
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ account: ALICE }))
  })

  it('recovers a submitted bundle before callbacks inspect already changed project state', async () => {
    const reverifyAuthority = vi.fn().mockRejectedValue(new Error('Queue already changed'))
    const calls: AuthorityCall[] = [
      { chainId: 1, authority: ALICE, target: TARGET, data: '0x1234', reverifyAuthority },
      { chainId: 10, authority: ALICE, target: TARGET, data: '0x5678', reverifyAuthority },
    ]
    const scope = relayrCallsScope(calls)
    saveRelayrPendingSession(scope, { bundleUuid: BUNDLE_UUID, paymentHash: HASH,
      paymentChainId: 1, paymentStatus: 'submitted', chainIds: [1, 10], expectedCount: 2,
      records: [], itemCount: 2, account: ALICE, createdAt: Date.now() })
    try {
      await expect(runAuthorityCalls({ calls })).rejects.toThrow(/lacks exact destination proof/)
      expect(reverifyAuthority).not.toHaveBeenCalled()
      expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    } finally { clearRelayrPendingSession(scope) }
  })

  it('rechecks an unpaid saved action after funding review before sending its payment', async () => {
    let changed = false
    const reverifyAuthority = vi.fn(async () => {
      if (changed) throw new Error('The original queue changed during review')
    })
    const calls: AuthorityCall[] = [
      { chainId: 1, authority: ALICE, target: TARGET, data: '0x1234', reverifyAuthority },
      { chainId: 10, authority: ALICE, target: TARGET, data: '0x5678', reverifyAuthority },
    ]
    const scope = relayrCallsScope(calls)
    mocks.client.estimateGas.mockResolvedValue(21_000n)
    mocks.chooseFunding.mockRejectedValueOnce(new Error('Selection canceled'))
    try {
      await expect(runAuthorityCalls({ calls })).rejects.toThrow('Selection canceled')
      mocks.requireReview.mockImplementation(async review => {
        if (review.title === 'Review Relayr payment') changed = true
      })
      await expect(runAuthorityCalls({ calls })).rejects.toThrow('The original queue changed during review')
      expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(2)
      expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    } finally { clearRelayrPendingSession(scope) }
  })

  it('routes a matching delegated EOA project-handle claim as a direct EOA call', async () => {
    const delegated = {
      kind: 'delegated-eoa' as const,
      delegation: TARGET,
    }
    mocks.readAuthorityIdentity.mockResolvedValue(delegated)
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: { kind: 'eoa' },
      destination: delegated,
      matches: true,
    })

    const result = await runAuthorityCalls({
      calls: [
        {
          chainId: 1,
          detectionChainId: 10,
          authority: ALICE,
          target: TARGET,
          data: '0x1234',
        },
      ],
    })

    expect(result.directResults).toEqual([HASH])
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ account: ALICE, to: TARGET, data: '0x1234' }),
    )
    expect(mocks.runSafeCalls).not.toHaveBeenCalled()
  })

  it('never treats a source-chain Safe as an EOA when its destination proxy is missing', async () => {
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: {
        kind: 'safe',
        threshold: 2,
        owners: [ALICE],
        hasModules: false,
        modules: [],
      },
      destination: { kind: 'eoa' },
      matches: false,
    })

    await expect(
      runAuthorityCalls({
        calls: [
          {
            chainId: 1,
            detectionChainId: 10,
            authority: SAFE,
            target: TARGET,
            data: '0x1234',
          },
        ],
      }),
    ).rejects.toThrow(
      /Safe on Optimism.*not deployed on Ethereum.*Deploy same Safe on Ethereum.*project handle editor/,
    )
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.client.request).not.toHaveBeenCalled()
  })

  it('rejects a source Safe whose mainnet address is a delegated EOA', async () => {
    mocks.readAuthorityIdentity.mockResolvedValue({
      kind: 'delegated-eoa',
      delegation: TARGET,
    })
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: {
        kind: 'safe',
        threshold: 1,
        owners: [ALICE],
        hasModules: false,
        modules: [],
      },
      destination: { kind: 'delegated-eoa', delegation: TARGET },
      matches: false,
    })

    await expect(
      runAuthorityCalls({
        calls: [
          {
            chainId: 1,
            detectionChainId: 10,
            authority: SAFE,
            target: TARGET,
            data: '0x1234',
          },
        ],
      }),
    ).rejects.toThrow(/Safe on Optimism.*occupied by an EIP-7702 delegated EOA/i)
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    expect(mocks.runSafeCalls).not.toHaveBeenCalled()
  })

  it('detects on the project chain but queues the Safe call on mainnet', async () => {
    mocks.readAuthorityIdentity.mockResolvedValue({
      kind: 'safe',
      threshold: 2,
      owners: [ALICE],
    })
    mocks.runSafeCalls.mockResolvedValue([])
    mocks.client.estimateGas.mockResolvedValue(21_000n)
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: {
        kind: 'safe',
        threshold: 2,
        owners: [ALICE],
        hasModules: false,
        modules: [],
      },
      destination: {
        kind: 'safe',
        threshold: 2,
        owners: [ALICE],
        hasModules: false,
        modules: [],
      },
      matches: true,
    })

    await runAuthorityCalls({
      calls: [
        {
          chainId: 1,
          detectionChainId: 10,
          authority: SAFE,
          target: TARGET,
          data: '0x1234',
        },
      ],
    })

    // Safe dispatch is determined on the call chain; detectionChainId is
    // verified independently by the fail-closed identity parity read.
    expect(mocks.readAuthorityIdentity).toHaveBeenCalledWith(
      mocks.client,
      SAFE,
    )
    expect(mocks.runSafeCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        signer: ALICE,
        calls: [
          expect.objectContaining({
            chainId: 1,
            safe: SAFE,
            target: TARGET,
            data: '0x1234',
          }),
        ],
      }),
    )
    expect(mocks.connectedWallet).not.toHaveBeenCalled()
  })

  it("refuses a Safe whose creation can't be proven on the call's chain, in one line", async () => {
    const safe = { kind: 'safe', threshold: 2, owners: [ALICE], hasModules: false, modules: [] }
    mocks.readAuthorityIdentity.mockResolvedValue(safe)
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: safe,
      destination: safe,
      matches: false,
      creationUnproven: true,
    })

    await expect(
      runAuthorityCalls({
        calls: [{ chainId: 1, detectionChainId: 10, authority: SAFE, target: TARGET, data: '0x1234' }],
      }),
    ).rejects.toThrow(new Error("Can't verify this Safe is the same on Ethereum."))
    expect(mocks.readMatchingAuthorityIdentities).toHaveBeenCalledWith(
      expect.objectContaining({ sourceChainId: 10, authority: SAFE }),
    )
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.runSafeCalls).not.toHaveBeenCalled()
  })

  it('rejects divergent cross-chain Safe control before review', async () => {
    mocks.readAuthorityIdentity.mockResolvedValue({
      kind: 'safe',
      threshold: 1,
      owners: [ALICE],
    })
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: {
        kind: 'safe',
        threshold: 2,
        owners: [ALICE, TARGET],
        hasModules: false,
        modules: [],
      },
      destination: {
        kind: 'safe',
        threshold: 1,
        owners: [ALICE],
        hasModules: false,
        modules: [],
      },
      matches: false,
    })

    await expect(
      runAuthorityCalls({
        calls: [
          {
            chainId: 1,
            detectionChainId: 10,
            authority: SAFE,
            target: TARGET,
            data: '0x1234',
          },
        ],
      }),
    ).rejects.toThrow(/do not have the same current owners, threshold/)
    expect(mocks.requireReview).not.toHaveBeenCalled()
  })

  it('tracks a Safe app proposal through execution before returning success', async () => {
    mocks.account = SAFE
    mocks.isSafeConnection.mockReturnValue(true)
    mocks.readAuthorityIdentity.mockResolvedValue({
      kind: 'safe',
      threshold: 2,
      owners: [ALICE],
    })
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: {
        kind: 'safe',
        threshold: 2,
        owners: [ALICE],
        hasModules: false,
        modules: [],
      },
      destination: {
        kind: 'safe',
        threshold: 2,
        owners: [ALICE],
        hasModules: false,
        modules: [],
      },
      matches: true,
    })
    mocks.connectedWallet.mockResolvedValueOnce({
      wallet: mocks.wallet,
      account: SAFE,
    })
    mocks.client.estimateGas.mockResolvedValue(21_000n)

    const result = await runAuthorityCalls({
      calls: [
        {
          chainId: 1,
          detectionChainId: 10,
          authority: SAFE,
          target: TARGET,
          data: '0x1234',
        },
      ],
    })

    expect(mocks.runSafeCalls).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ account: SAFE, to: TARGET, data: '0x1234' }),
    )
    expect(mocks.waitForSafeExecutionHash).toHaveBeenCalledWith(
      1,
      HASH,
    )
    expect(result.directResults).toEqual([DESTINATION_HASH])
  })

  it('fails a Safe app proposal whose execution logged ExecutionFailure', async () => {
    mocks.account = SAFE
    mocks.isSafeConnection.mockReturnValue(true)
    mocks.readAuthorityIdentity.mockResolvedValue({
      kind: 'safe',
      threshold: 2,
      owners: [ALICE],
    })
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: { kind: 'safe', threshold: 2, owners: [ALICE], hasModules: false, modules: [] },
      destination: { kind: 'safe', threshold: 2, owners: [ALICE], hasModules: false, modules: [] },
      matches: true,
    })
    mocks.connectedWallet.mockResolvedValueOnce({ wallet: mocks.wallet, account: SAFE })
    mocks.client.estimateGas.mockResolvedValue(21_000n)
    // A nonzero safeTxGas set in Safe makes a failed call log ExecutionFailure
    // (Safe 1.3 puts the safeTxHash in the data) inside a successful receipt.
    mocks.client.waitForTransactionReceipt.mockImplementation(async ({ hash }) => ({
      transactionHash: hash,
      status: 'success',
      logs: [
        {
          address: SAFE,
          topics: [toEventSelector('ExecutionFailure(bytes32,uint256)')],
          data: `${HASH}${'00'.repeat(32)}`,
        },
      ],
    }))

    await expect(
      runAuthorityCalls({
        calls: [
          {
            chainId: 1,
            detectionChainId: 10,
            authority: SAFE,
            target: TARGET,
            data: '0x1234',
            label: 'Set the terminal',
          },
        ],
      }),
    ).rejects.toThrow('Set the terminal reverted after Safe execution.')
  })

  it("does not report a Safe app proposal whose execution doesn't show it ran", async () => {
    mocks.account = SAFE
    mocks.isSafeConnection.mockReturnValue(true)
    mocks.readAuthorityIdentity.mockResolvedValue({ kind: 'safe', threshold: 2, owners: [ALICE] })
    mocks.connectedWallet.mockResolvedValueOnce({ wallet: mocks.wallet, account: SAFE })
    mocks.client.estimateGas.mockResolvedValue(21_000n)
    mocks.client.waitForTransactionReceipt.mockImplementation(async ({ hash }) => ({
      transactionHash: hash,
      status: 'success',
      logs: [],
    }))

    await expect(
      runAuthorityCalls({
        calls: [{ chainId: 1, authority: SAFE, target: TARGET, data: '0x1234', label: 'Set the terminal' }],
      }),
    ).rejects.toThrow(
      'Safe proposal submitted, but confirmation is unavailable. Check Safe before taking another action.',
    )
  })

  it('reuses an exact pending Safe app proposal without sending a duplicate', async () => {
    mocks.account = SAFE
    mocks.isSafeConnection.mockReturnValue(true)
    mocks.readAuthorityIdentity.mockResolvedValue({
      kind: 'safe',
      threshold: 2,
      owners: [ALICE],
    })
    const pending = {
      to: TARGET,
      value: '0',
      data: '0x1234' as Hex,
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: '0x0000000000000000000000000000000000000000' as Address,
      refundReceiver: '0x0000000000000000000000000000000000000000' as Address,
      nonce: 7,
    }
    mocks.findPendingSafeTransaction.mockResolvedValue(pending)

    const result = await runAuthorityCalls({
      calls: [
        {
          chainId: 1,
          authority: SAFE,
          target: TARGET,
          data: '0x1234',
        },
      ],
    })

    expect(mocks.findPendingSafeTransaction).toHaveBeenCalledWith(
      1,
      SAFE,
      7,
      { to: TARGET, data: '0x1234', value: undefined },
      expect.objectContaining({ fetch: expect.any(Function) }),
    )
    expect(result.safeResults).toEqual([
      expect.objectContaining({
        status: 'queued',
        nonce: 7,
        safeTxHash: canonicalSafeTxHash(1, SAFE, pending),
      }),
    ])
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    expect(mocks.waitForSafeExecutionHash).not.toHaveBeenCalled()
  })

  it('rejects an owner-shaped spoof contract before Safe authorization', async () => {
    mocks.readAuthorityIdentity.mockResolvedValue({ kind: 'contract' })

    await expect(
      runAuthorityCalls({
        calls: [
          {
            chainId: 1,
            authority: SAFE,
            target: TARGET,
            data: '0x1234',
          },
        ],
      }),
    ).rejects.toThrow(/unsupported contract.*canonical Safe/i)

    expect(mocks.runSafeCalls).not.toHaveBeenCalled()
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('signs each ForwardRequest with the measured 2x estimate, not the 500k fallback', async () => {
    // A forwarded call that needs more than the 500k fallback: the OZ
    // forwarder caps the inner call at request.gas and reverts execute() when
    // the inner call runs out — AFTER the user paid Relayr for the bundle.
    mocks.client.estimateGas
      .mockResolvedValueOnce(800_000n) // chain 1 destination estimate
      .mockResolvedValueOnce(600_000n) // chain 10 destination estimate
      .mockResolvedValue(21_000n)

    const calls: AuthorityCall[] = [
      { chainId: 1, authority: ALICE, target: TARGET, data: '0x1234' },
      { chainId: 10, authority: ALICE, target: TARGET, data: '0x5678' },
    ]
    const result = await runAuthorityCalls({ calls })

    expect(result.relayrGroups).toBe(1)
    expect(mocks.client.request).toHaveBeenCalledWith({
      method: 'eth_call',
      params: [
        expect.objectContaining({
          from: ALICE,
          gas: '0x989680',
          to: TARGET,
        }),
        'latest',
      ],
    })
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(2)
    const signedGas = mocks.wallet.signTypedData.mock.calls.map(
      ([{ message }]) => message.gas,
    )
    expect(signedGas).toEqual([1_600_000n, 1_200_000n])
  })

  it('sends the measured gas, not the builder cap the wallet would reserve', async () => {
    // A wallet reserves gas * maxFeePerGas up front, so sending a 1M-gas
    // simulation cap demands ~0.003 ETH on Ethereum for a handle claim that
    // burns a fraction of it — funded accounts were rejected before signing.
    mocks.client.estimateGas.mockResolvedValue(120_000n)

    const calls: AuthorityCall[] = [
      {
        chainId: 1,
        authority: ALICE,
        target: TARGET,
        data: '0x1234',
        gas: 1_000_000n,
      },
    ]
    await runAuthorityCalls({ calls })

    expect(mocks.client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        params: [expect.objectContaining({ gas: '0xf4240' }), 'latest'],
      }),
    )
    // Estimation stays bounded by the reviewed cap.
    expect(mocks.client.estimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 1_000_000n }),
    )
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 240_000n }),
    )
  })

  it('reviews the exact gas limit it sends', async () => {
    mocks.client.estimateGas.mockResolvedValue(120_000n)

    await runAuthorityCalls({
      calls: [{ chainId: 1, authority: ALICE, target: TARGET, data: '0x1234', gas: 1_000_000n }],
    })

    const reviewed = mocks.requireReview.mock.calls[0][0].calls
    expect(reviewed).toEqual([expect.objectContaining({ gas: 240_000n })])
    expect(reviewed[0]).not.toHaveProperty('safeTxGas')
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: reviewed[0].gas }),
    )
  })

  it('proposes through a Safe app with safeTxGas 0 and reviews it', async () => {
    mocks.account = SAFE
    mocks.isSafeConnection.mockReturnValue(true)
    mocks.readAuthorityIdentity.mockResolvedValue({ kind: 'safe', threshold: 2, owners: [ALICE] })
    mocks.connectedWallet.mockResolvedValueOnce({ wallet: mocks.wallet, account: SAFE })
    mocks.client.estimateGas.mockResolvedValue(21_000n)

    await runAuthorityCalls({
      calls: [{ chainId: 1, authority: SAFE, target: TARGET, data: '0x1234' }],
    })

    const reviewed = mocks.requireReview.mock.calls[0][0].calls
    expect(reviewed).toEqual([expect.objectContaining({ safeTxGas: 0n })])
    expect(reviewed[0]).not.toHaveProperty('gas')
    // The Safe app signs the sent gas as safeTxGas: 0 makes a failed call revert.
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 0n }),
    )
  })

  it('preselects the funding chain the wallet started on before signing switched chains', async () => {
    mocks.client.estimateGas.mockResolvedValue(21_000n)
    let connectedChain = 8453
    mocks.getAccount.mockImplementation(() => ({ address: mocks.account, chainId: connectedChain }))
    mocks.connectedWallet.mockImplementation(async (chainId: number) => {
      connectedChain = chainId
      return { wallet: mocks.wallet, account: ALICE }
    })

    await runAuthorityCalls({ calls: [
      { chainId: 1, authority: ALICE, target: TARGET, data: '0x1234' },
      { chainId: 10, authority: ALICE, target: TARGET, data: '0x5678' },
    ] })

    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(2)
    expect(connectedChain).not.toBe(8453)
    expect(mocks.chooseFunding).toHaveBeenCalledExactlyOnceWith(expect.any(Array), 8453)
  })

  it('never sends more than the builder cap', async () => {
    mocks.client.estimateGas.mockResolvedValue(900_000n)

    await runAuthorityCalls({
      calls: [
        {
          chainId: 1,
          authority: ALICE,
          target: TARGET,
          data: '0x1234',
          gas: 1_000_000n,
        },
      ],
    })

    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 1_000_000n }),
    )
  })

  it('keeps the builder cap when the node cannot estimate', async () => {
    mocks.client.estimateGas.mockRejectedValue(new Error('cannot estimate'))

    await runAuthorityCalls({
      calls: [
        {
          chainId: 1,
          authority: ALICE,
          target: TARGET,
          data: '0x1234',
          gas: 1_000_000n,
        },
      ],
    })

    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 1_000_000n }),
    )
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

describe('Authority calls a parent review already covered', () => {
  it('sends a direct call without reviewing it again, at its measured gas', async () => {
    mocks.client.estimateGas.mockResolvedValue(120_000n)

    await runAuthorityCalls({
      calls: [{ chainId: 1, authority: ALICE, target: TARGET, data: '0x1234', gas: 1_000_000n }],
      reviewedInParent: true,
    })

    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ to: TARGET, data: '0x1234', gas: 240_000n }),
    )
  })

  it('proposes a Safe app call without reviewing it again, at Safe gas 0', async () => {
    mocks.account = SAFE
    mocks.isSafeConnection.mockReturnValue(true)
    mocks.readAuthorityIdentity.mockResolvedValue({ kind: 'safe', threshold: 2, owners: [ALICE] })
    mocks.connectedWallet.mockResolvedValueOnce({ wallet: mocks.wallet, account: SAFE })
    mocks.client.estimateGas.mockResolvedValue(21_000n)

    await runAuthorityCalls({
      calls: [{ chainId: 1, authority: SAFE, target: TARGET, data: '0x1234' }],
      reviewedInParent: true,
    })

    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ account: SAFE, to: TARGET, data: '0x1234', gas: 0n }),
    )
  })

  it('still reviews each relayed signature and the payment', async () => {
    mocks.client.estimateGas.mockResolvedValue(21_000n)

    await runAuthorityCalls({
      calls: [
        { chainId: 1, authority: ALICE, target: TARGET, data: '0x1234' },
        { chainId: 10, authority: ALICE, target: TARGET, data: '0x5678' },
      ],
      reviewedInParent: true,
    })

    expect(mocks.requireReview.mock.calls.map(([review]) => review.title)).toEqual([
      'Review relayed transaction',
      'Review relayed transaction',
      'Review Relayr payment',
    ])
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(2)
  })
})

describe('One safety-check review per project batch', () => {
  const batchCall = (
    chainId: JBChainId,
    data: Hex,
    extra: Partial<ProjectBatchCall> = {},
  ): ProjectBatchCall => ({
    id: `${chainId}:${data}`, projectId: 7, chainId, authority: ALICE, target: TARGET,
    data, gas: 1_000_000n, relayr: false, ...extra,
  })
  const run = (calls?: ProjectBatchCall[], account: Address = ALICE) => runProjectBatch({
    scope: projectBatchScope('review-once', 1, 7), action: 'review-once', account, calls,
  })
  // Each receipt belongs to the exact call the wallet last sent.
  const receiptsProveSends = () => mocks.client.getTransaction.mockImplementation(async ({ hash }) => {
    const [sent] = mocks.wallet.sendTransaction.mock.calls.at(-1)!
    return { hash, chainId: 1, from: sent.account, to: sent.to, input: sent.data, value: sent.value, blockHash: HASH }
  })

  beforeEach(() => {
    mocks.client.getBlockNumber.mockResolvedValue(1n)
    mocks.client.estimateGas.mockResolvedValue(120_000n)
  })

  it('sends every direct call after one review, each at its measured gas', async () => {
    receiptsProveSends()

    const batch = await run([batchCall(1, '0x1234'), batchCall(1, '0x5678')])

    expect(batch.status).toBe('complete')
    expect(mocks.requireReview).toHaveBeenCalledTimes(1)
    const [review] = mocks.requireReview.mock.calls[0]
    expect(review.calls.map((call: { data: Hex }) => call.data)).toEqual(['0x1234', '0x5678'])
    // A cap is not the gas limit sent; the wallet shows the measured one.
    for (const call of review.calls) {
      expect(call).not.toHaveProperty('gas')
      expect(call).not.toHaveProperty('safeTxGas')
    }
    expect(mocks.wallet.sendTransaction.mock.calls.map(([tx]) => [tx.data, tx.gas])).toEqual([
      ['0x1234', 240_000n],
      ['0x5678', 240_000n],
    ])
  })

  it('reviews each send again when resuming a saved batch', async () => {
    receiptsProveSends()
    mocks.wallet.sendTransaction
      .mockResolvedValueOnce(HASH)
      .mockRejectedValueOnce(Object.assign(new Error('User rejected'), { code: 4001 }))
    await expect(run([batchCall(1, '0x1234'), batchCall(1, '0x5678')])).rejects.toThrow('User rejected')
    expect(mocks.requireReview).toHaveBeenCalledTimes(1)

    expect((await run()).status).toBe('complete')

    expect(mocks.requireReview).toHaveBeenCalledTimes(2)
    expect(mocks.requireReview.mock.calls[1][0]).toMatchObject({
      title: 'Review transaction',
      calls: [expect.objectContaining({ data: '0x5678', gas: 240_000n })],
    })
  })

  it('proposes every Safe app call after one review showing Safe gas 0', async () => {
    mocks.account = SAFE
    mocks.isSafeConnection.mockReturnValue(true)
    mocks.readAuthorityIdentity.mockResolvedValue({ kind: 'safe', threshold: 2, owners: [ALICE] })
    mocks.connectedWallet.mockResolvedValue({ wallet: mocks.wallet, account: SAFE })
    receiptsProveSends()

    const batch = await run([batchCall(1, '0x1234', { authority: SAFE })], SAFE)

    expect(batch.status).toBe('complete')
    expect(mocks.requireReview).toHaveBeenCalledTimes(1)
    const [review] = mocks.requireReview.mock.calls[0]
    expect(review.description).toMatch(/Choose the correct Safe nonce\.$/)
    expect(review.confirmLabel).toBe('Agree & continue to Safe')
    expect(review.calls).toEqual([
      expect.objectContaining({ from: SAFE, to: TARGET, data: '0x1234', safeTxGas: 0n }),
    ])
    expect(review.calls[0]).not.toHaveProperty('gas')
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ account: SAFE, data: '0x1234', gas: 0n }),
    )
  })

  it('still reviews each relayed signature and the payment after the batch review', async () => {
    const batch = await run([
      batchCall(1, '0x1234', { relayr: undefined }),
      batchCall(10, '0x5678', { relayr: undefined }),
    ])

    expect(batch.status).toBe('complete')
    expect(mocks.requireReview.mock.calls.map(([review]) => review.title)).toEqual([
      'Review project actions',
      'Review relayed transaction',
      'Review relayed transaction',
      'Review Relayr payment',
    ])
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(2)
  })
})
