// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: {},
  readContract: vi.fn(),
  write: vi.fn(),
}))

vi.mock('@/providers/Providers', () => ({ wagmiConfig: mocks.config, IS_DETERMINISTIC_BROWSER: false }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('next/image', () => ({ default: () => null }))
vi.mock('wagmi', () => ({
  useConfig: () => mocks.config,
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: mocks.write }),
}))
vi.mock('wagmi/actions', () => ({
  getAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  getPublicClient: () => ({ readContract: mocks.readContract }),
  waitForTransactionReceipt: vi.fn(),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    isConnected: true,
    address: '0x1111111111111111111111111111111111111111',
    openSignIn: vi.fn(),
  }),
}))
vi.mock('@/lib/safe-connector', () => ({
  useSafeConnection: () => false,
  isSafeConnection: () => false,
}))
vi.mock('@/components/ui/AddressLabel', () => ({
  AddressLabel: ({ address }: { address: string }) => <span>{address}</span>,
}))

import { CreateForm } from '@/components/create/CreateForm'
import { newDraftItem } from '@/components/create/store-draft'
import { newDraftStage } from '@/components/create/stage-draft'
import { newDraftSplit } from '@/components/create/SplitsEditor'
import { DRAFT_KEY, parseDraft, type CreateDraft } from '@/lib/draft'
import { FOREVER_SECONDS } from '@/lib/launch'

const chains = [11155111, 11155420, 421614, 84532]
let renderer: TestRenderer.ReactTestRenderer | undefined
let client: QueryClient | undefined

beforeEach(() => {
  vi.useFakeTimers()
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
    clear: () => storage.clear(),
  })
  localStorage.clear()
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  mocks.readContract.mockImplementation(async () => 10n ** 18n)
})

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount())
  renderer = undefined
  client?.clear()
  client = undefined
})

function textOf(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('')
}

function draft(flavor: CreateDraft['flavor'] = 'simple', staleSplit = false): CreateDraft {
  // Preserve the reported switch from a custom project to Simple project:
  // its unfinished market split remains saved while the Rules step disappears.
  const stage = {
    ...newDraftStage(true),
    durationValue: '86400',
    cutPct: '10',
    reservedSplits: staleSplit ? [{ ...newDraftSplit(), kind: 'hook' as const }] : [],
  }
  return parseDraft(JSON.stringify({
    v: 1, flavor, name: 'Multichain regression', owner: '', authorityMode: 'existing',
    accepts: ['eth'], issuanceBase: 'usd', bridge: 'ccip', linkChains: true,
    chains, stages: [stage], afterMode: 'terminal',
  }))
}

async function mountDraft(saved: CreateDraft, finishFeeds = true) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(saved))
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    renderer = TestRenderer.create(<QueryClientProvider client={client!}><CreateForm /></QueryClientProvider>)
  })
  const root = renderer!.root
  await act(async () => root.findByProps({ 'aria-label': 'Launch' }).props.onClick())
  const risks = root.findAllByProps({ role: 'checkbox' }).find(node => textOf(node).startsWith('I understand the risks'))!
  await act(async () => risks.props.onClick())
  if (finishFeeds) await act(async () => { await vi.advanceTimersByTimeAsync(450) })
  return root
}

function launchButton(root: ReactTestInstance) {
  return root.findAllByType('button').find(node => textOf(node) === 'Launch on 4 chains')!
}

function launchSection(root: ReactTestInstance) {
  return root.findAllByType('section').find(node => textOf(node).includes('Ready to launch?'))!
}

