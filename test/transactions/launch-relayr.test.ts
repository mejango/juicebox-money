import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { erc2771ForwarderAbi, JBCoreContracts, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import type { LaunchPlan } from '@/lib/launch'
import type { RelayrEntry, RelayrPayment, RelayrQuote, RelayrTransactionRecord } from '@/lib/relayr'

const m = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address,
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
}))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: m.account }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {},
  SUPPORTED_CHAINS: [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614].map(id => ({ id, name: `Chain ${id}` })),
}))
vi.mock('@/lib/transaction-review', () => ({ requireFundingChainSelection: m.funding }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => m.safe }))
vi.mock('@/lib/wallet-core', () => ({ publicClient: m.client }))
vi.mock('@bananapus/nana-sdk-core/v6', () => ({ getProjectCreationFee: m.fee }))
vi.mock('@/lib/launch', () => ({ buildLaunchRequest: m.build, projectIdFromReceipt: m.projectId }))
vi.mock('@/lib/relayr', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/relayr')>()),
  TRUSTED_FORWARDER_ABI: [{ type: 'function', name: 'isTrustedForwarder', stateMutability: 'view',
    inputs: [{ name: 'forwarder', type: 'address' }], outputs: [{ type: 'bool' }] }],
  buildForwardedTx: m.forward, relayrPostBundle: m.quote, relayrPay: m.pay,
  relayrPoll: m.poll,
  relayrDestinationHash: (record: RelayrTransactionRecord) => record.status?.data?.hash ?? null,
  readRelayrPendingSessionsForAuthorization: () => {
    const session = m.pending()
    return session ? [{ scope: 'another-action', session }] : []
  },
}))

import { RELAYR_PAYMENT_ADDRESS, RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_SELECTOR } from '@/lib/relayr'
import { canRelayrLaunch, runRelayrLaunch } from '@/lib/launch-relayr'
import { abandonLaunchSession, canAbandonRelayrLaunch, completeLaunchSession, loadLaunchSession, recordLaunchChainStatus, saveLaunchSession, type LaunchSession } from '@/lib/launch-session'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const HASH = `0x${'aa'.repeat(32)}` as Hex
const BLOCK = `0x${'bb'.repeat(32)}` as Hex
const ABI = parseAbi(['function deploy(address owner, bytes32 salt) payable'])
const NOW = 1_900_000_000
const BUNDLE = '00000000-0000-0000-0000-000000000001'
const TESTNETS = [11155111, 11155420, 84532, 421614]
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
function makeClient(chainId: number) {
  return {
    getCode: vi.fn(async ({ address }: { address: Address }) => address === ACCOUNT ? '0x' : '0x6000'),
    readContract: vi.fn(async ({ functionName }: { functionName: string }): Promise<bigint | boolean> => functionName === 'nonces' ? 0n : true),
    estimateGas: vi.fn(async (_request: unknown) => 2_000_000n),
    call: vi.fn(async () => ({ data: '0x' })),
    getBlock: vi.fn(async () => ({ number: 123n, hash: BLOCK, timestamp: BigInt(NOW) })),
    getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
      const entry = entries.find(item => hashFor(item.chain) === hash)!
      return { hash, to: entry.target, input: entry.data, value: BigInt(entry.value), chainId: entry.chain, blockHash: BLOCK }
    }),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => ({
      transactionHash: hash, blockHash: BLOCK, blockNumber: 123n, status: failed.has(chainId) ? 'reverted' : 'success', logs: [],
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

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
  m.account = ACCOUNT
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
      expectedTransactions: signed.map((entry, i) => ({ txUuid: `tx-${i}`, chain: entry.chain, entry })) }
    records = signed.map((entry, i) => ({ tx_uuid: `tx-${i}`, status: { state: 'Confirmed', data: { hash: hashFor(entry.chain) } } }))
    return quote
  })
  m.pay.mockImplementation(async (_payment, _account, _uuid, destinationChainIds, submitted, reverify, sending) => {
    expect(destinationChainIds).toEqual(entries.map(entry => entry.chain))
    await reverify()
    sending()
    expect(loadLaunchSession()?.relayr?.phase).toBe('payment-signing')
    submitted(HASH)
    return HASH
  })
  m.poll.mockImplementation(async (_uuid, _count, update) => { update(records); return records })
  saveLaunchSession(session())
})

