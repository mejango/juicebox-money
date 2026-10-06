import { erc2771ForwarderAbi, jbContractAddress, JBCoreContracts, type JBChainId } from '@bananapus/nana-sdk-core'
import { RESERVED_TOKEN_SPLIT_GROUP_ID, v6Address } from '@bananapus/nana-sdk-core/v6'
import { encodeFunctionData, parseEther, toFunctionSelector, zeroAddress, type Address, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The split, ruleset-queue and metadata editors' own recheck callbacks, run by
// the real authority router and Relayr flow (ruling R114): a saved session's
// requests are classified before the editor rechecks the project.
const mocks = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as `0x${string}`,
  clients: new Map<number, unknown>(),
  wallet: { signTypedData: vi.fn(), sendTransaction: vi.fn() },
  connectedWallet: vi.fn(),
  requireReview: vi.fn(),
  chooseFunding: vi.fn(),
  identity: vi.fn(),
  current: vi.fn(),
  upcoming: vi.fn(),
  contexts: vi.fn(),
  permissions: vi.fn(),
}))

vi.mock('@wagmi/core', async importOriginal => ({
  ...await importOriginal<typeof import('@wagmi/core')>(),
  getAccount: () => ({ address: mocks.account, chainId: 1 }),
  getPublicClient: (_config: unknown, { chainId }: { chainId: number }) => mocks.clients.get(chainId),
}))
vi.mock('@/providers/Providers', () => ({
  wagmiConfig: {},
  SUPPORTED_CHAINS: [{ id: 1, name: 'Ethereum' }, { id: 8453, name: 'Base' }],
}))
vi.mock('@/lib/wallet-core', () => ({
  publicClient: (chainId: number) => mocks.clients.get(chainId),
  connectedWallet: mocks.connectedWallet,
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/transaction-review')>(),
  requireTransactionReview: mocks.requireReview,
  requireFundingChainSelection: mocks.chooseFunding,
}))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/safe-connector')>(),
  isSafeConnection: () => false,
}))
vi.mock('@/lib/cross-chain-authority', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/cross-chain-authority')>(),
  readAuthorityIdentity: mocks.identity,
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: mocks.account, isConnected: true }) }))
vi.mock('@/components/ui/ModalShell', () => ({
  ModalShell: ({ children }: { children: unknown }) => children,
  useHoldEnclosingModal: () => {},
  useEnclosingModalCard: () => null,
}))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))
vi.mock('@/components/LoadingSkeletons', () => ({ ActionRowsSkeleton: () => null, FormCardSkeleton: () => null, FormFieldsSkeleton: () => null }))
vi.mock('@/components/ui/AddressLabel', () => ({ AddressLabel: () => null, AddressText: () => null }))
vi.mock('@/lib/token-symbol', () => ({ tokenSymbol: async () => 'ETH' }))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getCurrentRuleset: mocks.current,
  getUpcomingRuleset: mocks.upcoming,
  getAccountingContexts: mocks.contexts,
  hasPermissions: mocks.permissions,
}))

import { runAuthorityCalls, type AuthorityCall } from '@/lib/authority'
import { clearRelayrPendingSession, listRelayrPendingScopes, loadRelayrPendingSession, relayrCallsScope, saveRelayrPendingSession } from '@/lib/relayr'
import { assembleReservedDestination, reviewedSplitCalls, type SplitReview, type SplitSnapshot } from '@/components/project/EditSplitsFlow'
import { buildQueueDestinationConfig, reviewedQueueCalls } from '@/components/project/QueueRulesetFlow'
import { metadataReviewCalls, type MetadataReview } from '@/components/project/AuthorityEditsCard'
import { newDraftSplit } from '@/components/create/SplitsEditor'
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'

/** A flow that never ends, for runs whose signal is not under test. */
const flow = new AbortController().signal

