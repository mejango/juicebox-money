import { JBCoreContracts, NATIVE_TOKEN, USDC_ADDRESSES, jbContractAddress, jbControllerAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { RESERVED_TOKEN_SPLIT_GROUP_ID, v6Address } from '@bananapus/nana-sdk-core/v6'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { decodeFunctionData, parseEther, zeroAddress, type Address } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  wallet: { address: '0x1111111111111111111111111111111111111111' },
  clientFor: vi.fn(), runAuthorityCalls: vi.fn(), loadSession: vi.fn(), resume: vi.fn(),
  current: vi.fn(), upcoming: vi.fn(), contexts: vi.fn(), identity: vi.fn(),
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/lib/authority', () => ({ clientFor: mocks.clientFor, runAuthorityCalls: mocks.runAuthorityCalls, safeOutcomeMessage: (_result: unknown, message: string) => message }))
vi.mock('@/lib/relayr', async original => ({ ...await original<typeof import('@/lib/relayr')>(), loadRelayrPendingSession: mocks.loadSession, resumeRelayrSession: mocks.resume }))
vi.mock('@/lib/cross-chain-authority', () => ({ readAuthorityIdentity: mocks.identity }))
vi.mock('@/lib/token-symbol', () => ({ tokenSymbol: async () => 'ETH' }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({ ...await original<typeof import('@bananapus/nana-sdk-core/v6')>(), getCurrentRuleset: mocks.current, getUpcomingRuleset: mocks.upcoming, getAccountingContexts: mocks.contexts }))

import { buildQueueDestinationConfig, queueDestinationStages, queueStageStarts, queueSourceFingerprint, readQueueJournal, reviewedQueueCalls, rulesForQueueDestination, saveQueueJournal, QueueRecovery } from '@/components/project/QueueRulesetFlow'
import { relayrCallsScope } from '@/lib/relayr'

type Rules = Parameters<typeof rulesForQueueDestination>[0]
type Source = Parameters<typeof buildQueueDestinationConfig>[2]
type Review = Parameters<typeof reviewedQueueCalls>[0]
const ACCOUNT = mocks.wallet.address as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const OTHER = '0x3333333333333333333333333333333333333333' as Address

function rules(patch: Partial<Rules> = {}): Rules {
  return { duration: 86400, weight: '100', weightCutPct: '1', reservedPct: '10', cashOutTaxPct: '5', pausePay: false, pauseCreditTransfers: false, pause721Transfers: false, holdFees: false, ownerMustSendPayouts: false, allowOwnerMinting: false, allowSetTerminals: true, allowSetController: true, allowTerminalMigration: true, allowSetCustomToken: true, allowAddAccountingContext: true, allowAddPriceFeed: true,
    limits: [{ token: NATIVE_TOKEN, symbol: 'ETH', decimals: 18, currency: 1, mode: 'limited', amount: '2', surplusAllowances: [{ amount: 3n, currency: 2 }] }], ...patch }
}
function source(chainId: JBChainId): Source {
  const ruleset = { id: 50, metadata: 0n, cycleNumber: 3, basedOnId: 40, start: 1_700_000_000, duration: 86400, weight: parseEther('100'), weightCutPercent: 10_000_000, approvalHook: zeroAddress } as Source['entry']['ruleset']
  const metadata = { reservedPercent: 1000, cashOutTaxRate: 500, baseCurrency: 1, pausePay: false, pauseCreditTransfers: false, allowOwnerMinting: false, allowSetCustomToken: true, allowTerminalMigration: true, allowSetTerminals: true, allowSetController: true, allowAddAccountingContext: true, allowAddPriceFeed: true, ownerMustSendPayouts: false, holdFees: false, scopeCashOutsToLocalBalances: true, useDataHookForPay: true, useDataHookForCashOut: true, dataHook: HOOK, metadata: 128 }
  const split = { percent: 100_000_000, projectId: 987n, beneficiary: OTHER, preferAddToBalance: true, lockedUntil: 2_000_000_000, hook: HOOK }
  return { action: 'current', option: { action: 'current', source: ruleset, mustStartAtOrAfter: 0, requiresStartDate: false }, entry: { ruleset, metadata }, rulesetId: 50n, terminal: v6Address('JBMultiTerminal', chainId), access: [{ ctx: { token: NATIVE_TOKEN, decimals: 18, currency: 1 }, symbol: 'ETH', payoutLimits: [{ amount: parseEther('2'), currency: 1 }], surplusAllowances: [{ amount: 3n, currency: 2 }] }], reservedSplits: [split], payoutSplits: [{ token: NATIVE_TOKEN, splits: [split] }] }
}
function review(): Review {
  const destinations = ([1, 8453] as JBChainId[]).map((chainId, index) => {
    const src = source(chainId)
    const data = { current: src.entry, upcoming: null, latest: src.entry, latestApprovalStatus: 0, plan: { defaultAction: 'current' as const, options: [src.option], hasQueuedRuleset: false, hasMultipleQueuedRulesets: false }, sources: { current: src } }
    return { chainId, projectId: index ? 303 : 101, controller: v6Address('JBController', chainId), authority: ACCOUNT, source: src, data, configs: [buildQueueDestinationConfig(rules({ weight: '200' }), 2_000_000_000, src)], starts: [2_000_000_000], changes: [] }
  })
  return { account: ACCOUNT, configs: destinations[0].configs, destinations, clearsPayouts: false }
}
const storage = new Map<string, string>()
let currentReview: Review
const reads = new Map<number, ReturnType<typeof vi.fn>>()
beforeEach(() => {
  storage.clear(); reads.clear(); currentReview = review(); mocks.wallet.address = ACCOUNT
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } })
  mocks.identity.mockResolvedValue({ kind: 'eoa' })
  mocks.loadSession.mockReturnValue({ paymentStatus: 'unpaid' })
  mocks.resume.mockResolvedValue({ records: [] })
  for (const destination of currentReview.destinations) {
    const src = destination.source
    reads.set(destination.chainId, vi.fn(async request => {
      if (request.functionName === 'ownerOf') return ACCOUNT
      if (request.functionName === 'controllerOf') return destination.controller
      if (request.functionName === 'terminalsOf') return [src.terminal]
      if (request.functionName === 'latestQueuedRulesetOf') return [src.entry.ruleset, src.entry.metadata, 0]
      if (request.functionName === 'payoutLimitsOf') return src.access[0].payoutLimits
      if (request.functionName === 'surplusAllowancesOf') return src.access[0].surplusAllowances
      if (request.functionName === 'splitsOf') return request.args[2] === RESERVED_TOKEN_SPLIT_GROUP_ID ? src.reservedSplits : src.payoutSplits[0].splits
      throw new Error(`Unexpected read ${request.functionName}`)
    }))
  }
  mocks.clientFor.mockImplementation(chain => ({ readContract: reads.get(chain) }))
  mocks.current.mockImplementation(async (_client, args) => currentReview.destinations.find(item => item.chainId === args.chainId)!.source.entry)
  mocks.upcoming.mockImplementation(mocks.current)
  mocks.contexts.mockImplementation(async (_client, args) => currentReview.destinations.find(item => item.chainId === args.chainId)!.source.access.map(item => item.ctx))
  mocks.runAuthorityCalls.mockImplementation(async ({ calls }) => { for (const call of calls) await call.reverifyAuthority?.(); return { directResults: [], relayrGroups: 1, relayrResults: [], safeResults: [] } })
})

