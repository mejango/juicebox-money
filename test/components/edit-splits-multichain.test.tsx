import { jbControllerAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { RESERVED_TOKEN_SPLIT_GROUP_ID, v6Address } from '@bananapus/nana-sdk-core/v6'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { decodeFunctionData, zeroAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  wallet: { address: '0x1111111111111111111111111111111111111111' },
  clientFor: vi.fn(),
  runAuthorityCalls: vi.fn(),
  loadSession: vi.fn(),
  resume: vi.fn(),
  current: vi.fn(),
  identity: vi.fn(),
  permissions: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/lib/authority', () => ({
  clientFor: mocks.clientFor,
  runAuthorityCalls: mocks.runAuthorityCalls,
  safeOutcomeMessage: (_result: unknown, message: string) => message,
}))
vi.mock('@/lib/relayr', async original => ({
  ...await original<typeof import('@/lib/relayr')>(),
  loadRelayrPendingSession: mocks.loadSession,
  resumeRelayrSession: mocks.resume,
}))
vi.mock('@/lib/cross-chain-authority', () => ({
  readAuthorityIdentity: mocks.identity,
}))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...await original<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getCurrentRuleset: mocks.current,
  hasPermissions: mocks.permissions,
}))

import { newDraftSplit, type DraftSplit } from '@/components/create/SplitsEditor'
import {
  assembleReservedDestination,
  readSplitDestination,
  readSplitJournal,
  reviewedSplitCalls,
  saveSplitJournal,
  SplitRecovery,
  splitSnapshotFingerprint,
  splitToDraft,
  type SplitReview,
  type SplitSnapshot,
} from '@/components/project/EditSplitsFlow'
import type { RawSplit } from '@/lib/splits-types'
import { relayrCallsScope } from '@/lib/relayr'

const ACCOUNT = mocks.wallet.address as Address
const RECIPIENT = '0x2222222222222222222222222222222222222222' as Address
const PEER_RECIPIENT = '0x3333333333333333333333333333333333333333' as Address
const OTHER = '0x4444444444444444444444444444444444444444' as Address
const NOW = 1_800_000_000

function split(patch: Partial<RawSplit> = {}): RawSplit {
  return {
    percent: 100_000_000,
    projectId: 0n,
    beneficiary: RECIPIENT,
    preferAddToBalance: false,
    lockedUntil: 0,
    hook: zeroAddress,
    ...patch,
  }
}

function draft(value = '25', patch: Partial<DraftSplit> = {}): DraftSplit {
  return { ...newDraftSplit(), value, recipient: RECIPIENT, ...patch }
}

const storage = new Map<string, string>()
const live = new Map<JBChainId, SplitSnapshot>()
const reads = new Map<JBChainId, ReturnType<typeof vi.fn>>()
const renderers: ReactTestRenderer[] = []
let review: SplitReview

function snapshot(chainId: JBChainId): SplitSnapshot {
  const peer = chainId === 8453 || chainId === 84532
  return {
    chainId,
    projectId: peer ? 303 : 101,
    groupId: RESERVED_TOKEN_SPLIT_GROUP_ID,
    rulesetId: peer ? 999n : 111n,
    owner: ACCOUNT,
    controller: v6Address('JBController', chainId),
    authority: ACCOUNT,
    currentSplits: [
      split({
        percent: peer ? 350_000_000 : 100_000_000,
        beneficiary: peer ? PEER_RECIPIENT : OTHER,
        projectId: peer ? 717n : 0n,
        preferAddToBalance: peer,
        hook: peer ? OTHER : zeroAddress,
        lockedUntil: NOW + 100_000,
      }),
      split({ percent: 150_000_000, beneficiary: OTHER }),
    ],
    fallbackSplits: [],
    relayable: true,
  }
}

function journalKey(chainId: JBChainId, projectId: number) {
  return `jbm:edit-splits:${chainId}:${projectId}:${RESERVED_TOKEN_SPLIT_GROUP_ID}`
}

function normalize(value: unknown) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString()
      : typeof item === 'string' && item.startsWith('0x') ? item.toLowerCase()
        : item,
  )
}