const ALICE = mocks.account as Address
const OTHER = '0x3333333333333333333333333333333333333333' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const BLOCK_HASH = `0x${'45'.repeat(32)}` as Hex
const BUNDLE_UUID = '01234567-89ab-cdef-0123-456789abcdef'
const TRUSTED_FORWARDER = toFunctionSelector('isTrustedForwarder(address)')
const NOW = 1_800_000_000
/** The old requests' deadline; the finalized block is past it unless a test says otherwise. */
const DEADLINE = NOW - 3_600
const CHAINS = [1, 8453] as const
const PROJECTS: Record<number, number> = { 1: 101, 8453: 303 }

/** The live state each chain reads, by function name. */
const live = new Map<number, Record<string, (args: readonly unknown[]) => unknown>>()
/** The forwarder's nonce for Alice on each chain. */
let nonces: Record<number, bigint>
let storage: Map<string, string>

function chainClient(chainId: number) {
  return {
    chain: { id: chainId },
    readContract: vi.fn(async ({ functionName, args = [] }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === 'eip712Domain') return ['0x0f', 'JBForwarder', '1', BigInt(chainId), OTHER, '0x00', []]
      if (functionName === 'nonces') return nonces[chainId]
      if (functionName === 'verify') return true
      const read = live.get(chainId)?.[functionName]
      if (!read) throw new Error(`Unexpected read ${functionName} on ${chainId}`)
      return read(args)
    }),
    request: vi.fn(async ({ method, params }: { method: string; params: [{ data?: string }] }) => {
      if (method === 'eth_call') return params[0].data?.startsWith(TRUSTED_FORWARDER) ? `0x${'0'.repeat(63)}1` : '0x'
      throw new Error(`Unexpected RPC method ${method}`)
    }),
    call: vi.fn(async () => ({ data: '0x' })),
    estimateGas: vi.fn(async () => 100_000n),
    getCode: vi.fn(async () => '0x'),
    getBlock: vi.fn(async ({ blockTag }: { blockTag?: string } = {}) => blockTag === 'finalized'
      ? { number: 200n, hash: BLOCK_HASH, timestamp: BigInt(NOW) } : { hash: BLOCK_HASH }),
  }
}

/** A session that published `calls`, signed at nonce 4 until DEADLINE, and was never paid. */
function saveUnpaidSession(calls: AuthorityCall[]): string {
  const scope = relayrCallsScope(calls)
  saveRelayrPendingSession(scope, {
    bundleUuid: BUNDLE_UUID, paymentHash: null, paymentChainId: null, paymentStatus: 'unpaid',
    chainIds: calls.map(call => call.chainId), expectedCount: calls.length, records: [], itemCount: calls.length,
    account: ALICE, createdAt: (DEADLINE - 47 * 3_600) * 1_000, paymentOptions: [],
    publishedEntries: calls.map(call => ({
      chain: call.chainId,
      target: jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][call.chainId],
      data: encodeFunctionData({ abi: erc2771ForwarderAbi, functionName: 'execute', args: [{
        from: ALICE, to: call.target, value: call.value ?? 0n, gas: 500_000n, deadline: DEADLINE, data: call.data,
        signature: `0x${'11'.repeat(65)}`,
      }] }),
      value: (call.value ?? 0n).toString(),
    })),
    publishedNonces: calls.map(() => '4'),
  })
  return scope
}

