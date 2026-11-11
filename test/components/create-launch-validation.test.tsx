// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { TxConfirmRow } from '@/components/ui/TxProgress'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: {},
  readContract: vi.fn(),
  write: vi.fn(),
}))

vi.mock('@/providers/Providers', () => ({ wagmiConfig: mocks.config, IS_DETERMINISTIC_BROWSER: false }))
vi.mock('next/dynamic', () => ({ default: (load: () => unknown) =>
  // Inspect the real create form's confirmation rows without starting a wallet action.
  String(load).includes('TxProgress')
    ? ({ rows, open }: { rows?: TxConfirmRow[]; open: boolean }) => open
      ? <section data-tx-confirm>{rows?.map((row, index) => <p key={index} data-row={String(row.label)}>{row.value}</p>)}</section>
      : null
    : () => null,
}))
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
  it('keeps Launching, Chains, Accounting and Rules as separate confirmation rows with their values', async () => {
    const root = await mountDraft(draft())
    await act(async () => launchButton(root).props.onClick())
    const modal = root.findByProps({ 'data-tx-confirm': true })
    expect(modal.findAll(node => typeof node.props['data-row'] === 'string').map(node => node.props['data-row']))
      .toEqual(['Project', 'Project owner', 'Can move funds', 'Can change rules', 'Launching', 'Chains', 'Accounting', 'Rules', 'Creation fees'])
    expect(textOf(modal.findByProps({ 'data-row': 'Launching' }))).toBe('Simple project')
    expect(textOf(modal.findByProps({ 'data-row': 'Chains' }))).toContain('Optimism Sepolia')
    expect(textOf(modal.findByProps({ 'data-row': 'Accounting' }))).toBe('ETH')
    expect(textOf(modal.findByProps({ 'data-row': 'Rules' }))).toContain('Issues 10,000 tokens per ETH')
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('allows short preset-notice schedules because the contract delays them', async () => {
    const saved = draft('project')
    saved.afterMode = 'wait'
    saved.approvalDeadline = '7days'
    saved.stages = [
      { ...newDraftStage(true), durationValue: '86400' },
      { ...newDraftStage(false), durationValue: '86400' },
    ]
    const root = await mountDraft(saved)
    expect(launchButton(root).props.disabled).toBe(false)
    expect(textOf(root)).not.toContain('notice would reject')
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('launches the reported Simple draft despite an unfinished hidden market split', async () => {
    const root = await mountDraft(draft('simple', true))
    expect(launchButton(root).props.disabled).toBe(false)
    expect(mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'pricePerUnitOf', args: [0n, 61166n, 1n, 18n],
    }))
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('ignores hidden project approval fields restored in an imported Revnet draft', async () => {
    const saved = parseDraft(JSON.stringify({ ...draft('revnet'), ticker: 'REV',
      approvalDeadline: 'custom', approvalCustom: 'unfinished',
      approvalPerChain: { 11155111: 'unfinished too' } }))
    expect(saved.approvalDeadline).toBe('custom')
    expect(saved.approvalCustom).toBe('unfinished')
    const root = await mountDraft(saved)
    expect(launchButton(root).props.disabled).toBe(false)
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
    saved.afterMode = 'cycle'
    saved.approvalDeadline = 'custom'
    saved.approvalCustom = 'unfinished'
    saved.approvalPerChain = Object.fromEntries(chains.map(chainId => [chainId, '0x2222222222222222222222222222222222222222']))
    const root = await mountDraft(saved)
    expect(launchButton(root).props.disabled).toBe(false)
  })

  it('refuses unknown custom approval policies for a staged batch while keeping singleton custom rules available', async () => {
    const saved = draft('project')
    saved.approvalDeadline = 'custom'
    saved.approvalCustom = '0x2222222222222222222222222222222222222222'
    const root = await mountDraft(saved)
    expect(launchButton(root).props.disabled).toBe(true)
    expect(textOf(launchSection(root))).toContain('Custom approval contracts need rulesets queued one at a time')
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

  it('refuses a chosen start under an hour away and names it, with the default start untouched', async () => {
    const past = draft('revnet')
    past.stages[0] = { ...past.stages[0], scheduleOn: true, schedule: '2020-01-01T00:00' }
    let root = await mountDraft(past)
    expect(textOf(launchSection(root))).toContain('Stage #1 needs a start at least an hour from now.')
    await act(async () => renderer!.unmount())
    renderer = undefined

    const future = draft('revnet')
    future.stages[0] = { ...future.stages[0], scheduleOn: true, schedule: new Date(Date.now() + 2 * 3_600_000).toISOString() }
    root = await mountDraft(future)
    expect(textOf(launchSection(root))).not.toContain('needs a start')
  })

  it('names the accounting token for payout amounts when issuance is priced in USD', async () => {
    const root = await mountDraft(draft('project'))
    await act(async () => root.findByProps({ 'aria-label': 'Rules' }).props.onClick())
    const editor = root.findAll(node => typeof node.props.fundsUnit === 'string')[0]
    expect(editor.props).toMatchObject({ unitLabel: 'USD', fundsUnit: 'ETH' })
  })

  it('states the money decisions of the draft it will encode, in the summary and the confirmation', async () => {
    const saved = draft('revnet')
    saved.owner = '0xdead000000000000000000000000000000000000'
    saved.ticker = 'REG'
    saved.stages[0] = {
      ...saved.stages[0],
      scheduleOn: true,
      schedule: '2030-01-01T12:00',
      reservedSplits: [{ ...newDraftSplit(), value: '20', recipient: '0x1111111111111111111111111111111111111111' }],
      autoIssuances: [{ id: 'a', count: '1000', address: '0x2222222222222222222222222222222222222222', chainId: null, perChain: {} }],
    }
    const root = await mountDraft(saved)
    const summary = root.findByProps({ 'aria-label': 'Launch summary' })
    await act(async () => launchButton(root).props.onClick())
    const modal = root.findByProps({ 'data-tx-confirm': true })
    for (const text of [textOf(summary), textOf(modal)]) {
      expect(text).toContain('Multichain regression')
      expect(text).toContain('No operator')
      expect(text).toContain('Token holders, by cashing out or taking loans')
      expect(text).toContain("Nobody. Stages are fixed at launch.")
      expect(text).toContain('Starts Jan 1, 2030')
      expect(text).toContain('20% to splits: 20% to 0x1111…1111')
      expect(text).toContain('Mints 1,000 tokens to 0x2222…2222 on')
    }
  })

  it('says nobody can withdraw or change a Simple project with no owner, and what an owner can do', async () => {
    const off = draft()
    off.owner = '0xdead000000000000000000000000000000000000'
    let root = await mountDraft(off)
    let text = textOf(root.findByProps({ 'aria-label': 'Launch summary' }))
    expect(text).toContain('No owner')
    expect(text).toContain("Nobody. Funds can't leave the project.")
    expect(text).toContain("Nobody. The rules can't change.")
    expect(text).toContain('Nobody can withdraw funds')
    expect(text).toContain('Cash outs off')
    expect(text).not.toContain('Owner can')
    expect(text).not.toContain('No retained authority')
    await act(async () => renderer!.unmount())
    renderer = undefined

    root = await mountDraft(draft())
    text = textOf(root.findByProps({ 'aria-label': 'Launch summary' }))
    expect(text).toContain('Owner can withdraw all funds')
    expect(text).toContain('Owner can create tokens without payment')
    expect(text).toContain('The project owner, taking effect at once')
  })

  it('leaves a past step undone while it still blocks the launch', async () => {
    const blank = draft()
    blank.name = ''
    const root = await mountDraft(blank)
    const nav = root.findByProps({ 'aria-label': 'Create steps' })
    const tile = (label: string) => nav.findByProps({ 'aria-label': label }).findAllByType('span')[0].props.className
    expect(tile('Look & Feel')).not.toContain('bg-ink')
    expect(tile('Flavor')).toContain('bg-ink')
  })

  it('offers a visible way to add a ruleset', async () => {
    const root = await mountDraft(draft('project'))
    await act(async () => root.findByProps({ 'aria-label': 'Rules' }).props.onClick())
    const add = root.findAllByType('button').find(node => textOf(node).includes('Add a ruleset'))!
    await act(async () => add.props.onClick())
    expect(root.findAll(node => node.props['aria-expanded'] !== undefined && textOf(node).startsWith('Ruleset #2')).length).toBeGreaterThan(0)
  })

  it('explains an active invalid custom ruleset on the Launch step', async () => {
    const root = await mountDraft(draft('project', true))
    expect(launchButton(root).props.disabled).toBe(true)
    const requirements = launchSection(root).findByProps({ 'aria-label': 'Launch requirements' })
    expect(textOf(requirements)).toContain('Market maker is unavailable on Optimism Sepolia')
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
    expect(textOf(requirements)).toContain('Market maker is unavailable on Optimism Sepolia')
    expect(textOf(requirements)).toContain('Remove it from shop recipients')
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
      'Project', 'Project owner', 'Can move funds', 'Can change rules', 'Launching', 'Accounting', 'Rules', 'Creation fees',
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


describe('split-sale token credit control', () => {
  it('hides the ineffective revnet setting and preserves the ordinary project option', async () => {
    const saved = draft('revnet')
    saved.ticker = 'REV'
    saved.storeConfig.issueTokensForSplits = true
    const root = await mountDraft(saved)
    const config = root.findAllByType('button').find(node => textOf(node).startsWith('Shop config'))!
    await act(async () => config.props.onClick())
    expect(textOf(root)).not.toContain('Full token credit on split sales')
    await selectFlavor(root, 'project')
    const option = root.findAllByProps({ role: 'checkbox' }).find(node => textOf(node).startsWith('Full token credit on split sales'))!
    expect(option).toBeDefined()
    expect(option.props['aria-checked']).toBe(true)
    await act(async () => option.props.onClick())
    expect((await persistedDraft()).storeConfig.issueTokensForSplits).toBe(false)
    await selectFlavor(root, 'revnet')
    expect(textOf(root)).not.toContain('Full token credit on split sales')
    await selectFlavor(root, 'project')
    const restored = root.findAllByProps({ role: 'checkbox' }).find(node => textOf(node).startsWith('Full token credit on split sales'))!
    expect(restored.props['aria-checked']).toBe(false)
  })
})