beforeEach(() => {
  storage.clear()
  live.clear()
  reads.clear()
  mocks.wallet.address = ACCOUNT
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  vi.stubGlobal('navigator', {
    locks: {
      request: vi.fn(async (_name, _options, callback) => callback({})),
    },
  })
  mocks.identity.mockResolvedValue({ kind: 'eoa' })
  mocks.permissions.mockResolvedValue(false)
  mocks.loadSession.mockReturnValue({ paymentStatus: 'unpaid', records: [] })
  mocks.resume.mockResolvedValue({ records: [] })
  for (const chainId of [1, 8453, 11155111, 11155420, 84532, 421614] as const) {
    live.set(chainId, snapshot(chainId))
    reads.set(chainId, vi.fn(async request => {
      const destination = live.get(chainId)!
      expect(request.args[0]).toBe(BigInt(destination.projectId))
      if (request.functionName === 'ownerOf') return destination.owner
      if (request.functionName === 'controllerOf') return destination.controller
      if (request.functionName === 'splitsOf') {
        expect(request.args[2]).toBe(RESERVED_TOKEN_SPLIT_GROUP_ID)
        if (request.args[1] === 0n) return destination.fallbackSplits
        expect(request.args[1]).toBe(destination.rulesetId)
        return destination.currentSplits
      }
      throw new Error(`Unexpected read ${request.functionName}`)
    }))
  }
  mocks.clientFor.mockImplementation(chainId => ({
    chain: { id: chainId },
    readContract: reads.get(chainId),
  }))
  mocks.current.mockImplementation(async (_client, args) => ({
    ruleset: { id: Number(live.get(args.chainId)!.rulesetId) },
    metadata: {},
  }))
  review = {
    account: ACCOUNT,
    title: 'reserved recipients',
    destinations: ([1, 8453] as const).map(chainId => {
      const source = snapshot(chainId)
      return { ...source, splits: assembleReservedDestination(source, [draft()], NOW) }
    }),
  }
  mocks.runAuthorityCalls.mockImplementation(async ({ calls }) => {
    for (const call of calls) await call.reverifyAuthority?.()
    return { directResults: [], relayrGroups: 1, relayrResults: [], safeResults: [] }
  })
})

afterEach(async () => {
  for (const renderer of renderers.splice(0)) {
    await act(async () => renderer.unmount())
  }
})

