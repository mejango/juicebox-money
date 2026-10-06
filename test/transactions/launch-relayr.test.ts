import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { erc2771ForwarderAbi, JBCoreContracts, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { CREATE_BATCH_ABI, MULTICALL3, SAFE_FACTORY, predictSafeAddress, type SafeDeploymentPlan } from '@bananapus/nana-sdk-core/safe'
import { describeSafeInitializer, functionFromCall } from '@bananapus/nana-sdk-core/review/decode'
import type { LaunchPlan } from '@/lib/launch'
import type { RelayrEntry, RelayrPayment, RelayrQuote, RelayrTransactionRecord } from '@bananapus/nana-sdk-core/review/relayr'
import safeArtifacts from '../fixtures/safe-1.4.1.json'

const m = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address,
  chainId: 8453,
  safe: false,
  fee: vi.fn(),
  build: vi.fn(),
  projectId: vi.fn(),
  forward: vi.fn(),
  quote: vi.fn(),
  pay: vi.fn(),
  funding: vi.fn(),
  poll: vi.fn(),
  client: vi.fn(),
  pending: vi.fn(),
  multisigPreflight: vi.fn(),
  multisigReceipt: vi.fn(),
  multisigSimulation: vi.fn(),
}))
vi.mock('@/lib/launch-multisig', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/launch-multisig')>()),
  checkLaunchMultisigs: m.multisigPreflight,
  verifyCreatedLaunchMultisigs: m.multisigReceipt,
  verifyLaunchMultisigSimulation: m.multisigSimulation,
}))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: m.account, chainId: m.chainId }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {},
  SUPPORTED_CHAINS: [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614].map(id => ({ id, name: `Chain ${id}` })),
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requireFundingChainSelection: m.funding,
}))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => m.safe }))
vi.mock('@/lib/wallet-core', () => ({ publicClient: m.client }))
vi.mock('@bananapus/nana-sdk-core/v6', () => ({ getProjectCreationFee: m.fee }))
vi.mock('@/lib/launch', () => ({ buildLaunchRequest: m.build, projectIdFromReceipt: m.projectId }))
vi.mock('@/lib/relayr', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/relayr')>()),
  buildForwardedTx: m.forward, relayrPostBundle: m.quote, relayrPay: m.pay,
  relayrPoll: m.poll,
  readRelayrPendingSessionsForAuthorization: () => {
    const session = m.pending()
    return session ? [{ scope: 'another-action', session }] : []
  },
}))

import { RELAYR_PAYMENT_ADDRESS, RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_SELECTOR, RelayrPaymentRevertedError } from '@bananapus/nana-sdk-core/review/relayr'
import { canRelayrLaunch, runRelayrLaunch } from '@/lib/launch-relayr'
import { relayrHeldMessage } from '@/lib/relayr'
import { abandonLaunchSession, canAbandonRelayrLaunch, completeLaunchSession, loadLaunchSession, recordLaunchChainStatus, saveLaunchSession, type LaunchSession } from '@/lib/launch-session'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const HASH = `0x${'aa'.repeat(32)}` as Hex
const BLOCK = `0x${'bb'.repeat(32)}` as Hex
const ABI = parseAbi(['function deploy(address owner, bytes32 salt) payable'])
const NOW = 1_900_000_000
const BUNDLE = '00000000-0000-0000-0000-000000000001'
const TESTNETS = [11155111, 11155420, 84532, 421614]
const MAY_HAVE_RUN = 'This launch\'s earlier signature may already have run. Check the project, then cancel this deployment to start over.'
const SAFE_INPUT: Omit<SafeDeploymentPlan, 'address'> = {
  owners: [ACCOUNT, TARGET], threshold: 2, saltNonce: `0x${'ef'.repeat(32)}`,
  proxyCreationCode: safeArtifacts.contracts.proxy.creationCode as Hex,
}
const SAFE_PLAN: SafeDeploymentPlan = { ...SAFE_INPUT, address: predictSafeAddress(SAFE_INPUT) }
let storage: Map<string, string>
let quote: RelayrQuote
let entries: RelayrEntry[]
let records: RelayrTransactionRecord[]
let clients: Map<number, ReturnType<typeof makeClient>>
let failed: Set<number>
let offeredPaymentChains: number[]

function paymentFor(chain: number, deadline = NOW + 600): RelayrPayment {
  return { chain, amount: '200', target: RELAYR_PAYMENT_ADDRESS, token: RELAYR_NATIVE_TOKEN,
    payment_deadline: deadline,
    calldata: `${RELAYR_PAYMENT_SELECTOR}${BUNDLE.replaceAll('-', '').padEnd(64, '0')}${deadline.toString(16).padStart(64, '0')}` as Hex }
}

function hashFor(chainId: number): Hex { return `0x${chainId.toString(16).padStart(64, '0')}` }
/** The payment relayrPay reports sent for `payment`, under `hash`. */
function sentFor(payment: RelayrPayment, hash: Hex) {
  return { chainId: payment.chain, target: payment.target, calldata: payment.calldata, amount: payment.amount,
    deadline: String(payment.payment_deadline), bundleUuid: BUNDLE, hash }
}
function makeClient(chainId: number) {
  return {
    getCode: vi.fn(async ({ address }: { address: Address }) => address === ACCOUNT ? '0x' : '0x6000'),
    readContract: vi.fn(async ({ functionName }: { functionName: string }): Promise<bigint | boolean> => functionName === 'nonces' ? 0n : true),
    estimateGas: vi.fn(async (_request: unknown) => 2_000_000n),
    call: vi.fn(async () => ({ data: '0x' })),
    getBlock: vi.fn(async () => ({ number: 123n, hash: BLOCK, timestamp: BigInt(NOW) })),
    getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
      const entry = entries.find(item => hashFor(item.chain) === hash)!
      return { hash, to: entry.target, input: entry.data, value: BigInt(entry.value), chainId: entry.chain, blockHash: BLOCK, blockNumber: 123n }
    }),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => ({
      transactionHash: hash, to: entries.find(item => hashFor(item.chain) === hash)?.target, blockHash: BLOCK, blockNumber: 123n,
      status: failed.has(chainId) ? 'reverted' : 'success', logs: [],
    })),
  }
}

