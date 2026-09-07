import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { erc2771ForwarderAbi, JBCoreContracts, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import type { LaunchPlan } from '@/lib/launch'
import type { RelayrEntry, RelayrQuote, RelayrTransactionRecord } from '@/lib/relayr'

const m = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address,
  safe: false,
  fee: vi.fn(),
  build: vi.fn(),
  projectId: vi.fn(),
  forward: vi.fn(),
  quote: vi.fn(),
  pay: vi.fn(),
  paymentDetails: vi.fn(),
  poll: vi.fn(),
  client: vi.fn(),
  pending: vi.fn(),
}))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: m.account }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => m.safe }))
vi.mock('@/lib/wallet-core', () => ({ publicClient: m.client }))
vi.mock('@bananapus/nana-sdk-core/v6', () => ({ getProjectCreationFee: m.fee }))
vi.mock('@/lib/launch', () => ({ buildLaunchRequest: m.build, projectIdFromReceipt: m.projectId }))
vi.mock('@/lib/relayr', () => ({
  TRUSTED_FORWARDER_ABI: [{ type: 'function', name: 'isTrustedForwarder', stateMutability: 'view',
    inputs: [{ name: 'forwarder', type: 'address' }], outputs: [{ type: 'bool' }] }],
  buildForwardedTx: m.forward, relayrPostBundle: m.quote, relayrPay: m.pay,
  relayrPaymentDetails: m.paymentDetails, relayrPoll: m.poll,
  relayrDestinationHash: (record: RelayrTransactionRecord) => record.status?.data?.hash ?? null,
  readRelayrPendingSessionsForAuthorization: () => {
    const session = m.pending()
    return session ? [{ scope: 'another-action', session }] : []
  },
}))

import { canRelayrLaunch, runRelayrLaunch } from '@/lib/launch-relayr'
import { abandonLaunchSession, canAbandonRelayrLaunch, completeLaunchSession, loadLaunchSession, recordLaunchChainStatus, saveLaunchSession, type LaunchSession } from '@/lib/launch-session'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const HASH = `0x${'aa'.repeat(32)}` as Hex
const BLOCK = `0x${'bb'.repeat(32)}` as Hex
const ABI = parseAbi(['function deploy(address owner, bytes32 salt) payable'])
const NOW = 1_900_000_000
let storage: Map<string, string>
let quote: RelayrQuote
let entries: RelayrEntry[]
let records: RelayrTransactionRecord[]
let clients: Map<number, ReturnType<typeof makeClient>>
let failed: Set<number>

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

function session(): LaunchSession {
  return {
    salt: `0x${'cc'.repeat(32)}`, projectUri: 'ipfs://launch', store: {} as LaunchPlan['store'],
    plans: { 1: {} as LaunchPlan, 10: {} as LaunchPlan }, chains: [1, 10],
    statuses: { 1: { phase: 'pending' }, 10: { phase: 'pending' } }, createdAt: NOW * 1000,
    transport: 'relayr', account: ACCOUNT, paymentChainId: 8453,
  }
}
function run(paymentChainId = 8453, value = loadLaunchSession() ?? session()) {
  return runRelayrLaunch({ session: value, account: m.account, paymentChainId, onStatus: vi.fn(), onProgress: vi.fn() })
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
  clients = new Map([1, 10, 8453].map(chain => [chain, makeClient(chain)]))
  m.client.mockImplementation(chain => clients.get(chain))
  m.fee.mockResolvedValue(17n)
  m.paymentDetails.mockReturnValue({ deadline: BigInt(NOW + 600) })
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
      payment_info: [8453, 1].map(chain => ({ chain, amount: '200', target: TARGET, calldata: '0x1234' as Hex })),
      expectedTransactions: signed.map((entry, i) => ({ txUuid: `tx-${i}`, chain: entry.chain, entry })) }
    records = signed.map((entry, i) => ({ tx_uuid: `tx-${i}`, status: { state: 'Confirmed', data: { hash: hashFor(entry.chain) } } }))
    return quote
  })
  m.pay.mockImplementation(async (_payment, _account, _uuid, submitted, reverify, sending) => {
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

  it('does not silently select another funding chain; an unpaid quote can be used on a newly selected offered chain', async () => {
    await expect(run(42161)).rejects.toThrow('did not offer payment')
    expect(m.pay).not.toHaveBeenCalled()
    await run(1)
    expect(m.forward).toHaveBeenCalledTimes(2)
    expect(m.quote).toHaveBeenCalledTimes(1)
    expect(m.pay.mock.calls[0][0].chain).toBe(1)
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

  it('journals the no-hash funding window and never repays after an ambiguous wallet response', async () => {
    m.pay.mockImplementation(async (_p, _a, _u, _submitted, verify, sending) => {
      await verify(); sending(); throw new Error('wallet disconnected after broadcasting')
    })
    await expect(run()).rejects.toThrow('wallet disconnected')
    m.poll.mockImplementation(async () => { throw new Error('offline') })
    expect(loadLaunchSession()?.relayr?.phase).toBe('payment-signing')
    await expect(run()).rejects.toThrow('unresolved')
    expect(m.pay).toHaveBeenCalledTimes(1)
    await expect(run(1)).rejects.toThrow('saved payment chain')
  })

  it('allows retrying a positively rejected funding prompt', async () => {
    m.pay.mockImplementationOnce(async (_p, _a, _u, _submitted, verify, sending) => {
      await verify(); sending(); throw Object.assign(new Error('Rejected'), { code: 4001 })
    })
    await expect(run()).rejects.toThrow('Rejected')
    expect(loadLaunchSession()?.relayr?.phase).toBe('quoted')
    await run()
    expect(m.forward).toHaveBeenCalledTimes(2)
  })

  it('blocks Safe wallets, testnets, single-chain launches, and a different original account', async () => {
    m.safe = true
    await expect(run()).rejects.toThrow('ordinary wallet')
    m.safe = false
    expect(canRelayrLaunch({ ...session(), chains: [1] })).toBe(false)
    expect(canRelayrLaunch({ ...session(), chains: [11155111, 84532] })).toBe(false)
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
    await expect(run(8453, { ...session(), salt: HASH })).rejects.toThrow('Another launch is saved')
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
    await expect(run(42161)).rejects.toThrow('did not offer payment')
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(false)
    for (const client of clients.values()) client.getBlock.mockResolvedValue({ number: 123n, hash: BLOCK, timestamp: BigInt(NOW + 3601) })
    await expect(run(42161)).rejects.toThrow('expired unused')
    expect(canAbandonRelayrLaunch(loadLaunchSession()!)).toBe(true)
    expect(m.pay).not.toHaveBeenCalled()
  })

  it('retains unknown payment evidence but permits explicit abandonment after both canonical deadlines pass', async () => {
    m.pay.mockImplementation(async (_p, _a, _u, _submitted, verify, sending) => {
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
    m.pay.mockImplementation(async (_p, _a, _u, _submitted, verify, sending) => {
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
    m.pay.mockImplementationOnce(async (_p, _a, _u, submitted, verify, sending) => {
      await verify(); sending(); submitted(HASH); throw new Error('reload after funding submission')
    })
    await expect(runRelayrLaunch({ session: loadLaunchSession()!, account: ACCOUNT, paymentChainId: 8453,
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