describe('multichain reserved split replacement', () => {
  it('allows all four testnets in one frozen reserved-recipient review', async () => {
    const destinations = await Promise.all(([11155111, 11155420, 84532, 421614] as const).map(async chainId => {
      const expected = live.get(chainId)!
      const destination = await readSplitDestination({ chainId, projectId: expected.projectId, groupId: expected.groupId, account: ACCOUNT })
      expect(destination.relayable).toBe(true)
      return { ...destination, splits: assembleReservedDestination(destination, [draft()], NOW) }
    }))
    const calls = reviewedSplitCalls({ ...review, destinations })
    for (const [index, call] of calls.entries()) {
      await expect(call.reverifyAuthority!()).resolves.toBeUndefined()
      const decoded = decodeFunctionData({ abi: jbControllerAbi, data: call.data })
      expect(decoded.args?.[0]).toBe(BigInt(destinations[index].projectId))
      expect(decoded.args?.[1]).toBe(destinations[index].rulesetId)
    }
    expect(calls.map(call => call.chainId)).toEqual([11155111, 11155420, 84532, 421614])
  })

  it('rejects mixed mainnet/testnet split funding before reusing a reviewed call', async () => {
    const testnet = snapshot(84532)
    const mixed = { ...review, destinations: [review.destinations[0], { ...testnet, splits: assembleReservedDestination(testnet, [draft()], NOW) }] }
    await expect(reviewedSplitCalls(mixed)[0].reverifyAuthority!()).rejects.toThrow(/all mainnets or all testnets/)
  })

  it('resolves each linked project’s own current ruleset, controller, and split group', async () => {
    for (const chainId of [1, 8453] as const) {
      const expected = live.get(chainId)!
      const destination = await readSplitDestination({
        chainId, projectId: expected.projectId,
        groupId: RESERVED_TOKEN_SPLIT_GROUP_ID, account: ACCOUNT,
      })
      expect(destination).toMatchObject(expected)
      expect(mocks.current).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ chainId, projectId: BigInt(expected.projectId) }),
      )
      expect(reads.get(chainId)).toHaveBeenCalledWith(expect.objectContaining({
        functionName: 'splitsOf',
        args: [BigInt(expected.projectId), expected.rulesetId, RESERVED_TOKEN_SPLIT_GROUP_ID],
      }))
    }
  })

  it('preserves every peer’s locked rows verbatim and replaces only its unlocked rows', () => {
    const destinations = review.destinations
    expect(destinations.map(destination => destination.splits[0])).toEqual(
      destinations.map(destination => destination.currentSplits[0]),
    )
    for (const destination of destinations) {
      expect(destination.splits).toHaveLength(2)
      expect(destination.splits[1]).toEqual(split({ percent: 250_000_000 }))
      expect(destination.splits[0].lockedUntil).toBe(NOW + 100_000)
    }
    expect(destinations[1].splits[0]).toMatchObject({
      projectId: 717n, hook: OTHER, preferAddToBalance: true,
      beneficiary: PEER_RECIPIENT, percent: 350_000_000,
    })
  })

  it('checks allocation against destination locks and allows exactly 100%', () => {
    expect(assembleReservedDestination(snapshot(1), [draft('70')], NOW)).toHaveLength(2)
    expect(() => assembleReservedDestination(snapshot(8453), [draft('70')], NOW)).toThrow(/100%/)
    expect(assembleReservedDestination(snapshot(8453), [draft('65')], NOW)
      .reduce((total, row) => total + row.percent, 0)).toBe(1_000_000_000)
  })

  it('does not preserve an expired lock as an unreviewed extra recipient', () => {
    const source = snapshot(8453)
    source.currentSplits = [split({ lockedUntil: NOW })]
    expect(assembleReservedDestination(source, [draft()], NOW)).toEqual([
      split({ percent: 250_000_000 }),
    ])
  })

  it('preserves a recipient whose lock expires after the editor excluded it from the drafts', () => {
    const source = snapshot(8453)
    const lockedAtOpen = split({
      percent: 350_000_000,
      projectId: 717n,
      beneficiary: PEER_RECIPIENT,
      hook: OTHER,
      preferAddToBalance: true,
      lockedUntil: NOW + 30,
    })
    source.currentSplits = [lockedAtOpen]
    vi.mocked(Date.now).mockReturnValue((NOW + 60) * 1000)

    expect(assembleReservedDestination(source, [draft()], NOW)).toEqual([
      lockedAtOpen,
      split({ percent: 250_000_000 }),
    ])
  })

  it.each([
    { kind: 'project' as const, projectId: '444', beneficiary: RECIPIENT },
    { kind: 'hook' as const, hookKind: 'custom' as const, hookAddress: OTHER },
  ])('refuses an editable $kind recipient without a destination mapping', patch => {
    expect(() => assembleReservedDestination(snapshot(8453), [draft('25', patch)], NOW))
      .toThrow(/project or hook recipients/i)
  })

  it('requires separate editing before replacing a peer’s unlocked project or hook recipient', () => {
    for (const patch of [{ projectId: 717n }, { hook: OTHER }]) {
      const source = snapshot(8453)
      source.currentSplits = [split(patch)]
      expect(() => assembleReservedDestination(source, [draft()], NOW))
        .toThrow(/project or hook recipients/i)
    }
  })

  it('preserves a one-billionth recipient share through the editor draft', () => {
    const source = snapshot(8453)
    const smallest = split({ percent: 1 })
    const result = assembleReservedDestination(source, [splitToDraft(smallest)], NOW)
    expect(result[1]).toEqual(smallest)
  })

  it('refuses per-chain address overrides that the shared-address review cannot represent', () => {
    expect(() => assembleReservedDestination(snapshot(8453), [draft('25', {
      perChain: { 8453: PEER_RECIPIENT },
    })], NOW)).toThrow(/(override|same address|address)/i)
  })

  it('refuses to clear a destination whose default recipients would take over', () => {
    const source = snapshot(8453)
    source.currentSplits = []
    source.fallbackSplits = [split()]
    expect(() => assembleReservedDestination(source, [], NOW)).toThrow(/default splits/)
    source.fallbackSplits = []
    expect(assembleReservedDestination(source, [], NOW)).toEqual([])
  })

  it('encodes one frozen setSplitGroupsOf call per destination with its own project and ruleset IDs', () => {
    const calls = reviewedSplitCalls(review)
    expect(calls.map(call => call.chainId)).toEqual([1, 8453])
    calls.forEach((call, index) => {
      const destination = review.destinations[index]
      expect(call.target).toBe(destination.controller)
      expect(call.authority).toBe(destination.authority)
      const decoded = decodeFunctionData({ abi: jbControllerAbi, data: call.data })
      expect(decoded.functionName).toBe('setSplitGroupsOf')
      expect(decoded.args?.[0]).toBe(BigInt(destination.projectId))
      expect(decoded.args?.[1]).toBe(destination.rulesetId)
      expect(normalize(decoded.args?.[2])).toBe(normalize([{
        groupId: RESERVED_TOKEN_SPLIT_GROUP_ID, splits: destination.splits,
      }]))
    })
  })
})