describe('multichain launch validation', () => {
  it('launches the reported Simple draft despite an unfinished hidden market split', async () => {
    const root = await mountDraft(draft('simple', true))
    expect(launchButton(root).props.disabled).toBe(false)
    expect(mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'pricePerUnitOf', args: [0n, 61166n, 1n, 18n],
    }))
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('ignores an unused custom approval on a single forever ruleset', async () => {
    const saved = draft('project')
    // Use the same FOREVER sentinel as the editor and encoder.
    saved.stages[0].durationValue = String(FOREVER_SECONDS)
    saved.approvalDeadline = 'custom'
    saved.approvalCustom = ''
    const root = await mountDraft(saved)
    expect(launchButton(root).props.disabled).toBe(false)
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('validates only effective custom approval values when every selected chain overrides', async () => {
    const saved = draft('project')
    saved.approvalDeadline = 'custom'
    saved.approvalCustom = 'unfinished'
    saved.approvalPerChain = Object.fromEntries(chains.map(chainId => [chainId, '0x2222222222222222222222222222222222222222']))
    const root = await mountDraft(saved)
    expect(launchButton(root).props.disabled).toBe(false)
  })

  it('keeps an active invalid custom approval blocked', async () => {
    const saved = draft('project')
    saved.approvalDeadline = 'custom'
    saved.approvalCustom = ''
    const root = await mountDraft(saved)
    expect(launchButton(root).props.disabled).toBe(true)
    expect(textOf(launchSection(root))).toContain("Verify each chain's approval contract.")
  })

  it('ignores a deselected-chain override while retaining selected-chain validation', async () => {
    const saved = draft('project')
    saved.stages[0].reservedSplits = [{ ...newDraftSplit(), value: '10',
      recipient: '0x1111111111111111111111111111111111111111', perChain: { 10: 'unfinished' } }]
    const root = await mountDraft(saved)
    expect(launchButton(root).props.disabled).toBe(false)
  })

  it('keeps a valid four-testnet draft launchable', async () => {
    const root = await mountDraft(draft())
    expect(launchButton(root).props.disabled).toBe(false)
  })

  it('explains an active invalid custom ruleset on the Launch step', async () => {
    const root = await mountDraft(draft('project', true))
    expect(launchButton(root).props.disabled).toBe(true)
    const requirements = launchSection(root).findByProps({ 'aria-label': 'Launch requirements' })
    expect(textOf(requirements)).toContain('Fund market is unavailable on Optimism Sepolia')
    expect(textOf(requirements)).toContain('Complete ruleset #1 settings')
    const edit = requirements.findAllByType('button').find(node => textOf(node) === 'Edit Rules')!
    await act(async () => edit.props.onClick())
    expect(root.findByProps({ 'aria-label': 'Rules' }).props['aria-current']).toBe('step')
  })

  it('still blocks a Simple project whose active shop item pays an unsupported market hook', async () => {
    const saved = draft()
    saved.items = [{
      ...newDraftItem(), name: 'Membership', price: '1',
      splits: [{ ...newDraftSplit(), kind: 'hook', value: '100' }],
    }]
    const root = await mountDraft(saved)
    expect(launchButton(root).props.disabled).toBe(true)
    const requirements = launchSection(root).findByProps({ 'aria-label': 'Launch requirements' })
    expect(textOf(requirements)).toContain('Fund market is unavailable on Optimism Sepolia')
    expect(textOf(requirements)).toContain('Remove it from payout or shop recipients')
  })


  it('keeps an incomplete owner multisig blocked and sends its edit action to Flavor', async () => {
    const saved = draft()
    saved.authorityMode = 'create'
    saved.authoritySigners = ['0x1111111111111111111111111111111111111111', '']
    saved.authorityThreshold = 2
    const root = await mountDraft(saved)
    expect(launchButton(root).props.disabled).toBe(true)
    const requirements = launchSection(root).findByProps({ 'aria-label': 'Launch requirements' })
    expect(textOf(requirements)).toContain('Complete the owner multisig with unique signers and a valid approval policy.')
    const edit = requirements.findAllByType('button').find(node => textOf(node) === 'Edit Flavor')!
    await act(async () => edit.props.onClick())
    expect(root.findByProps({ 'aria-label': 'Flavor' }).props['aria-current']).toBe('step')
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('rechecks unavailable price feeds from Launch before enabling the action', async () => {
    mocks.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'pricePerUnitOf') throw new Error('RPC unavailable')
      return 10n ** 18n
    })
    const root = await mountDraft(draft())
    expect(launchButton(root).props.disabled).toBe(true)
    const requirements = launchSection(root).findByProps({ 'aria-label': 'Launch requirements' })
    expect(textOf(requirements)).toContain("Couldn't verify price feeds right now")
    const retry = requirements.findAllByType('button').find(node => textOf(node) === 'Retry price feeds')!
    mocks.readContract.mockImplementation(async () => 10n ** 18n)
    await act(async () => retry.props.onClick())
    expect(launchButton(root).props.disabled).toBe(true)
    expect(textOf(launchSection(root))).toContain('Checking price feeds on every selected chain')
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    expect(launchButton(root).props.disabled).toBe(false)
    expect(launchSection(root).findAllByProps({ 'aria-label': 'Launch requirements' })).toHaveLength(0)
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('shows pending price-feed verification beside the disabled launch action', async () => {
    const root = await mountDraft(draft(), false)
    expect(launchButton(root).props.disabled).toBe(true)
    expect(textOf(launchSection(root))).toContain('Checking price feeds on every selected chain')
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    expect(launchButton(root).props.disabled).toBe(false)
  })
})


type RuleSettings = Pick<CreateDraft, 'stages' | 'issuanceBase' | 'afterMode' | 'approvalDeadline' | 'approvalCustom' | 'approvalPerChain'>
type SavedDraft = CreateDraft & { savedRules?: Partial<Record<'project' | 'revnet', RuleSettings>> }

function rulesOf(saved: RuleSettings): RuleSettings {
  const { stages, issuanceBase, afterMode, approvalDeadline, approvalCustom, approvalPerChain } = saved
  // Draft parsing regenerates editor IDs; they do not change the saved rules.
  return JSON.parse(JSON.stringify(
    { stages, issuanceBase, afterMode, approvalDeadline, approvalCustom, approvalPerChain },
    (key, value) => key === 'id' ? undefined : value,
  )) as RuleSettings
}

async function persistedDraft(): Promise<SavedDraft> {
  await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  return JSON.parse(localStorage.getItem(DRAFT_KEY)!) as SavedDraft
}

async function selectFlavor(root: ReactTestInstance, flavor: CreateDraft['flavor']) {
  await act(async () => root.findByProps({ 'aria-label': 'Project flavor' }).props.onChange({ target: { value: flavor } }))
}

function expectSimplePreset(saved: CreateDraft) {
  expect(saved.flavor).toBe('simple')
  expect(saved.issuanceBase).toBeNull()
  expect(saved.afterMode).toBe('wait')
  expect(saved.approvalDeadline).toBe('none')
  expect(saved.approvalCustom).toBe('')
  expect(saved.approvalPerChain).toEqual({})
  expect(saved.stages).toHaveLength(1)
  expect(saved.stages[0]).toMatchObject({
    durationValue: '0', issuanceRate: '10000', cutOn: false,
    reservedSplits: [], payoutSplits: [], payoutSplitsUsdc: [],
    payouts: 'flexible', cashOuts: false, ownerMinting: true,
    powers: {
      setTerminals: true, setController: true, terminalMigration: true,
      setCustomToken: true, addAccountingContext: true, addPriceFeed: true,
    },
  })
}

describe('Simple preset and saved editable flavor rules', () => {

  it('keeps an explicit empty saved-rules marker through reload and starts fresh Custom rules', async () => {
    const saved: SavedDraft = { ...draft(), savedRules: {} }
    let root = await mountDraft(saved)
    const simple = await persistedDraft()
    expectSimplePreset(simple)
    expect(simple.savedRules).toEqual({})
    await act(async () => renderer!.unmount())
    renderer = undefined
    client!.clear()
    root = await mountDraft(parseDraft(JSON.stringify(simple)))
    expect((await persistedDraft()).savedRules).toEqual({})
    await selectFlavor(root, 'project')
    const custom = await persistedDraft()
    expect(custom.flavor).toBe('project')
    expect(custom.approvalDeadline).toBe('1day')
    expect(custom.stages).toHaveLength(1)
    expect(custom.stages[0]).toMatchObject({
      payouts: 'none', ownerMinting: false,
      powers: {
        setTerminals: false, setController: false, terminalMigration: false,
        setCustomToken: false, addAccountingContext: false, addPriceFeed: false,
      },
    })
  })

  it('normalizes legacy Simple rules, restores Custom settings and preserves them through reload', async () => {
    const legacy = draft('simple', true)
    legacy.approvalDeadline = 'custom'
    legacy.approvalCustom = '0x2222222222222222222222222222222222222222'
    legacy.approvalPerChain = { 84532: '0x3333333333333333333333333333333333333333' }
    legacy.items = [{ ...newDraftItem(), name: 'Shared membership', price: '0.1' }]
    const customRules = rulesOf(legacy)
    let root = await mountDraft(legacy)
    const activeSimple = await persistedDraft()
    expectSimplePreset(activeSimple)
    expect(rulesOf(activeSimple.savedRules!.project!)).toEqual(customRules)
    expect(activeSimple).toMatchObject({ name: legacy.name, chains: legacy.chains, owner: legacy.owner, accepts: legacy.accepts, items: [expect.objectContaining({ name: 'Shared membership', price: '0.1' })] })

    await selectFlavor(root, 'project')
    expect(rulesOf(await persistedDraft())).toEqual(customRules)
    await selectFlavor(root, 'simple')
    const beforeReload = await persistedDraft()
    expectSimplePreset(beforeReload)
    expect(rulesOf(beforeReload.savedRules!.project!)).toEqual(customRules)
    await act(async () => renderer!.unmount())
    renderer = undefined
    client!.clear()
    root = await mountDraft(parseDraft(JSON.stringify(beforeReload)))
    expectSimplePreset(await persistedDraft())
    await selectFlavor(root, 'project')
    const restored = await persistedDraft()
    expect(rulesOf(restored)).toEqual(customRules)
    expect(restored).toMatchObject({ name: legacy.name, chains: legacy.chains, owner: legacy.owner, accepts: legacy.accepts, items: [expect.objectContaining({ name: 'Shared membership', price: '0.1' })] })
  })

  it('keeps edited Custom and Revnet rules independent when switching through Simple', async () => {
    const root = await mountDraft(draft('project'))
    await act(async () => root.findByProps({ 'aria-label': 'Rules' }).props.onClick())
    let editor = root.findAll(node => node.props.stage && typeof node.props.onChange === 'function')[0]
    await act(async () => editor.props.onChange({ ...editor.props.stage, issuanceRate: '23456', cutPct: '7' }))
    const custom = rulesOf(await persistedDraft())
    await selectFlavor(root, 'revnet')
    await act(async () => root.findByProps({ 'aria-label': 'Stages' }).props.onClick())
    editor = root.findAll(node => node.props.stage && typeof node.props.onChange === 'function')[0]
    await act(async () => editor.props.onChange({ ...editor.props.stage, issuanceRate: '98765', cashOutTax: 2500 }))
    const revnet = rulesOf(await persistedDraft())
    await selectFlavor(root, 'simple')
    const simple = await persistedDraft()
    expectSimplePreset(simple)
    expect(rulesOf(simple.savedRules!.project!)).toEqual(custom)
    expect(rulesOf(simple.savedRules!.revnet!)).toEqual(revnet)
    await selectFlavor(root, 'project')
    expect(rulesOf(await persistedDraft())).toEqual(custom)
    await selectFlavor(root, 'revnet')
    expect(rulesOf(await persistedDraft())).toEqual(revnet)
  })
})


describe('launch summary creation fees', () => {
  it('shows one total and keeps every native chain amount in a closed disclosure', async () => {
    mocks.readContract.mockResolvedValue(100_000_000_000_000n)
    const root = await mountDraft(draft())
    const summary = root.findByProps({ 'aria-label': 'Launch summary' })
    expect(summary.findAllByType('dt').map(textOf)).toEqual([
      'Project owner', 'Launching', 'Accounting', 'Rules', 'Creation fees',
      'Sepolia', 'Optimism Sepolia', 'Arbitrum Sepolia', 'Base Sepolia',
    ])
    const details = summary.findByType('details')
    expect(details.props.open).toBeUndefined()
    expect(textOf(details.findByType('summary'))).toContain('0.0004 ETH')
    expect(details.findAllByType('dd').map(textOf)).toEqual([
      '0.0001 SepETH', '0.0001 OPSepETH', '0.0001 ArbSepETH', '0.0001 BaseSepETH',
    ])
    expect(textOf(summary)).not.toContain('Creation fee on')
  })

  it('keeps unavailable fees unknown instead of displaying a zero total', async () => {
    mocks.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'creationFee') throw new Error('Fee unavailable')
      return 10n ** 18n
    })
    const root = await mountDraft(draft())
    const details = root.findByProps({ 'aria-label': 'Launch summary' }).findByType('details')
    expect(textOf(details.findByType('summary'))).toContain('…')
    expect(textOf(details.findByType('summary'))).not.toContain('0 ETH')
    expect(details.findAllByType('dd').map(textOf)).toEqual(['…', '…', '…', '…'])
  })
})