describe('multichain ruleset configuration', () => {
  it('changes only reviewed scalar fields, preserving other chain settings and all source hooks/locked splits/allowances', () => {
    const baseline = rules()
    const peer = rules({ duration: 172800, cashOutTaxPct: '25', holdFees: true })
    const updated = rules({ weight: '250', reservedPct: '0' })
    const mapped = rulesForQueueDestination(baseline, updated, peer, 1, 8453)
    expect(mapped).toMatchObject({ duration: 172800, weight: '250', reservedPct: '0', cashOutTaxPct: '25', holdFees: true })
    const src = source(8453)
    src.entry.ruleset.approvalHook = OTHER
    src.entry.metadata.baseCurrency = 2
    const config = buildQueueDestinationConfig(mapped, 123, src)
    expect(config.metadata).toMatchObject({ baseCurrency: 2, dataHook: HOOK, metadata: 128, useDataHookForPay: true, useDataHookForCashOut: true, scopeCashOutsToLocalBalances: true, reservedPercent: 0 })
    expect(config.approvalHook).toBe(OTHER)
    expect(config.splitGroups.map(group => group.splits)).toEqual([src.reservedSplits, src.payoutSplits[0].splits])
    expect(config.fundAccessLimitGroups[0]).toEqual({ terminal: src.terminal, token: NATIVE_TOKEN, payoutLimits: [{ amount: parseEther('2'), currency: 1 }], surplusAllowances: [{ amount: 3n, currency: 2 }] })
  })
  it('maps canonical USDC limit amounts to peer token/currency/decimals and keeps peer allowances', () => {
    const baseline = rules({ limits: [{ ...rules().limits[0], token: USDC_ADDRESSES[1], symbol: 'USDC', currency: Number(BigInt(USDC_ADDRESSES[1]) & 0xffffffffn), decimals: 6 }] })
    const stage = { ...baseline, limits: [{ ...baseline.limits[0], amount: '12.34' }] }
    const peer = rules({ limits: [{ ...baseline.limits[0], token: USDC_ADDRESSES[8453], surplusAllowances: [{ amount: 71n, currency: 2 }] }] })
    const mapped = rulesForQueueDestination(baseline, stage, peer, 1, 8453)
    const config = buildQueueDestinationConfig(mapped, 100, source(8453))
    expect(config.fundAccessLimitGroups[0]).toMatchObject({ token: USDC_ADDRESSES[8453], payoutLimits: [{ amount: 12_340_000n, currency: Number(BigInt(USDC_ADDRESSES[8453]) & 0xffffffffn) }], surplusAllowances: [{ amount: 71n, currency: 2 }] })
  })
  it('retains untouched custom-token and multi-currency peer limits, and refuses to map edited custom tokens', () => {
    const peer = rules({ limits: [{ ...rules().limits[0], token: OTHER, symbol: 'CUSTOM', unrepresentableLimits: [{ amount: 99n, currency: 2 }] }] })
    const baseline = rules(), stage = rules({ pausePay: true })
    const mapped = rulesForQueueDestination(baseline, stage, peer, 1, 8453)
    expect(buildQueueDestinationConfig(mapped, 100, source(8453)).fundAccessLimitGroups[0].payoutLimits).toEqual([{ amount: parseEther('2'), currency: 1 }, { amount: 99n, currency: 2 }])
    const customStage = { ...peer, limits: [{ ...peer.limits[0], amount: '3' }] }
    expect(() => rulesForQueueDestination(peer, customStage, peer, 1, 8453)).toThrow('mapping cannot be verified')
  })
  it('refuses to reinterpret an arbitrary payout currency when only its amount is edited', () => {
    const baseline = rules({ limits: [{ ...rules().limits[0], currency: 3 }] })
    const stage = { ...baseline, limits: [{ ...baseline.limits[0], amount: '4' }] }
    expect(() => rulesForQueueDestination(baseline, stage, rules(), 1, 8453)).toThrow('cross-chain unit cannot be verified')
  })
  it('keeps earlier peer terms until that stage changes them, including later returns to route baseline', () => {
    const baseline = rules({ reservedPct: '10' }), follower = rules({ reservedPct: '5', limits: [{ ...rules().limits[0], amount: '4' }] })
    const peer = rules({ reservedPct: '25', limits: [{ ...rules().limits[0], amount: '7' }] })
    const stages = queueDestinationStages(baseline, [baseline, follower, baseline], peer, 1, 8453, 'cycle')
    expect(stages.map(stage => stage.reservedPct)).toEqual(['25', '5', '10'])
    expect(stages.map(stage => stage.limits[0].amount)).toEqual(['7', '4', '2'])
  })
  it('applies a closing stage after preserving peer-only tokens and untouched earlier calendar/issuance', () => {
    const baseline = rules(), changed = rules({ reservedPct: '0' })
    const peer = rules({ duration: 172800, weight: '300', limits: [{ ...rules().limits[0], token: OTHER, symbol: 'CUSTOM' }] })
    const stages = queueDestinationStages(baseline, [changed], peer, 1, 8453, 'wait')
    expect(stages[0]).toMatchObject({ duration: 172800, weight: '300', limits: [{ token: OTHER, mode: 'limited' }] })
    expect(stages[1]).toMatchObject({ duration: 0, weight: '0', pausePay: true, limits: [{ token: OTHER, mode: 'none' }] })
  })
  it('rejects a peer with a non-final open-ended stage and respects different parent calendars', () => {
    const baseline = rules(), peer = rules({ duration: 0 })
    expect(() => queueDestinationStages(baseline, [baseline, rules({ weight: '50' })], peer, 1, 8453, 'cycle')).toThrow('non-final ruleset with no end')
    const primary = queueStageStarts({ parent: { start: 100, duration: 10 }, firstMust: 125, stages: [{ duration: 10 }], now: 110 })
    const destination = queueStageStarts({ parent: { start: 105, duration: 20 }, firstMust: 125, stages: [{ duration: 20 }], now: 110 })
    expect(primary.musts).toEqual(destination.musts)
    expect(primary.starts).toEqual([130])
    expect(destination.starts).toEqual([125])
  })
  it('encodes each reviewed controller and project ID with the frozen destination config', () => {
    const calls = reviewedQueueCalls(currentReview, 'current')
    expect(calls.map(call => call.target)).toEqual([jbContractAddress['6'][JBCoreContracts.JBController][1], jbContractAddress['6'][JBCoreContracts.JBController][8453]])
    calls.forEach((call, index) => {
      const decoded = decodeFunctionData({ abi: jbControllerAbi, data: call.data })
      expect(decoded.functionName).toBe('queueRulesetsOf')
      expect(decoded.args?.[0]).toBe(index ? 303n : 101n)
      const normalized = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : typeof item === 'string' && item.startsWith('0x') ? item.toLowerCase() : item)
      expect(normalized(decoded.args?.[1])).toEqual(normalized(currentReview.destinations[index].configs))
    })
  })
  it('fingerprints mutable recipients and metadata, and fails closed on missing accounting contexts/custom terminals', async () => {
    const src = source(1), changed = source(1)
    changed.entry.metadata.dataHook = OTHER
    expect(queueSourceFingerprint(src)).not.toBe(queueSourceFingerprint(changed))
    changed.entry.metadata.dataHook = src.entry.metadata.dataHook
    changed.reservedSplits = [{ ...changed.reservedSplits[0], beneficiary: ACCOUNT }]
    expect(queueSourceFingerprint(src)).not.toBe(queueSourceFingerprint(changed))
    const calls = reviewedQueueCalls(currentReview, 'current')
    mocks.contexts.mockRejectedValueOnce(new Error('RPC unavailable'))
    await expect(calls[0].reverifyAuthority!()).rejects.toThrow('RPC unavailable')
    const read = reads.get(1)!, original = read.getMockImplementation() as (request: unknown) => unknown
    read.mockImplementation(async request => request.functionName === 'terminalsOf' ? [OTHER] : original(request))
    await expect(calls[0].reverifyAuthority!()).rejects.toThrow('custom terminal')
  })
})