describe('split replacement validation before signing and funding', () => {
  it('fingerprints both current and fallback recipients, even when the output is non-empty', () => {
    const original = snapshot(1)
    const changed = snapshot(1)
    changed.currentSplits = [split({ beneficiary: PEER_RECIPIENT })]
    expect(splitSnapshotFingerprint(changed)).not.toBe(splitSnapshotFingerprint(original))
    changed.currentSplits = original.currentSplits
    changed.fallbackSplits = [split()]
    expect(splitSnapshotFingerprint(changed)).not.toBe(splitSnapshotFingerprint(original))
  })

  it.each(['currentSplits', 'fallbackSplits'] as const)(
    'rejects changed %s after review and leaves the reviewed calldata frozen',
    async field => {
      const calls = reviewedSplitCalls(review)
      const data = calls[1].data
      await expect(calls[1].reverifyAuthority!()).resolves.toBeUndefined()
      live.get(8453)![field] = [split({ beneficiary: PEER_RECIPIENT })]
      await expect(calls[1].reverifyAuthority!()).rejects.toThrow(/changed/i)
      expect(calls[1].data).toBe(data)
    },
  )

  it('refuses to replay an old review against a newly current ruleset', async () => {
    const call = reviewedSplitCalls(review)[1]
    live.get(8453)!.rulesetId = 1001n
    await expect(call.reverifyAuthority!()).rejects.toThrow(/(current|ruleset|changed)/i)
  })

  it('rejects a controller migration after review', async () => {
    const call = reviewedSplitCalls(review)[1]
    live.get(8453)!.controller = OTHER
    await expect(call.reverifyAuthority!()).rejects.toThrow(/controller/i)
  })

  it('rejects lost SET_SPLIT_GROUPS authority after review', async () => {
    const call = reviewedSplitCalls(review)[1]
    live.get(8453)!.owner = OTHER
    await expect(call.reverifyAuthority!()).rejects.toThrow(/(authority|permission|wallet|edit|manage)/i)
    expect(mocks.permissions).toHaveBeenCalled()
  })

  it('rejects an owner change even when the same wallet retains delegated permission', async () => {
    const call = reviewedSplitCalls(review)[1]
    live.get(8453)!.owner = OTHER
    mocks.permissions.mockResolvedValue(true)
    await expect(call.reverifyAuthority!()).rejects.toThrow(/changed/i)
  })

  it('fails closed when the current ruleset cannot be verified', async () => {
    mocks.current.mockRejectedValueOnce(new Error('RPC unavailable'))
    await expect(reviewedSplitCalls(review)[1].reverifyAuthority!()).rejects.toThrow('RPC unavailable')
  })

  it('blocks a destination that is now a Safe in a multichain bundle while allowing its separate review', async () => {
    mocks.identity.mockResolvedValue({ kind: 'safe', owners: [ACCOUNT] })
    await expect(reviewedSplitCalls(review)[1].reverifyAuthority!()).rejects.toThrow(/Safe accounts.*separately/i)
    await expect(reviewedSplitCalls({ ...review, destinations: [review.destinations[1]] })[0]
      .reverifyAuthority!()).resolves.toBeUndefined()
  })
})