function session(chains = [1, 10], paymentChainId = 8453): LaunchSession {
  return {
    salt: `0x${'cc'.repeat(32)}`, projectUri: 'ipfs://launch', store: {} as LaunchPlan['store'],
    plans: Object.fromEntries(chains.map(chain => [chain, {} as LaunchPlan])), chains,
    statuses: Object.fromEntries(chains.map(chain => [chain, { phase: 'pending' as const }])), createdAt: NOW * 1000,
    transport: 'relayr', account: ACCOUNT, paymentChainId,
  }
}
function run(value = loadLaunchSession() ?? session()) {
  return runRelayrLaunch({ session: value, account: m.account, onStatus: vi.fn(), onProgress: vi.fn() })
}
function multisigSession(flavor: LaunchPlan['flavor'] = 'project', chains = [1]): LaunchSession {
  const value = session(chains)
  value.plans = Object.fromEntries(chains.map(chain => [chain, {
    flavor, owner: flavor === 'project' ? SAFE_PLAN.address : ACCOUNT,
    operator: flavor === 'revnet' ? SAFE_PLAN.address : null,
    multisigs: [SAFE_PLAN],
  } as LaunchPlan]))
  saveLaunchSession(value)
  return value
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
  m.account = ACCOUNT
  m.chainId = 8453
  m.safe = false
  m.pending.mockReturnValue(null)
  storage = new Map()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } })
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, fn: (lock: object) => Promise<void>) => fn({}) } })
  failed = new Set()
  clients = new Map([1, 10, 8453, 42161, ...TESTNETS].map(chain => [chain, makeClient(chain)]))
  offeredPaymentChains = [8453, 1]
  m.client.mockImplementation(chain => clients.get(chain))
  m.fee.mockResolvedValue(17n)
  m.funding.mockResolvedValue(8453)
  m.build.mockImplementation(({ chainId, owner, salt, creationFee }) => ({ chainId, address: TARGET,
    abi: ABI, functionName: 'deploy', args: [owner, salt], value: creationFee }))
  m.projectId.mockImplementation((_receipt, chainId) => chainId + 100)
  m.forward.mockImplementation(async (call, account, nonce) => {
    expect(nonce).toBe(0n)
    return { chain: call.chainId, target: jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][call.chainId as JBChainId],
      value: call.value.toString(), data: encodeFunctionData({ abi: erc2771ForwarderAbi, functionName: 'execute',
        args: [{ from: account, to: call.target, value: call.value, gas: call.gas, deadline: NOW + 3600,
          data: call.data, signature: `0x${'dd'.repeat(65)}` }] }) }
  })
  entries = []
  records = []
  m.quote.mockImplementation(async (signed: RelayrEntry[]) => {
    // Signatures must be journalled before they leave this browser.
    expect(loadLaunchSession()?.relayr?.phase).toBe('quoting')
    expect(loadLaunchSession()?.relayr?.signed).toHaveLength(signed.length)
    entries = signed
    quote = { bundle_uuid: '00000000-0000-0000-0000-000000000001',
      payment_info: offeredPaymentChains.map(chain => paymentFor(chain)),
      transactions: signed.map((entry, i) => ({ tx_uuid: `tx-${i}`, request: entry })),
      expectedTransactions: signed.map((entry, i) => ({ txUuid: `tx-${i}`, chain: entry.chain, entry })) }
    records = signed.map((entry, i) => ({ tx_uuid: `tx-${i}`, status: { state: 'Confirmed', data: { hash: hashFor(entry.chain) } } }))
    return quote
  })
  m.pay.mockImplementation(async ({ payment, destinationChainIds, reverify, onSending, onSent }) => {
    expect(destinationChainIds).toEqual(entries.map(entry => entry.chain))
    await reverify()
    onSending()
    expect(loadLaunchSession()?.relayr?.phase).toBe('payment-signing')
    const payments = [sentFor(payment, HASH)]
    onSent(payments)
    return { hash: HASH, payments }
  })
  m.poll.mockImplementation(async (_uuid, _count, update) => { update(records); return records })
  saveLaunchSession(session())
})

describe('saved launch payments', () => {
  it('refuses a saved launch whose payment record is malformed before checking anything', async () => {
    m.pay.mockImplementationOnce(async ({ payment, reverify, onSending, onSent }) => {
      await reverify(); onSending(); onSent([sentFor(payment, HASH)]); throw new Error('reload after funding submission')
    })
    await expect(run()).rejects.toThrow('reload after funding submission')
    const saved = loadLaunchSession()!
    saved.relayr!.payments = [{ ...saved.relayr!.payments![0], calldata: '0x1234' }]
    saveLaunchSession(saved)
    await expect(run()).rejects.toThrow('The saved Relayr launch is invalid.')
    expect(m.poll).not.toHaveBeenCalled()
  })
})

