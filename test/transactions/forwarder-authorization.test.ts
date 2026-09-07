import { erc2771ForwarderAbi, JBCoreContracts, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { encodeFunctionData, type Address } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayrEntry, RelayrPendingSession } from '@/lib/relayr'

const mocks = vi.hoisted(() => ({ launch: vi.fn() }))
vi.mock('@/lib/launch-session', () => ({ loadLaunchSession: mocks.launch }))
import { withForwarderAuthorizationLock } from '@/lib/forwarder-authorization'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
let pending: { scope: string; session: RelayrPendingSession | null }[]
let names: string[]

function entry(chain: JBChainId = 1, from = ALICE): RelayrEntry {
  return { chain, target: jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][chain], value: '0',
    data: encodeFunctionData({ abi: erc2771ForwarderAbi, functionName: 'execute',
      args: [{ from, to: BOB, data: '0x1234', value: 0n, gas: 100_000n, deadline: 4_000_000_000, signature: '0x1234' }] }) }
}
function session(entries: RelayrEntry[] = [entry()]): RelayrPendingSession {
  return { account: ALICE, bundleUuid: 'publication-pending', paymentHash: null, paymentStatus: 'unpaid', paymentChainId: null,
    chainIds: entries.map(item => item.chain), expectedCount: entries.length, itemCount: entries.length, createdAt: 1,
    records: [], publishedEntries: entries }
}
const run = (owner: `relayr:${string}` | `launch:${string}` = 'relayr:new', chains = [1], account = ALICE) =>
  withForwarderAuthorizationLock({ account, chainIds: chains, owner, pendingSessions: () => pending,
    execute: async assertAvailable => { assertAvailable(); return 'signed' } })

beforeEach(() => {
  pending = []; names = []; mocks.launch.mockReturnValue(null)
  const held = new Set<string>()
  vi.stubGlobal('navigator', { locks: { request: async (name: string, _options: unknown, execute: (lock: object | null) => Promise<unknown>) => {
    names.push(name)
    if (held.has(name)) return execute(null)
    held.add(name)
    try { return await execute({}) } finally { held.delete(name) }
  } } })
})

describe('shared forwarder nonce ownership', () => {
  it('sorts signer-chain locks and excludes simultaneous actions with different project scopes', async () => {
    let release!: () => void
    const gated = new Promise<void>(resolve => { release = resolve })
    const first = withForwarderAuthorizationLock({ account: ALICE, chainIds: [10, 1, 10], owner: 'relayr:action-a',
      pendingSessions: () => pending, execute: async assertAvailable => { assertAvailable(); await gated } })
    expect(names).toEqual([`jb-forwarder-authorization:${ALICE}:1`, `jb-forwarder-authorization:${ALICE}:10`])
    await expect(run('relayr:action-b', [1])).rejects.toThrow('Another action is authorizing')
    await expect(run('relayr:other-wallet', [1], BOB)).resolves.toBe('signed')
    release(); await first
    await expect(run('relayr:action-b', [1])).resolves.toBe('signed')
  })

  it('keeps published unpaid and paid authorizations reserved after the lock is released', async () => {
    pending = [{ scope: 'earlier', session: session() }]
    await expect(run()).rejects.toThrow('Another published action')
    await expect(run('relayr:earlier')).resolves.toBe('signed')
    await expect(run('relayr:disjoint', [10])).resolves.toBe('signed')
    pending[0].session!.paymentStatus = 'confirmed'
    await expect(run()).rejects.toThrow('Another published action')
    pending = [] // The existing canonical receipt verifier clears this ledger.
    await expect(run()).resolves.toBe('signed')
  })

  it('decodes the actual signer and excludes raw payer and Safe outer calls', async () => {
    pending = [{ scope: 'other-signer', session: session([entry(1, BOB)]) },
      { scope: 'raw-payer', session: session([{ ...entry(), target: BOB, data: '0x1234' }]) },
      { scope: 'safe-queue:original', session: { ...session([]), chainIds: [1], expectedEntries: [{ ...entry(), target: BOB, data: '0x1234' }] } }]
    await expect(run()).resolves.toBe('signed')
    await expect(run('relayr:new', [1], BOB)).rejects.toThrow('Another published action')
  })

  it('reserves legacy authority records without treating Safe nonce journals as forwarder requests', async () => {
    pending = [{ scope: 'old-authority', session: { ...session(), publishedEntries: undefined } }]
    await expect(run()).rejects.toThrow('Another published action')
    pending[0].scope = 'safe-queue:legacy'
    await expect(run()).resolves.toBe('signed')
  })

  it('reserves published launch and superseded signatures until verified completion or expiry', async () => {
    const launch = { salt: 'launch-salt', statuses: { 1: { phase: 'pending' } },
      relayr: { published: true, signed: [], superseded: [{ chainId: 1, entry: entry() }] } }
    mocks.launch.mockReturnValue(launch)
    await expect(run()).rejects.toThrow('Another published action')
    await expect(run('launch:launch-salt')).resolves.toBe('signed')
    launch.statuses[1].phase = 'done'
    await expect(run()).resolves.toBe('signed')
    launch.statuses[1].phase = 'pending'
    mocks.launch.mockReturnValue({ ...launch, relayr: { ...launch.relayr, abandonable: true } })
    await expect(run()).resolves.toBe('signed')
  })

  it('lets receipt-only recovery resolve old conflicts without granting a new authorization', async () => {
    pending = [{ scope: 'other', session: session() }]
    await expect(withForwarderAuthorizationLock({ account: ALICE, chainIds: [1], owner: 'relayr:original', pendingSessions: () => pending,
      execute: async () => 'checked original receipt' })).resolves.toBe('checked original receipt')
    vi.stubGlobal('navigator', {})
    await expect(run()).rejects.toThrow('Web Locks support')
  })
})