describe('split replacement recovery', () => {
  async function mountSaved() {
    const journal = { scope: relayrCallsScope(reviewedSplitCalls(review)), review }
    saveSplitJournal(journal)
    const restored = readSplitJournal(journalKey(8453, 303))!
    expect(restored).not.toBeNull()
    const completed = vi.fn()
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<SplitRecovery journal={restored} onComplete={completed} />)
    })
    renderers.push(renderer)
    return { journal, restored, renderer, completed }
  }

  it('reloads the exact unpaid review from either project and validates every original call', async () => {
    const { restored, renderer, completed } = await mountSaved()
    expect(storage.has(journalKey(1, 101))).toBe(true)
    expect(storage.has(journalKey(8453, 303))).toBe(true)
    expect(readSplitJournal(journalKey(1, 101))).toEqual(restored)
    expect(restored.review.destinations.map(destination => destination.rulesetId))
      .toEqual([111n, 999n])
    expect(restored.review.destinations[1].splits[0].projectId).toBe(717n)
    await act(async () => { await renderer.root.findByType('button').props.onClick() })
    expect(mocks.runAuthorityCalls).toHaveBeenCalledOnce()
    const calls = mocks.runAuthorityCalls.mock.calls[0][0].calls
    expect(calls.map((call: { data: string }) => call.data))
      .toEqual(reviewedSplitCalls(review).map(call => call.data))
    expect(mocks.current).toHaveBeenCalledTimes(2)
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(completed).toHaveBeenCalledOnce()
    expect(storage.size).toBe(0)
  })

  it('keeps recovery aliases when mutable destination splits invalidate an unpaid review', async () => {
    const { renderer, completed } = await mountSaved()
    live.get(8453)!.currentSplits = [split({ beneficiary: ACCOUNT })]
    await act(async () => { await renderer.root.findByType('button').props.onClick() })
    expect(completed).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(JSON.stringify(renderer.toJSON())).toMatch(/changed.*Base/i)
    expect(storage.size).toBe(2)
  })

  it('resumes a paid partial bundle without resubmitting already completed split replacements', async () => {
    mocks.loadSession.mockReturnValue({
      paymentStatus: 'confirmed',
      records: [{ chainId: 1, status: 'confirmed' }, { chainId: 8453, status: 'pending' }],
    })
    const { journal, renderer, completed } = await mountSaved()
    mocks.current.mockRejectedValue(new Error('Current ruleset already changed'))
    await act(async () => { await renderer.root.findByType('button').props.onClick() })
    expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({
      scope: journal.scope, account: ACCOUNT,
    }))
    expect(mocks.runAuthorityCalls).not.toHaveBeenCalled()
    expect(mocks.current).not.toHaveBeenCalled()
    expect(completed).toHaveBeenCalledOnce()
    expect(storage.size).toBe(0)
  })

  it('reconciles the saved testnet bundle even when its authority is no longer eligible for a new bundle', async () => {
    review = { ...review, destinations: ([11155111, 84532] as const).map(chainId => {
      const destination = snapshot(chainId)
      return { ...destination, splits: assembleReservedDestination(destination, [draft()], NOW) }
    }) }
    mocks.loadSession.mockReturnValue({ paymentStatus: 'confirmed', records: [{ chainId: 11155111, status: 'confirmed' }, { chainId: 84532, status: 'pending' }] })
    const journal = { scope: relayrCallsScope(reviewedSplitCalls(review)), review }
    saveSplitJournal(journal)
    const restored = readSplitJournal(journalKey(84532, 303))!
    mocks.identity.mockResolvedValue({ kind: 'safe', owners: [ACCOUNT] })
    mocks.current.mockRejectedValue(new Error('Live reads are unavailable'))
    const completed = vi.fn()
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<SplitRecovery journal={restored} onComplete={completed} />) })
    renderers.push(renderer)
    await act(async () => { await renderer.root.findByType('button').props.onClick() })
    expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ scope: journal.scope, account: ACCOUNT }))
    expect(mocks.runAuthorityCalls).not.toHaveBeenCalled()
    expect(mocks.current).not.toHaveBeenCalled()
    expect(completed).toHaveBeenCalledOnce()
  })

  it('requires the wallet that reviewed the saved update before any recovery call', async () => {
    const { renderer, completed } = await mountSaved()
    mocks.wallet.address = OTHER
    await act(async () => {
      renderer.update(<SplitRecovery journal={readSplitJournal(journalKey(1, 101))!} onComplete={completed} />)
    })
    await act(async () => { await renderer.root.findByType('button').props.onClick() })
    expect(mocks.runAuthorityCalls).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(completed).not.toHaveBeenCalled()
    expect(storage.size).toBe(2)
  })
})