describe('relayed launch execution and recovery', () => {
  it.each(['project', 'revnet'] as const)('wallet-action:create-an-owner-or-operator-safe-during-launch bundles a single-chain %s Safe with the exact signed launch and one payment', async flavor => {
    const value = multisigSession(flavor)
    expect(canRelayrLaunch(value)).toBe(true)
    await run(value)
    expect(m.forward).toHaveBeenCalledTimes(1)
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry).toMatchObject({ target: MULTICALL3, value: '17', chain: 1 })
    const batch = decodeFunctionData({ abi: CREATE_BATCH_ABI, data: entry.data })
    expect(batch.functionName).toBe('aggregate3Value')
    const [deployment, forwarded] = batch.args[0]
    expect(batch.args[0]).toHaveLength(2)
    expect(deployment).toMatchObject({ target: SAFE_FACTORY, allowFailure: true, value: 0n })
    expect(forwarded).toMatchObject({ target: jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][1],
      allowFailure: false, value: 17n })
    const launch = decodeFunctionData({ abi: erc2771ForwarderAbi, data: forwarded.callData })
    expect(launch.functionName).toBe('execute')
    if (launch.functionName !== 'execute') throw new Error('Missing launch request')
    expect(launch.args[0]).toMatchObject({ from: ACCOUNT, to: TARGET, value: 17n, gas: 4_400_000n })
    expect(m.forward.mock.calls[0][3]).toMatchObject({
      calls: [{ to: SAFE_FACTORY, functionName: 'createProxyWithNonce' }],
    })
    // The review decodes the factory call's own bytes, down to the Safe's owners and threshold.
    const [creation] = m.forward.mock.calls[0][3].calls
    expect(functionFromCall(creation)?.name).toBe('createProxyWithNonce')
    expect(describeSafeInitializer(1, creation.args?.[1])?.[0].rows).toEqual(expect.arrayContaining([
      ['Owners', `${ACCOUNT}, ${TARGET}`],
      ['Threshold', '2 of 2'],
    ]))
    expect(m.forward.mock.calls[0][3].description).toContain(SAFE_PLAN.address)
    const client = clients.get(1)!
    expect(client.call).toHaveBeenCalledWith(expect.objectContaining({ to: MULTICALL3, data: entry.data,
      value: 17n, gas: 4_400_000n + 4_400_000n / 63n + 2_100_000n }))
    for (const [request] of client.readContract.mock.calls) {
      expect(request).not.toMatchObject({ address: MULTICALL3 })
    }
    expect(m.multisigPreflight).toHaveBeenCalledWith(client, expect.objectContaining({ multisigs: [SAFE_PLAN] }))
    expect(m.multisigSimulation).toHaveBeenCalledWith(client, expect.objectContaining({ multisigs: [SAFE_PLAN] }), '0x')
    expect(m.multisigReceipt).toHaveBeenCalledWith(client, expect.objectContaining({ multisigs: [SAFE_PLAN] }), 123n)
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ phase: 'done', projectId: 101 })
  })

  it('blocks signing when a requested Safe has a conflicting deployed policy', async () => {
    const value = multisigSession()
    m.multisigPreflight.mockRejectedValue(new Error('Safe policy mismatch'))
    await expect(run(value)).rejects.toThrow('Safe policy mismatch')
    expect(m.forward).not.toHaveBeenCalled()
    expect(m.quote).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('refuses to fund a batch whose simulated Safe deployment failed', async () => {
    const value = multisigSession()
    m.multisigSimulation.mockRejectedValue(new Error('Safe deployment failed'))
    await expect(run(value)).rejects.toThrow('Safe deployment failed')
    expect(m.forward).toHaveBeenCalledTimes(1)
    expect(m.quote).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('rechecks Safe prerequisites after choosing payment and before the wallet sends', async () => {
    const value = multisigSession()
    m.funding.mockImplementation(async () => {
      m.multisigPreflight.mockRejectedValue(new Error('Safe changed before payment'))
      return 8453
    })
    await expect(run(value)).rejects.toThrow('Safe changed before payment')
    expect(loadLaunchSession()?.relayr?.phase).toBe('quoted')
    expect(loadLaunchSession()?.relayr?.paymentHash).toBeUndefined()
  })

  it('keeps a successful launch unresolved when receipt-block Safe policy cannot be verified and resumes without paying twice', async () => {
    const value = multisigSession()
    m.multisigReceipt.mockRejectedValueOnce(new Error('Safe owners changed'))
    await expect(run(value)).rejects.toThrow('unfinished')
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ phase: 'uncertain', txHash: hashFor(1) })
    expect(loadLaunchSession()?.statuses[1].projectId).toBeUndefined()
    await run()
    expect(m.forward).toHaveBeenCalledTimes(1)
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(m.multisigReceipt).toHaveBeenLastCalledWith(clients.get(1), expect.objectContaining({ multisigs: [SAFE_PLAN] }), 123n)
    expect(loadLaunchSession()?.statuses[1]).toMatchObject({ phase: 'done', projectId: 101 })
  })

  it('retries a reverted Safe batch with its original inner forwarder nonce', async () => {
    const value = multisigSession()
    failed.add(1)
    await expect(run(value)).rejects.toThrow('unfinished')
    expect(loadLaunchSession()?.relayr?.retryNonces).toEqual({ 1: '0' })
    failed.clear()
    await run()
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.pay).toHaveBeenCalledTimes(2)
    expect(m.forward.mock.calls.map(call => call[2])).toEqual([0n, 0n])
    for (const [request] of clients.get(1)!.readContract.mock.calls) {
      expect(request).not.toMatchObject({ address: MULTICALL3 })
    }
    expect(loadLaunchSession()?.statuses[1].phase).toBe('done')
  })

  it('rejects a tampered saved factory call before reusing its launch signature', async () => {
    const value = multisigSession()
    m.funding.mockRejectedValueOnce(new Error('Funding selection cancelled'))
    await expect(run(value)).rejects.toThrow('Funding selection cancelled')
    const saved = loadLaunchSession()!
    const entry = saved.relayr!.signed[0].entry
    const batch = decodeFunctionData({ abi: CREATE_BATCH_ABI, data: entry.data })
    entry.data = encodeFunctionData({ abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value',
      args: [[{ ...batch.args[0][0], allowFailure: false }, batch.args[0][1]]] })
    saveLaunchSession(saved)
    await expect(run()).rejects.toThrow()
    expect(m.forward).toHaveBeenCalledTimes(1)
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('binds receipt evidence to the outer batch even when an inner launch receipt has a project ID', async () => {
    const value = multisigSession()
    const client = clients.get(1)!
    client.getTransaction.mockImplementation(async ({ hash }) => ({ hash,
      to: jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][1], input: entries[0].data,
      value: 17n, chainId: 1, blockHash: BLOCK, blockNumber: 123n }))
    await expect(run(value)).rejects.toThrow('unfinished')
    expect(loadLaunchSession()?.statuses[1].phase).toBe('uncertain')
    expect(m.multisigReceipt).not.toHaveBeenCalled()
    expect(m.projectId).not.toHaveBeenCalled()
  })

  it('waits for the quote before showing any funding choices or persisting a preferred chain', async () => {
    const makeQuote = m.quote.getMockImplementation()!
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    m.quote.mockImplementationOnce(async signed => { await waiting; return makeQuote(signed) })
    const pending = run()
    await vi.waitFor(() => expect(m.quote).toHaveBeenCalledTimes(1))
    expect(m.funding).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
    expect(loadLaunchSession()?.paymentChainId).toBeUndefined()
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBeUndefined()
    release()
    await pending
    expect(m.funding).toHaveBeenCalledTimes(1)
  })

  it('offers exactly the valid same-family quote choices, including a single explicit choice', async () => {
    saveLaunchSession(session(TESTNETS, 421614))
    const makeQuote = m.quote.getMockImplementation()!
    m.quote.mockImplementationOnce(async signed => ({ ...await makeQuote(signed), payment_info: [
      paymentFor(1), paymentFor(11155111), paymentFor(11155111),
      { ...paymentFor(84532), target: TARGET }, paymentFor(421614, NOW + 10),
    ] }))
    m.funding.mockResolvedValue(11155111)
    await run()
    expect(m.funding).toHaveBeenCalledExactlyOnceWith([{ chainId: 11155111, label: expect.stringContaining('Chain 11155111') }], 8453)
    expect(m.pay.mock.calls[0][0].payment.chain).toBe(11155111)
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBe(11155111)
  })

  it('preselects the chain the wallet was on when the launch started, not a chain signing switched to', async () => {
    const forward = m.forward.getMockImplementation()!
    m.forward.mockImplementation(async (...args: Parameters<typeof forward>) => {
      m.chainId = args[0].chainId
      return forward(...args)
    })
    await run()
    expect(m.chainId).toBe(10)
    expect(m.funding).toHaveBeenCalledExactlyOnceWith(expect.any(Array), 8453)
  })

  it('validates quote destination bindings before presenting its funding choices', async () => {
    const makeQuote = m.quote.getMockImplementation()!
    m.quote.mockImplementationOnce(async signed => ({ ...await makeQuote(signed), expectedTransactions: [] }))
    await expect(run()).rejects.toThrow('does not bind')
    expect(m.funding).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('rejects a chain absent from the displayed quote without sending payment', async () => {
    m.funding.mockResolvedValue(42161)
    await expect(run()).rejects.toThrow('selected funding chain is not available')
    expect(m.pay).not.toHaveBeenCalled()
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBeUndefined()
  })

  it('refreshes an expired unpaid quote using the exact signed entries and asks for the newly offered chain', async () => {
    m.funding.mockRejectedValueOnce(new Error('Funding selection cancelled'))
    await expect(run()).rejects.toThrow('cancelled')
    const originalEntries = structuredClone(entries)
    vi.mocked(Date.now).mockReturnValue((NOW + 700) * 1000)
    offeredPaymentChains = [10]
    const makeQuote = m.quote.getMockImplementation()!
    m.quote.mockImplementationOnce(async signed => ({ ...await makeQuote(signed), payment_info: [paymentFor(10, NOW + 1300)] }))
    m.funding.mockResolvedValue(10)
    await run()
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.quote).toHaveBeenCalledTimes(2)
    expect(m.quote.mock.calls[1][0]).toEqual(originalEntries)
    expect(m.funding.mock.calls[1][0]).toEqual([{ chainId: 10, label: expect.any(String) }])
    expect(m.pay.mock.calls[0][0].payment.chain).toBe(10)
  })

  it('refreshes unusable funding offers before asking for a choice', async () => {
    const makeQuote = m.quote.getMockImplementation()!
    m.quote.mockImplementationOnce(async signed => ({ ...await makeQuote(signed), payment_info: [paymentFor(11155111)] }))
    await run()
    expect(m.quote).toHaveBeenCalledTimes(2)
    expect(m.quote.mock.calls[1][0]).toEqual(m.quote.mock.calls[0][0])
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.funding).toHaveBeenCalledTimes(1)
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it('does not open the chooser when both quotes lack usable same-family funding offers', async () => {
    offeredPaymentChains = [11155111]
    await expect(run()).rejects.toThrow('no usable payment options')
    expect(m.quote).toHaveBeenCalledTimes(2)
    expect(m.funding).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
    expect(loadLaunchSession()?.relayr?.phase).toBe('quoted')
  })

  it('fails safely when a quote expires in the chooser and requests a new explicit choice on retry', async () => {
    m.funding.mockImplementationOnce(async () => { vi.mocked(Date.now).mockReturnValue((NOW + 700) * 1000); return 8453 })
    await expect(run()).rejects.toThrow('quote expired')
    expect(m.pay).not.toHaveBeenCalled()
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBeUndefined()
    const makeQuote = m.quote.getMockImplementation()!
    m.quote.mockImplementationOnce(async signed => ({ ...await makeQuote(signed), payment_info: [paymentFor(1, NOW + 1300)] }))
    m.funding.mockResolvedValue(1)
    await run()
    expect(m.quote).toHaveBeenCalledTimes(2)
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.funding).toHaveBeenCalledTimes(2)
    expect(m.pay.mock.calls[0][0].payment.chain).toBe(1)
  })

  it.each([undefined, 11155111])('rejects a started mainnet journal with invalid saved funding chain %s without reopening the picker', async paymentChainId => {
    m.pay.mockImplementationOnce(async ({ reverify, onSending }) => {
      await reverify(); onSending(); throw new Error('Wallet response lost')
    })
    await expect(run()).rejects.toThrow('Wallet response lost')
    const saved = loadLaunchSession()!
    saved.relayr!.paymentChainId = paymentChainId
    saveLaunchSession(saved)
    await expect(run()).rejects.toThrow('saved payment chain')
    expect(m.funding).toHaveBeenCalledTimes(1)
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it('preserves a corrupt launch record and refuses new authorizations', async () => {
    storage.set('jbm-launch-pending-v1', '{not json')
    await expect(run()).rejects.toThrow('Saved launch authorizations could not be read')
    expect(storage.get('jbm-launch-pending-v1')).toBe('{not json')
    expect(m.forward).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('refuses to sign or publish when the strict project-authorization ledger cannot be read', async () => {
    m.pending.mockImplementation(() => { throw new Error('Saved Relayr authorization records could not be read completely.') })
    await expect(run()).rejects.toThrow('records could not be read completely')
    expect(m.forward).not.toHaveBeenCalled()
    expect(m.quote).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('does not authorize a launch over another project action’s published forwarder nonce', async () => {
    m.pending.mockReturnValue({ account: ACCOUNT, chainIds: [1], publishedEntries: [{ chain: 1,
      target: jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][1], value: '0',
      data: encodeFunctionData({ abi: erc2771ForwarderAbi, functionName: 'execute', args: [{ from: ACCOUNT, to: TARGET,
        data: '0x1234', value: 0n, gas: 100_000n, deadline: NOW + 3600, signature: '0x1234' }] }) }] })
    await expect(run()).rejects.toThrow('Another published action')
    expect(m.forward).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('signs one exact call per chain, pays only on the selected chain, and verifies reversed provider records onchain', async () => {
    m.poll.mockImplementation(async (_uuid, _count, update) => { update([...records].reverse()); return [...records].reverse() })
    await run()
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.forward.mock.calls.every(([call]) => call.gas === 4_000_000n && call.value === 17n)).toBe(true)
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(m.pay.mock.calls[0][0].payment.chain).toBe(8453)
    expect(clients.get(1)!.estimateGas.mock.calls[0][0]).toMatchObject({ account: ACCOUNT,
      stateOverride: [{ address: ACCOUNT, balance: 100n * 10n ** 18n + 17n }] })
    expect(loadLaunchSession()?.statuses).toMatchObject({ 1: { phase: 'done', projectId: 101 }, 10: { phase: 'done', projectId: 110 } })
    expect(loadLaunchSession()?.relayr?.paymentHash).toBe(HASH)
  })

  it('launches all four Sepolia destinations with one payment and recovers without another authorization or charge', async () => {
    saveLaunchSession(session(TESTNETS, 84532))
    m.funding.mockResolvedValue(84532)
    offeredPaymentChains = [84532, 11155111]
    m.poll.mockImplementationOnce(async () => { records = []; throw new Error('offline') })
    await expect(run()).rejects.toThrow('unfinished')
    const saved = loadLaunchSession()!
    expect(saved.transport).toBe('relayr')
    expect(saved.relayr).toMatchObject({ paymentChainId: 84532, paymentHash: HASH })
    expect(saved.relayr?.signed.map(item => item.chainId)).toEqual(TESTNETS)
    records = entries.map((entry, i) => ({ tx_uuid: `tx-${i}`, status: { data: { hash: hashFor(entry.chain) } } })).reverse()
    await run(saved)
    expect(m.forward).toHaveBeenCalledTimes(4)
    expect(m.quote).toHaveBeenCalledTimes(1)
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(m.pay.mock.calls[0][0].payment.chain).toBe(84532)
    for (const chain of TESTNETS) {
      expect(loadLaunchSession()?.statuses[chain]).toMatchObject({ phase: 'done', projectId: chain + 100 })
      expect(entries.find(entry => entry.chain === chain)?.target).toBe(jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][chain as JBChainId])
    }
  })

  it('reuses an unpaid testnet quote only on an explicitly chosen offered testnet chain', async () => {
    saveLaunchSession(session(TESTNETS, 421614))
    offeredPaymentChains = [84532, 11155111]
    m.funding.mockRejectedValueOnce(new Error('Funding selection cancelled'))
    await expect(run()).rejects.toThrow('cancelled')
    expect(m.pay).not.toHaveBeenCalled()
    expect(loadLaunchSession()?.paymentChainId).toBeUndefined()
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBeUndefined()
    expect(m.funding.mock.calls[0][0].map((option: { chainId: number }) => option.chainId)).toEqual([84532, 11155111])
    m.funding.mockResolvedValue(11155111)
    await run()
    expect(m.forward).toHaveBeenCalledTimes(4)
    expect(m.quote).toHaveBeenCalledTimes(1)
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(m.pay.mock.calls[0][0].payment.chain).toBe(11155111)
  })

  it('does not reuse the old preselected funding chain; an unpaid quote requires a new explicit choice', async () => {
    m.funding.mockRejectedValueOnce(new Error('Funding selection cancelled'))
    await expect(run()).rejects.toThrow('cancelled')
    expect(m.pay).not.toHaveBeenCalled()
    m.funding.mockResolvedValue(1)
    await run()
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.quote).toHaveBeenCalledTimes(1)
    expect(m.pay.mock.calls[0][0].payment.chain).toBe(1)
    expect(m.funding).toHaveBeenCalledTimes(2)
  })

  it('recovers a submitted bundle without fresh signatures, quote, or payment', async () => {
    m.poll.mockImplementationOnce(async () => { records = []; throw new Error('offline') })
    await expect(run()).rejects.toThrow('unfinished')
    records = entries.map((entry, i) => ({ tx_uuid: `tx-${i}`, status: { data: { hash: hashFor(entry.chain) } } }))
    m.pending.mockImplementation(() => { throw new Error('An unrelated authorization ledger is unreadable') })
    await run()
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.quote).toHaveBeenCalledTimes(1)
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(m.funding).toHaveBeenCalledTimes(1)
  })

  it('never treats provider-only success or failure as a completed launch or permission to pay again', async () => {
    m.poll.mockImplementation(async (_uuid, _count, update) => {
      update([{ tx_uuid: 'tx-0', status: { state: 'Confirmed' } }, { tx_uuid: 'tx-1', status: { state: 'Failed' } }])
      throw new Error('provider claims failed')
    })
    await expect(run()).rejects.toThrow('unfinished')
    await expect(run()).rejects.toThrow('unresolved')
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(false)
  })

  it('rejects a provider hash pointing to another chain even if that receipt has a launch log', async () => {
    m.poll.mockImplementation(async (_uuid, _count, update) => {
      const swapped = records.map(record => ({ ...record, status: { data: { hash: hashFor(1) } } }))
      update(swapped); return swapped
    })
    await expect(run()).rejects.toThrow('unfinished')
    expect(loadLaunchSession()?.statuses[10].phase).toBe('uncertain')
    expect(m.projectId).toHaveBeenCalledTimes(1)
  })

  it('rejects a receipt whose block is no longer canonical', async () => {
    clients.get(10)!.getBlock.mockResolvedValue({ number: 123n, hash: HASH, timestamp: BigInt(NOW) })
    await expect(run()).rejects.toThrow('unfinished')
    expect(loadLaunchSession()?.statuses[10].phase).toBe('uncertain')
  })

  it('keeps successful chains and retries a proven revert using the original forwarder nonce', async () => {
    failed.add(10)
    await expect(run()).rejects.toThrow('unfinished')
    expect(loadLaunchSession()?.relayr?.retryNonces).toEqual({ 10: '0' })
    failed.clear()
    await run()
    expect(m.forward).toHaveBeenCalledTimes(3)
    expect(m.forward.mock.calls[2][0].chainId).toBe(10)
    expect(m.forward.mock.calls[2][2]).toBe(0n)
    expect(loadLaunchSession()?.statuses[1].projectId).toBe(101)
  })

  it('refuses a retry if the prior authorization nonce was consumed between attempts, and offers cancelling', async () => {
    failed.add(10)
    await expect(run()).rejects.toThrow('unfinished')
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(false)
    clients.get(10)!.readContract.mockImplementation(async ({ functionName }) => functionName === 'nonces' ? 1n : true)
    await expect(run()).rejects.toThrow(MAY_HAVE_RUN)
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(true)
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it.each([
    { chains: [1, 10], funding: 8453, alternative: 1 },
    { chains: TESTNETS, funding: 84532, alternative: 11155111 },
  ])('journals ambiguous funding on $funding and never changes chain or repays', async ({ chains, funding, alternative }) => {
    saveLaunchSession(session(chains, funding))
    offeredPaymentChains = [funding, alternative]
    m.funding.mockResolvedValue(funding)
    m.pay.mockImplementation(async ({ reverify, onSending }) => {
      await reverify(); onSending(); throw new Error('wallet disconnected after broadcasting')
    })
    await expect(run()).rejects.toThrow('wallet disconnected')
    m.poll.mockImplementation(async () => { throw new Error('offline') })
    expect(loadLaunchSession()?.relayr?.phase).toBe('payment-signing')
    await expect(run()).rejects.toThrow('unresolved')
    expect(m.pay).toHaveBeenCalledTimes(1)
    m.funding.mockResolvedValue(alternative)
    await expect(run()).rejects.toThrow('unresolved')
    expect(m.funding).toHaveBeenCalledTimes(1)
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBe(funding)
  })

  it('allows retrying a positively rejected funding prompt', async () => {
    m.pay.mockImplementationOnce(async ({ reverify, onSending }) => {
      await reverify(); onSending(); throw Object.assign(new Error('Rejected'), { code: 4001 })
    })
    await expect(run()).rejects.toThrow('Rejected')
    expect(loadLaunchSession()?.relayr?.phase).toBe('quoted')
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBeUndefined()
    expect(loadLaunchSession()?.paymentChainId).toBeUndefined()
    await run()
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.funding).toHaveBeenCalledTimes(2)
  })

  it('accepts supported network families and blocks Safe wallets, mixed chains, direct sessions, and changed accounts', async () => {
    m.safe = true
    await expect(run()).rejects.toThrow('ordinary wallet')
    m.safe = false
    expect(canRelayrLaunch({ ...session(), chains: [1] })).toBe(false)
    expect(canRelayrLaunch(session(TESTNETS, 84532))).toBe(true)
    for (const chains of [[1, 84532], [11155111, 8453], [1, 1], [11155111, 11155111], [1, 137]]) {
      expect(canRelayrLaunch({ ...session(), chains })).toBe(false)
    }
    expect(canRelayrLaunch({ ...session(TESTNETS, 84532), transport: 'direct' })).toBe(false)
    expect(canRelayrLaunch({ ...session(TESTNETS, 84532), transport: undefined })).toBe(false)
    m.account = TARGET
    await expect(run()).rejects.toThrow('originally signed')
    expect(m.forward).not.toHaveBeenCalled()
  })

  it('requires durable storage before any signatures are published', async () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => { throw new Error('storage denied') } } })
    await expect(run()).rejects.toThrow('Allow browser storage')
    expect(m.forward).not.toHaveBeenCalled()
    expect(m.quote).not.toHaveBeenCalled()
  })

  it('cannot overwrite another launch using the shared browser storage slot', async () => {
    expect(saveLaunchSession({ ...session(), salt: HASH })).toBe(false)
    await expect(run({ ...session(), salt: HASH })).rejects.toThrow('Another launch is saved')
    expect(loadLaunchSession()?.salt).toBe(session().salt)
    expect(completeLaunchSession(HASH)).toBe(false)
    expect(abandonLaunchSession(HASH)).toBe(false)
    expect(loadLaunchSession()?.salt).toBe(session().salt)
  })

  it('holds a shared cross-tab lock and refuses to execute without it', async () => {
    const request = vi.fn(async (_name, _options, fn) => fn(null))
    vi.stubGlobal('navigator', { locks: { request } })
    await expect(run()).rejects.toThrow('another tab')
    expect(request.mock.calls[0][0]).toBe('jbm-launch')
    expect(m.forward).not.toHaveBeenCalled()
  })

  it('simulates exact signed forwarder execution and refuses funding when launch prerequisites now revert', async () => {
    clients.get(10)!.call.mockRejectedValue(new Error('launch prerequisites changed'))
    await expect(run()).rejects.toThrow('launch prerequisites changed')
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.quote).not.toHaveBeenCalled()
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('refreshes changed creation fees with the same nonce before any funding', async () => {
    m.fee.mockResolvedValueOnce(17n).mockResolvedValueOnce(17n).mockResolvedValue(18n)
    await expect(run()).rejects.toThrow('creation fee changed')
    expect(m.pay).not.toHaveBeenCalled()
    expect(loadLaunchSession()?.relayr?.retryNonces).toEqual({ 1: '0', 10: '0' })
    await run()
    expect(m.forward.mock.calls.slice(2).every(([call, _account, nonce]) => call.value === 18n && nonce === 0n)).toBe(true)
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it('makes an unfunded published quote safely abandonable only after canonical unused signature expiry', async () => {
    m.funding.mockRejectedValueOnce(new Error('Funding selection cancelled'))
    await expect(run()).rejects.toThrow('cancelled')
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(false)
    for (const client of clients.values()) client.getBlock.mockResolvedValue({ number: 123n, hash: BLOCK, timestamp: BigInt(NOW + 3601) })
    await expect(run()).rejects.toThrow('expired unused')
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(true)
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('retains unknown payment evidence but permits explicit abandonment after both canonical deadlines pass', async () => {
    m.pay.mockImplementation(async ({ reverify, onSending }) => {
      await reverify(); onSending(); throw new Error('no hash returned')
    })
    await expect(run()).rejects.toThrow('no hash returned')
    m.poll.mockImplementation(async () => { throw new Error('provider unavailable') })
    for (const client of clients.values()) client.getBlock.mockResolvedValue({ number: 123n, hash: BLOCK, timestamp: BigInt(NOW + 3601) })
    await expect(run()).rejects.toThrow('earlier payment may have been charged')
    const saved = loadLaunchSession()!
    expect(saved.relayr?.phase).toBe('payment-signing')
    expect(saved.relayr?.quote?.bundle_uuid).toBe(quote.bundle_uuid)
    expect(canAbandonRelayrLaunch(saved)).toBe(true)
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it('keeps ambiguous funding blocked if its payment-chain deadline cannot be canonically proven', async () => {
    m.pay.mockImplementation(async ({ reverify, onSending }) => {
      await reverify(); onSending(); throw new Error('no hash returned')
    })
    await expect(run()).rejects.toThrow('no hash returned')
    m.poll.mockImplementation(async () => { throw new Error('provider unavailable') })
    for (const chainId of [1, 10]) clients.get(chainId)!.getBlock.mockResolvedValue({ number: 123n, hash: BLOCK, timestamp: BigInt(NOW + 3601) })
    await expect(run()).rejects.toThrow('may have sent')
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(false)
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it('ends a paid launch whose forwarder nonces moved, with no destination hash, with cancelling only, never a retry', async () => {
    m.poll.mockImplementation(async () => { records = []; throw new Error('provider unavailable') })
    await expect(run()).rejects.toThrow('unfinished')
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(false)
    for (const client of clients.values()) {
      client.getBlock.mockResolvedValue({ number: 123n, hash: BLOCK, timestamp: BigInt(NOW + 3601) })
      client.readContract.mockImplementation(async ({ functionName }) => functionName === 'nonces' ? 1n : true)
    }
    await expect(run()).rejects.toThrow(MAY_HAVE_RUN)
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(true)
    await expect(run()).rejects.toThrow(MAY_HAVE_RUN)
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(m.forward).toHaveBeenCalledTimes(2)
  })

  it('keeps a paid launch unresolved while one chain\'s request moved and another can still run', async () => {
    m.poll.mockImplementation(async () => { records = []; throw new Error('provider unavailable') })
    await expect(run()).rejects.toThrow('unfinished')
    clients.get(1)!.readContract.mockImplementation(async ({ functionName }) => functionName === 'nonces' ? 1n : true)
    await expect(run()).rejects.toThrow('unresolved')
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(false)
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it('offers only cancelling, after one line, once every published launch request is dead and one nonce moved', async () => {
    m.funding.mockRejectedValueOnce(new Error('Funding selection cancelled'))
    await expect(run()).rejects.toThrow('cancelled')
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(false)
    // Ethereum's nonce moved: another action used it, or anyone holding the request ran it.
    for (const client of clients.values()) client.getBlock.mockResolvedValue({ number: 123n, hash: BLOCK, timestamp: BigInt(NOW + 3601) })
    clients.get(1)!.readContract.mockImplementation(async ({ functionName }) => functionName === 'nonces' ? 1n : functionName !== 'verify')
    await expect(run()).rejects.toThrow(MAY_HAVE_RUN)
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(true)
    await expect(run()).rejects.toThrow(MAY_HAVE_RUN)
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.quote).toHaveBeenCalledTimes(1)
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('holds a published launch while another chain\'s request can still run, and says until when', async () => {
    m.funding.mockRejectedValueOnce(new Error('Funding selection cancelled'))
    await expect(run()).rejects.toThrow('cancelled')
    // Ethereum's nonce moved; Optimism's request can run until NOW + 3600.
    clients.get(1)!.readContract.mockImplementation(async ({ functionName }) => functionName === 'nonces' ? 1n : functionName !== 'verify')
    await expect(run()).rejects.toThrow(relayrHeldMessage(NOW + 3600))
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(false)
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.funding).toHaveBeenCalledTimes(1)
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('holds a published launch whose creation fee changed while its requests can still run, instead of signing again', async () => {
    m.funding.mockRejectedValueOnce(new Error('Funding selection cancelled'))
    await expect(run()).rejects.toThrow('cancelled')
    m.fee.mockResolvedValue(18n)
    await expect(run()).rejects.toThrow(relayrHeldMessage(NOW + 3600))
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(loadLaunchSession()?.relayr).toMatchObject({ phase: 'quoted', signed: [expect.anything(), expect.anything()] })
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('retains independently observed destination hashes when a later provider response omits them', async () => {
    clients.get(10)!.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt unavailable'))
    await expect(run()).rejects.toThrow('unfinished')
    expect(loadLaunchSession()?.statuses[10].txHash).toBe(hashFor(10))
    m.poll.mockImplementation(async (_uuid, _count, update) => { update([]); throw new Error('provider lost records') })
    await run()
    expect(loadLaunchSession()?.statuses[10].phase).toBe('done')
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it('clears a failed attempt hash through the UI merge adapter before a fresh bundle is restored', async () => {
    failed.add(10)
    await expect(run()).rejects.toThrow('unfinished')
    const uiStatuses = { ...loadLaunchSession()!.statuses }
    expect(uiStatuses[10].txHash).toBe(hashFor(10))
    failed.clear()
    m.pay.mockImplementationOnce(async ({ payment, reverify, onSending, onSent }) => {
      await reverify(); onSending(); onSent([sentFor(payment, HASH)]); throw new Error('reload after funding submission')
    })
    await expect(runRelayrLaunch({ session: loadLaunchSession()!, account: ACCOUNT,
      onProgress: vi.fn(), onStatus: (chainId, next) => {
        uiStatuses[chainId] = { ...uiStatuses[chainId], ...next }
        recordLaunchChainStatus(chainId, uiStatuses[chainId])
        if (next.phase === 'signing' || next.phase === 'pending') {
          expect(loadLaunchSession()?.statuses[chainId].txHash).toBeUndefined()
        }
      },
    })).rejects.toThrow('reload after funding submission')
    const newHash = `0x${'ee'.repeat(32)}` as Hex
    records = [{ tx_uuid: 'tx-0', status: { data: { hash: newHash } } }]
    clients.get(10)!.getTransaction.mockImplementation(async ({ hash }) => ({
      hash, to: entries[0].target, input: entries[0].data, value: BigInt(entries[0].value), chainId: 10, blockHash: BLOCK, blockNumber: 123n,
    }))
    clients.get(10)!.getTransactionReceipt.mockImplementation(async ({ hash }) => ({
      transactionHash: hash, to: entries[0].target, blockHash: BLOCK, blockNumber: 123n, status: 'success', logs: [],
    }))
    await run()
    expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'done', txHash: newHash })
    expect(m.forward).toHaveBeenCalledTimes(3)
    expect(m.pay).toHaveBeenCalledTimes(2)
  })
})

describe('paying a reverted launch quote again', () => {
  const SECOND_PAYMENT = `0x${'5c'.repeat(32)}` as Hex
  const reverting = async ({ payment, sent = [], reverify, onSending, onSent }: {
    payment: RelayrPayment; sent?: unknown[]; reverify: () => Promise<void>; onSending: () => void; onSent: (payments: unknown[]) => void
  }) => {
    await reverify(); onSending()
    onSent([...sent, sentFor(payment, HASH)])
    throw new RelayrPaymentRevertedError('The Relayr funding transaction reverted onchain.', HASH, payment.chain)
  }
  const paying = async ({ payment, sent = [], reverify, onSending, onSent }: {
    payment: RelayrPayment; sent?: unknown[]; reverify: () => Promise<void>; onSending: () => void; onSent: (payments: unknown[]) => void
  }) => {
    await reverify(); onSending()
    const payments = [...sent, sentFor(payment, SECOND_PAYMENT)]
    onSent(payments)
    return { hash: SECOND_PAYMENT, payments }
  }

  it('pays the same quote again on the same chain, with no new quote or funding choice', async () => {
    m.pay.mockImplementationOnce(reverting)
    await expect(run()).rejects.toThrow('The Relayr funding transaction reverted onchain.')
    expect(loadLaunchSession()?.relayr).toMatchObject({ phase: 'payment-reverted', paymentChainId: 8453,
      payments: [expect.objectContaining({ hash: HASH, chainId: 8453 })] })
    m.pay.mockImplementationOnce(paying)
    await run()
    expect(m.quote).toHaveBeenCalledTimes(1)
    expect(m.funding).toHaveBeenCalledTimes(1)
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.pay).toHaveBeenCalledTimes(2)
    expect(m.pay.mock.calls[1][0]).toMatchObject({ payment: { chain: 8453 }, sent: [expect.objectContaining({ hash: HASH })] })
    expect(loadLaunchSession()?.statuses).toMatchObject({ 1: { phase: 'done' }, 10: { phase: 'done' } })
  })

  it('proves a quote another payment funded after its own payment reverted, and never pays it again', async () => {
    m.pay.mockImplementationOnce(reverting)
    await expect(run()).rejects.toThrow(/reverted onchain/)
    // Another payment funded the bundle, and Relayr ran it.
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ bundle_uuid: BUNDLE,
      payment_received: true, transactions: records }), { status: 200 }))
    await run()
    expect(m.pay).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(`https://api.relayr.ba5ed.com/v1/bundle/${BUNDLE}`, expect.objectContaining({ cache: 'no-store' }))
    expect(loadLaunchSession()?.statuses).toMatchObject({ 1: { phase: 'done' }, 10: { phase: 'done' } })
  })

  it('retains a retry the wallet sent with no hash as it does a first payment, abandonable only after both canonical deadlines', async () => {
    m.pay.mockImplementationOnce(reverting)
    await expect(run()).rejects.toThrow(/reverted onchain/)
    m.pay.mockImplementation(async ({ reverify, onSending }) => {
      await reverify(); onSending(); throw new Error('no hash returned')
    })
    await expect(run()).rejects.toThrow('no hash returned')
    expect(loadLaunchSession()?.relayr?.phase).toBe('payment-signing')
    expect(loadLaunchSession()?.relayr?.paymentHash).toBeUndefined()
    m.poll.mockImplementation(async () => { throw new Error('provider unavailable') })
    for (const client of clients.values()) client.getBlock.mockResolvedValue({ number: 123n, hash: BLOCK, timestamp: BigInt(NOW + 3601) })
    await expect(run()).rejects.toThrow('earlier payment may have been charged')
    const saved = loadLaunchSession()!
    expect(saved.relayr).toMatchObject({ phase: 'payment-signing', payments: [expect.objectContaining({ hash: HASH })] })
    expect(canAbandonRelayrLaunch(saved)).toBe(true)
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.pay).toHaveBeenCalledTimes(2)
  })

  describe('once its quote expired (ruling R104)', () => {
    const WAITING = 'This Relayr quote expired after its payment reverted. A new quote needs its deadline final onchain and Relayr to report nothing ran; try again in a few minutes.'

    /** Relayr reports the bundle as `body` says, by default unpaid with every call pending. */
    function relayrReports(body: Record<string, unknown> = {}) {
      vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ bundle_uuid: BUNDLE, payment_received: false,
        transactions: entries.map((entry, index) => ({ tx_uuid: `tx-${index}`, request: entry, status: { state: 'Pending' } })),
        ...body }), { status: 200 }))
    }

    /** The launch's payment reverts, and its quote's deadline passes on the clock and at the finalized block. */
    async function expired(finalizedAt = NOW + 601) {
      m.pay.mockImplementationOnce(reverting)
      await expect(run()).rejects.toThrow(/reverted onchain/)
      const funding = clients.get(8453)!
      const option = paymentFor(8453)
      funding.getTransaction.mockImplementation(async ({ hash }) => ({ hash, chainId: 8453, from: ACCOUNT, to: RELAYR_PAYMENT_ADDRESS,
        input: option.calldata, value: 200n, blockHash: BLOCK, blockNumber: 123n } as never))
      funding.getTransactionReceipt.mockImplementation(async ({ hash }) => ({ transactionHash: hash, to: RELAYR_PAYMENT_ADDRESS,
        blockHash: BLOCK, blockNumber: 123n, status: 'reverted', logs: [] } as never))
      relayrReports()
      vi.mocked(Date.now).mockReturnValue((NOW + 601) * 1_000)
      for (const client of clients.values()) client.getBlock.mockResolvedValue({ number: 123n, hash: BLOCK, timestamp: BigInt(finalizedAt) })
    }

    it('quotes the same signed launch again once nothing can fund the reverted quote', async () => {
      await expired()
      const quoted = m.quote.getMockImplementation()!
      m.quote.mockImplementationOnce(async (signed: RelayrEntry[]) => ({ ...await quoted(signed),
        payment_info: offeredPaymentChains.map(chain => paymentFor(chain, NOW + 3600)) }))
      m.pay.mockImplementationOnce(paying)
      await run()
      expect(m.quote).toHaveBeenCalledTimes(2)
      expect(m.quote.mock.calls[1][0]).toEqual(m.quote.mock.calls[0][0])
      expect(m.forward).toHaveBeenCalledTimes(2)
      expect(m.funding).toHaveBeenCalledTimes(2)
      expect(m.pay.mock.calls[1][0]).toMatchObject({ sent: [] })
      expect(loadLaunchSession()?.statuses).toMatchObject({ 1: { phase: 'done' }, 10: { phase: 'done' } })
    })

    it('quotes again at once after a release, never offering the released quote by the device clock', async () => {
      // The first quote's Ethereum option is past its deadline at the finalized
      // block, but still open by the device clock after the release.
      const quoted = m.quote.getMockImplementation()!
      m.quote.mockImplementationOnce(async (signed: RelayrEntry[]) => ({ ...await quoted(signed),
        payment_info: [paymentFor(8453), paymentFor(1, NOW + 700)] }))
      await expired(NOW + 701)
      m.quote.mockImplementationOnce(async (signed: RelayrEntry[]) => ({ ...await quoted(signed),
        payment_info: offeredPaymentChains.map(chain => paymentFor(chain, NOW + 3600)) }))
      m.pay.mockImplementationOnce(paying)
      await run()
      expect(m.quote).toHaveBeenCalledTimes(2)
      expect(m.funding.mock.calls[1][0].map((option: { chainId: number }) => option.chainId)).toEqual([8453, 1])
      expect(m.pay.mock.calls[1][0]).toMatchObject({ sent: [] })
    })

    it('keeps the quote while Relayr does not report it unpaid', async () => {
      await expired()
      relayrReports({ payment_received: null })
      await expect(run()).rejects.toThrow(WAITING)
      expect(loadLaunchSession()?.relayr).toMatchObject({ phase: 'payment-reverted', payments: [expect.objectContaining({ hash: HASH })] })
      expect(m.quote).toHaveBeenCalledTimes(1)
      expect(m.pay).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps a declined retry on the retry rule, never back to a fresh choice', async () => {
    m.pay.mockImplementationOnce(reverting)
    await expect(run()).rejects.toThrow(/reverted onchain/)
    m.pay.mockImplementationOnce(async ({ reverify, onSending }) => {
      await reverify(); onSending(); throw Object.assign(new Error('Rejected'), { code: 4001 })
    })
    await expect(run()).rejects.toThrow('Rejected')
    expect(loadLaunchSession()?.relayr).toMatchObject({ phase: 'payment-reverted', paymentChainId: 8453,
      payments: [expect.objectContaining({ hash: HASH })] })
    expect(m.funding).toHaveBeenCalledTimes(1)
  })

  it('finds a payment that reverted while the app was away, and pays again only on the retry rule', async () => {
    m.pay.mockImplementationOnce(async ({ payment, reverify, onSending, onSent }) => {
      await reverify(); onSending(); onSent([sentFor(payment, HASH)]); throw new Error('reload after funding submission')
    })
    await expect(run()).rejects.toThrow('reload after funding submission')
    expect(loadLaunchSession()?.relayr?.phase).toBe('submitted')
    // The funding chain holds the reviewed payment, reverted.
    const funding = clients.get(8453)!
    const option = paymentFor(8453)
    funding.getTransaction.mockImplementation(async ({ hash }) => ({ hash, chainId: 8453, from: ACCOUNT, to: RELAYR_PAYMENT_ADDRESS,
      input: option.calldata, value: 200n, blockHash: BLOCK, blockNumber: 123n } as never))
    funding.getTransactionReceipt.mockImplementation(async ({ hash }) => ({ transactionHash: hash, to: RELAYR_PAYMENT_ADDRESS,
      blockHash: BLOCK, blockNumber: 123n, status: 'reverted', logs: [] } as never))
    await expect(run()).rejects.toMatchObject({ name: 'RelayrPaymentRevertedError' })
    expect(loadLaunchSession()?.relayr?.phase).toBe('payment-reverted')
    expect(m.poll).toHaveBeenCalledTimes(0)
    m.pay.mockImplementationOnce(paying)
    await run()
    expect(m.pay.mock.calls[1][0]).toMatchObject({ payment: { chain: 8453 }, sent: [expect.objectContaining({ hash: HASH })] })
    expect(m.quote).toHaveBeenCalledTimes(1)
  })
})