describe('queue recovery after cancellation or partial execution', () => {
  async function mountSaved() {
    const journal = { scope: relayrCallsScope(reviewedQueueCalls(currentReview, 'current')), review: currentReview, action: 'current' as const }
    saveQueueJournal(journal)
    const reloaded = readQueueJournal('jbm:queue-rulesets:8453:303')!
    const completed = vi.fn()
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<QueueRecovery journal={reloaded} onComplete={completed} />) })
    return { renderer, completed, journal }
  }
  it('reloads the exact unpaid review from either peer and resumes original calls after live validation', async () => {
    const { renderer, completed } = await mountSaved()
    expect(storage.has('jbm:queue-rulesets:1:101')).toBe(true)
    expect(storage.has('jbm:queue-rulesets:8453:303')).toBe(true)
    await act(async () => { await renderer.root.findByType('button').props.onClick() })
    expect(mocks.runAuthorityCalls).toHaveBeenCalledOnce()
    expect(mocks.runAuthorityCalls.mock.calls[0][0].calls.map((call: { data: string }) => call.data)).toEqual(reviewedQueueCalls(currentReview, 'current').map(call => call.data))
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(completed).toHaveBeenCalledOnce()
    expect(storage.size).toBe(0)
    await act(async () => renderer.unmount())
  })
  it('refuses funding an unpaid old review if mutable splits changed and keeps the saved recovery aliases', async () => {
    const { renderer, completed } = await mountSaved()
    currentReview.destinations[1].source.reservedSplits = [{ ...currentReview.destinations[1].source.reservedSplits[0], beneficiary: ACCOUNT }]
    await act(async () => { await renderer.root.findByType('button').props.onClick() })
    expect(completed).not.toHaveBeenCalled()
    expect(JSON.stringify(renderer.toJSON())).toContain('rules changed on Base')
    expect(storage.size).toBe(2)
    await act(async () => renderer.unmount())
  })
  it('resumes a paid partial bundle without resimulating or submitting completed destination queues', async () => {
    mocks.loadSession.mockReturnValue({ paymentStatus: 'confirmed' })
    const { renderer, completed, journal } = await mountSaved()
    mocks.current.mockRejectedValue(new Error('Already queued / inaccessible'))
    await act(async () => { await renderer.root.findByType('button').props.onClick() })
    expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ scope: journal.scope, account: ACCOUNT }))
    expect(mocks.runAuthorityCalls).not.toHaveBeenCalled()
    expect(mocks.current).not.toHaveBeenCalled()
    expect(completed).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())
  })
})