describe('relayed launch execution and recovery', () => {
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
    expect(m.funding).toHaveBeenCalledExactlyOnceWith([{ chainId: 11155111, label: expect.stringContaining('Chain 11155111') }])
    expect(m.pay.mock.calls[0][0].chain).toBe(11155111)
    expect(loadLaunchSession()?.relayr?.paymentChainId).toBe(11155111)
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
    expect(m.pay.mock.calls[0][0].chain).toBe(10)
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
    expect(m.pay.mock.calls[0][0].chain).toBe(1)
  })

  it.each([undefined, 11155111])('rejects a started mainnet journal with invalid saved funding chain %s without reopening the picker', async paymentChainId => {
    m.pay.mockImplementationOnce(async (_p, _a, _u, _destinations, _submitted, verify, sending) => {
      await verify(); sending(); throw new Error('Wallet response lost')
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
    expect(m.pay.mock.calls[0][0].chain).toBe(8453)
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
    expect(m.pay.mock.calls[0][0].chain).toBe(84532)
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
    expect(m.pay.mock.calls[0][0].chain).toBe(11155111)
  })

  it('does not reuse the old preselected funding chain; an unpaid quote requires a new explicit choice', async () => {
    m.funding.mockRejectedValueOnce(new Error('Funding selection cancelled'))
    await expect(run()).rejects.toThrow('cancelled')
    expect(m.pay).not.toHaveBeenCalled()
    m.funding.mockResolvedValue(1)
    await run()
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.quote).toHaveBeenCalledTimes(1)
    expect(m.pay.mock.calls[0][0].chain).toBe(1)
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

  it('refuses a retry if the prior authorization nonce was consumed between attempts', async () => {
    failed.add(10)
    await expect(run()).rejects.toThrow('unfinished')
    clients.get(10)!.readContract.mockImplementation(async ({ functionName }) => functionName === 'nonces' ? 1n : true)
    await expect(run()).rejects.toThrow('earlier launch authorization')
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it.each([
    { chains: [1, 10], funding: 8453, alternative: 1 },
    { chains: TESTNETS, funding: 84532, alternative: 11155111 },
  ])('journals ambiguous funding on $funding and never changes chain or repays', async ({ chains, funding, alternative }) => {
    saveLaunchSession(session(chains, funding))
    offeredPaymentChains = [funding, alternative]
    m.funding.mockResolvedValue(funding)
    m.pay.mockImplementation(async (_p, _a, _u, _destinationChainIds, _submitted, verify, sending) => {
      await verify(); sending(); throw new Error('wallet disconnected after broadcasting')
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
    m.pay.mockImplementationOnce(async (_p, _a, _u, _destinationChainIds, _submitted, verify, sending) => {
      await verify(); sending(); throw Object.assign(new Error('Rejected'), { code: 4001 })
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
    m.pay.mockImplementation(async (_p, _a, _u, _destinationChainIds, _submitted, verify, sending) => {
      await verify(); sending(); throw new Error('no hash returned')
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
    m.pay.mockImplementation(async (_p, _a, _u, _destinationChainIds, _submitted, verify, sending) => {
      await verify(); sending(); throw new Error('no hash returned')
    })
    await expect(run()).rejects.toThrow('no hash returned')
    m.poll.mockImplementation(async () => { throw new Error('provider unavailable') })
    for (const chainId of [1, 10]) clients.get(chainId)!.getBlock.mockResolvedValue({ number: 123n, hash: BLOCK, timestamp: BigInt(NOW + 3601) })
    await expect(run()).rejects.toThrow('may have sent')
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(false)
    expect(m.pay).toHaveBeenCalledTimes(1)
  })

  it('does not infer non-execution from elapsed time when the forwarder nonce was consumed', async () => {
    m.poll.mockImplementation(async () => { records = []; throw new Error('provider unavailable') })
    await expect(run()).rejects.toThrow('unfinished')
    for (const client of clients.values()) {
      client.getBlock.mockResolvedValue({ number: 123n, hash: BLOCK, timestamp: BigInt(NOW + 3601) })
      client.readContract.mockImplementation(async ({ functionName }) => functionName === 'nonces' ? 1n : true)
    }
    await expect(run()).rejects.toThrow('unresolved')
    expect(m.pay).toHaveBeenCalledTimes(1)
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
    m.pay.mockImplementationOnce(async (_p, _a, _u, _destinationChainIds, submitted, verify, sending) => {
      await verify(); sending(); submitted(HASH); throw new Error('reload after funding submission')
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
      hash, to: entries[0].target, input: entries[0].data, value: BigInt(entries[0].value), chainId: 10, blockHash: BLOCK,
    }))
    await run()
    expect(loadLaunchSession()?.statuses[10]).toMatchObject({ phase: 'done', txHash: newHash })
    expect(m.forward).toHaveBeenCalledTimes(3)
    expect(m.pay).toHaveBeenCalledTimes(2)
  })
})