/** The bundle's quoted transaction IDs, one per chain. */
const UUIDS = ['fedcba98-7654-3210-fedc-ba9876543210', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']

/**
 * The session saveUnpaidSession leaves, after its quote was paid: Relayr ran
 * the bundle and reports each call failed, naming no transaction.
 */
function savePaidSession(calls: AuthorityCall[]): string {
  const scope = saveUnpaidSession(calls)
  const saved = loadRelayrPendingSession(scope)!
  const entries = saved.publishedEntries!
  saveRelayrPendingSession(scope, { ...saved, paymentStatus: 'confirmed', paymentChainId: 1, paymentHash: `0x${'ab'.repeat(32)}`,
    expectedTransactions: entries.map((entry, index) => ({ txUuid: UUIDS[index], chain: entry.chain, entry })) })
  vi.mocked(fetch).mockImplementation(async (_input, init) => {
    if (init?.method === 'POST') throw new Error('Relayr quote unavailable')
    return new Response(JSON.stringify({ bundle_uuid: BUNDLE_UUID, payment_received: true, transactions: entries.map((entry, index) => ({
      tx_uuid: UUIDS[index], request: entry, status: { state: 'failed' } })) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return scope
}

beforeEach(() => {
  for (const scope of listRelayrPendingScopes()) clearRelayrPendingSession(scope)
  storage = new Map()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size },
  } })
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, run: (lock: object) => Promise<unknown>) => run({}) } })
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000)
  nonces = { 1: 4n, 8453: 4n }
  live.clear()
  mocks.clients.clear()
  for (const chainId of CHAINS) mocks.clients.set(chainId, chainClient(chainId))
  mocks.connectedWallet.mockResolvedValue({ wallet: mocks.wallet, account: ALICE })
  mocks.requireReview.mockResolvedValue(undefined)
  mocks.chooseFunding.mockRejectedValue(new Error('Funding chain selection cancelled. Nothing was sent.'))
  mocks.identity.mockResolvedValue({ kind: 'eoa' })
  mocks.permissions.mockResolvedValue(false)
  mocks.wallet.signTypedData.mockResolvedValue(`0x${'11'.repeat(65)}`)
  // Relayr reports the old bundle unpaid with every call pending, and cannot quote again.
  vi.mocked(fetch).mockImplementation(async (_input, init) => {
    if (init?.method === 'POST') throw new Error('Relayr quote unavailable')
    return new Response(JSON.stringify({ bundle_uuid: BUNDLE_UUID, payment_received: false, transactions: [
      { tx_uuid: 'fedcba98-7654-3210-fedc-ba9876543210', status: { state: 'Pending' } },
      { tx_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', status: { state: 'Pending' } },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
})

describe('the split editor\'s recheck', () => {
  const split = (beneficiary: Address) => ({ percent: 150_000_000, projectId: 0n, beneficiary, preferAddToBalance: false, lockedUntil: 0, hook: zeroAddress })
  let current: Record<number, ReturnType<typeof split>[]>

  function snapshot(chainId: JBChainId): SplitSnapshot {
    return { chainId, projectId: PROJECTS[chainId], groupId: RESERVED_TOKEN_SPLIT_GROUP_ID, rulesetId: chainId === 1 ? 111n : 999n,
      owner: ALICE, controller: v6Address('JBController', chainId), authority: ALICE,
      currentSplits: [split(OTHER)], fallbackSplits: [], relayable: true }
  }

  function review(): SplitReview {
    return { account: ALICE, title: 'reserved recipients', destinations: CHAINS.map(chainId => {
      const source = snapshot(chainId)
      return { ...source, splits: assembleReservedDestination(source, [{ ...newDraftSplit(), value: '25', recipient: HOOK }], NOW) }
    }) }
  }

  beforeEach(() => {
    current = { 1: [split(OTHER)], 8453: [split(OTHER)] }
    for (const chainId of CHAINS) live.set(chainId, {
      ownerOf: () => ALICE,
      controllerOf: () => v6Address('JBController', chainId),
      splitsOf: args => args[1] === 0n ? [] : current[chainId],
    })
    mocks.current.mockImplementation(async (_client, args) => ({ ruleset: { id: args.chainId === 1 ? 111 : 999 }, metadata: {} }))
  })

  const splitReads = () => CHAINS.flatMap(chainId => (mocks.clients.get(chainId) as ReturnType<typeof chainClient>)
    .readContract.mock.calls.filter(([request]) => request.functionName === 'splitsOf'))

  it('offers Discard with the changed line once every request expired unused and Base\'s recipients changed', async () => {
    const calls = reviewedSplitCalls(review())
    const scope = saveUnpaidSession(calls)
    current[8453] = [split(ALICE)]
    await expect(runAuthorityCalls({ signal: flow, calls })).rejects.toMatchObject({ name: 'RelayrDiscardError', scope, reason: 'changed',
      message: 'The project changed since this review.' })
    expect(loadRelayrPendingSession(scope)).toMatchObject({ paymentStatus: 'unpaid', discardable: 'changed' })
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
  })

  it('offers Discard before the recheck runs once a request ran outside Relayr and changed the recipients', async () => {
    const calls = reviewedSplitCalls(review())
    const scope = saveUnpaidSession(calls)
    nonces = { 1: 5n, 8453: 5n }
    current = { 1: [split(HOOK)], 8453: [split(HOOK)] }
    await expect(runAuthorityCalls({ signal: flow, calls })).rejects.toMatchObject({ name: 'RelayrDiscardError', scope, reason: 'ran' })
    expect(splitReads()).toEqual([])
    expect(loadRelayrPendingSession(scope)).toMatchObject({ discardable: 'ran' })
  })

  it('signs again at the saved nonces once every request expired unused and the recipients still match', async () => {
    const calls = reviewedSplitCalls(review())
    saveUnpaidSession(calls)
    await expect(runAuthorityCalls({ signal: flow, calls })).rejects.toThrow('Relayr quote unavailable')
    expect(mocks.wallet.signTypedData.mock.calls.map(([request]) => [Number(request.domain.chainId), request.message.nonce]))
      .toEqual([[1, 4n], [8453, 4n]])
  })

  it('signs a paid update whose calls failed again at the saved nonces once every request expired unused and the recipients still match', async () => {
    const calls = reviewedSplitCalls(review())
    savePaidSession(calls)
    // Its requests expired unused, whatever Relayr reports, so the recheck runs before new signatures (amended ruling R114).
    await expect(runAuthorityCalls({ signal: flow, calls })).rejects.toThrow('Relayr quote unavailable')
    expect(splitReads().length).toBeGreaterThan(0)
    expect(mocks.wallet.signTypedData.mock.calls.map(([request]) => [Number(request.domain.chainId), request.message.nonce]))
      .toEqual([[1, 4n], [8453, 4n]])
  })

  it('keeps a paid update pending, without rechecking the recipients, while its requests can still run', async () => {
    const calls = reviewedSplitCalls(review())
    const scope = savePaidSession(calls)
    for (const chainId of CHAINS) {
      (mocks.clients.get(chainId) as ReturnType<typeof chainClient>).getBlock.mockImplementation(async ({ blockTag }: { blockTag?: string } = {}) =>
        blockTag === 'finalized' ? { number: 200n, hash: BLOCK_HASH, timestamp: BigInt(DEADLINE - 600) } : { hash: BLOCK_HASH })
    }
    vi.mocked(Date.now).mockReturnValue((DEADLINE - 600) * 1_000)
    // Its requests can still run, so it says until when (ruling R114).
    await expect(runAuthorityCalls({ signal: flow, calls })).rejects.toThrow(/^This action's earlier signature can still run until .+\. Try again after that\.$/)
    expect(splitReads()).toEqual([])
    expect(loadRelayrPendingSession(scope)).toMatchObject({ paymentStatus: 'confirmed' })
    expect(loadRelayrPendingSession(scope)?.discardable).toBeUndefined()
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
  })
})

describe('the ruleset-queue editor\'s recheck', () => {
  const split = { percent: 100_000_000, projectId: 987n, beneficiary: OTHER, preferAddToBalance: true, lockedUntil: 2_000_000_000, hook: HOOK }
  let reserved: Record<number, (typeof split)[]>

  function source(chainId: JBChainId) {
    const ruleset = { id: 50, metadata: 0n, cycleNumber: 3, basedOnId: 40, start: 1_700_000_000, duration: 86400, weight: parseEther('100'),
      weightCutPercent: 10_000_000, approvalHook: zeroAddress }
    const metadata = { reservedPercent: 1000, cashOutTaxRate: 500, baseCurrency: 1, pausePay: false, pauseCreditTransfers: false,
      allowOwnerMinting: false, allowSetCustomToken: true, allowTerminalMigration: true, allowSetTerminals: true, allowSetController: true,
      allowAddAccountingContext: true, allowAddPriceFeed: true, ownerMustSendPayouts: false, holdFees: false, scopeCashOutsToLocalBalances: true,
      useDataHookForPay: true, useDataHookForCashOut: true, dataHook: HOOK, metadata: 128 }
    return { action: 'current', option: { action: 'current', source: ruleset, mustStartAtOrAfter: 0, requiresStartDate: false },
      entry: { ruleset, metadata }, rulesetId: 50n, terminal: v6Address('JBMultiTerminal', chainId),
      access: [{ ctx: { token: NATIVE_TOKEN, decimals: 18, currency: 1 }, symbol: 'ETH', payoutLimits: [{ amount: parseEther('2'), currency: 1 }],
        surplusAllowances: [{ amount: 3n, currency: 2 }] }],
      reservedSplits: [split], payoutSplits: [{ token: NATIVE_TOKEN, splits: [split] }] } as unknown as Parameters<typeof buildQueueDestinationConfig>[2]
  }

  function review(): Parameters<typeof reviewedQueueCalls>[0] {
    const rules = { duration: 86400, weight: '200', weightCutPct: '1', reservedPct: '10', cashOutTaxPct: '5', pausePay: false,
      pauseCreditTransfers: false, pause721Transfers: false, holdFees: false, ownerMustSendPayouts: false, allowOwnerMinting: false,
      allowSetTerminals: true, allowSetController: true, allowTerminalMigration: true, allowSetCustomToken: true,
      allowAddAccountingContext: true, allowAddPriceFeed: true,
      limits: [{ token: NATIVE_TOKEN, symbol: 'ETH', decimals: 18, currency: 1, mode: 'limited', amount: '2', surplusAllowances: [{ amount: 3n, currency: 2 }] }] }
    const destinations = CHAINS.map(chainId => {
      const src = source(chainId)
      const data = { current: src.entry, upcoming: null, latest: src.entry, latestApprovalStatus: 0,
        plan: { defaultAction: 'current' as const, options: [src.option], hasQueuedRuleset: false, hasMultipleQueuedRulesets: false }, sources: { current: src } }
      return { chainId, projectId: PROJECTS[chainId], controller: v6Address('JBController', chainId), authority: ALICE, source: src, data,
        configs: [buildQueueDestinationConfig(rules as never, 2_000_000_000, src)], starts: [2_000_000_000], changes: [] }
    })
    return { account: ALICE, configs: destinations[0].configs, destinations, clearsPayouts: false } as unknown as Parameters<typeof reviewedQueueCalls>[0]
  }

  beforeEach(() => {
    reserved = { 1: [split], 8453: [split] }
    for (const chainId of CHAINS) {
      const src = source(chainId)
      live.set(chainId, {
        ownerOf: () => ALICE,
        controllerOf: () => v6Address('JBController', chainId),
        terminalsOf: () => [src.terminal],
        latestQueuedRulesetOf: () => [src.entry.ruleset, src.entry.metadata, 0],
        payoutLimitsOf: () => src.access[0].payoutLimits,
        surplusAllowancesOf: () => src.access[0].surplusAllowances,
        splitsOf: args => args[2] === RESERVED_TOKEN_SPLIT_GROUP_ID ? reserved[chainId] : src.payoutSplits[0].splits,
      })
    }
    mocks.current.mockImplementation(async (_client, args) => source(args.chainId).entry)
    mocks.upcoming.mockImplementation(async (_client, args) => source(args.chainId).entry)
    mocks.contexts.mockImplementation(async (_client, args) => source(args.chainId).access.map(item => item.ctx))
  })

  it('offers Discard with the changed line once every request expired unused and Base\'s queue changed', async () => {
    const calls = reviewedQueueCalls(review(), 'current')
    const scope = saveUnpaidSession(calls)
    reserved[8453] = [{ ...split, beneficiary: ALICE }]
    await expect(runAuthorityCalls({ signal: flow, calls })).rejects.toMatchObject({ name: 'RelayrDiscardError', scope, reason: 'changed' })
    expect(loadRelayrPendingSession(scope)).toMatchObject({ discardable: 'changed' })
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
  })

  it('signs again at the saved nonces once every request expired unused and the queue still matches', async () => {
    const calls = reviewedQueueCalls(review(), 'current')
    saveUnpaidSession(calls)
    await expect(runAuthorityCalls({ signal: flow, calls })).rejects.toThrow('Relayr quote unavailable')
    expect(mocks.wallet.signTypedData.mock.calls.map(([request]) => [Number(request.domain.chainId), request.message.nonce]))
      .toEqual([[1, 4n], [8453, 4n]])
  })
})

describe('the metadata editor\'s recheck', () => {
  let uris: Record<number, string>

  function review(): MetadataReview {
    const value: MetadataReview = { account: ALICE, isRevnet: false, scope: '', rows: [], destinations: CHAINS.map(chainId => ({
      chainId, projectId: PROJECTS[chainId], indexedAuthority: null, owner: ALICE, authority: ALICE,
      controller: v6Address('JBController', chainId), uri: `ipfs://QmCurrent${chainId}`, nextUri: `ipfs://QmNext${chainId}`,
    })) }
    value.scope = relayrCallsScope(metadataReviewCalls(value))
    // The editor saves its review under each destination before any signature.
    for (const destination of value.destinations) {
      storage.set(`jb-metadata-review-v1:${destination.chainId}:${destination.projectId}`, JSON.stringify(value))
    }
    return value
  }

  beforeEach(() => {
    uris = { 1: 'ipfs://QmCurrent1', 8453: 'ipfs://QmCurrent8453' }
    for (const chainId of CHAINS) live.set(chainId, {
      ownerOf: () => ALICE,
      controllerOf: () => v6Address('JBController', chainId),
      uriOf: () => uris[chainId],
    })
  })

  it('offers Discard with the changed line once every request expired unused and Base\'s profile changed', async () => {
    const calls = metadataReviewCalls(review())
    const scope = saveUnpaidSession(calls)
    uris[8453] = 'ipfs://QmElsewhere'
    await expect(runAuthorityCalls({ signal: flow, calls })).rejects.toMatchObject({ name: 'RelayrDiscardError', scope, reason: 'changed' })
    expect(loadRelayrPendingSession(scope)).toMatchObject({ discardable: 'changed' })
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
  })

  it('holds, with the time, while its requests can still run and the profile changed', async () => {
    const calls = metadataReviewCalls(review())
    const scope = saveUnpaidSession(calls)
    for (const chainId of CHAINS) {
      (mocks.clients.get(chainId) as ReturnType<typeof chainClient>).getBlock.mockImplementation(async ({ blockTag }: { blockTag?: string } = {}) =>
        blockTag === 'finalized' ? { number: 200n, hash: BLOCK_HASH, timestamp: BigInt(DEADLINE - 600) } : { hash: BLOCK_HASH })
    }
    vi.mocked(Date.now).mockReturnValue((DEADLINE - 600) * 1_000)
    uris[8453] = 'ipfs://QmElsewhere'
    await expect(runAuthorityCalls({ signal: flow, calls })).rejects.toThrow(/^This action's earlier signature can still run until .+\. Try again after that\.$/)
    expect(loadRelayrPendingSession(scope)?.discardable).toBeUndefined()
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
  })
})
