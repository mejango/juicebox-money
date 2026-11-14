// The shared .jb file: this form's draft written in the SDK's version 2 format and read
// back whole, and a file holding what this form cannot express refused, never half read.
import { describe, expect, it } from 'vitest'
import { parseJbDraft, type JbDraft } from '@bananapus/nana-sdk-core/v6'
import { parseDraft, type CreateDraft } from '@/lib/draft'
import { fromJbDraft, readJbDraftFile, toJbDraft, writeJbDraftFile } from '@/lib/jb-draft'
import { toLocalDateTimeInput } from '@/lib/format'

const A = '0x00000000000000000000000000000000000000a1'
const B = '0x00000000000000000000000000000000000000b2'
const START = 1_900_000_020

/** A row with only what its kind uses: an address row names a recipient, the others do not. */
const split = (patch: { kind?: string } & Record<string, unknown>) => ({
  value: '10',
  kind: 'address',
  recipient: patch.kind ? '' : A,
  ...patch,
})

function projectDraft(): CreateDraft {
  return parseDraft(JSON.stringify({
    v: 1,
    flavor: 'project',
    savedRules: {},
    name: 'Round trip',
    ticker: 'TRIP',
    tagline: 'A tagline',
    description: 'Words',
    payNotice: 'Mind the gap',
    tags: ['art', 'music'],
    logoUri: 'ipfs://logo',
    coverUri: 'ipfs://cover',
    links: { infoUri: 'https://x.test', twitter: 'x', instagram: 'i', whatsapp: 'w' },
    owner: A,
    ownerPerChain: { 8453: B },
    allowAnyToken: false,
    approvalCustom: B,
    approvalPerChain: { 8453: A },
    accepts: ['eth', 'usdc'],
    customAddress: '',
    issuanceBase: 'usd',
    linkChains: true,
    bridge: 'both',
    chains: [1, 8453],
    afterMode: 'cycle',
    approvalDeadline: 'custom',
    storeCurrency: 'usd',
    storeConfig: { collectionName: 'Shop', collectionSymbol: 'SHOP', itemsRedeem: true, operatorCanMint: false },
    storeCategories: [{ id: 1, name: 'Shirts' }],
    items: [{
      name: 'Shirt', price: '25', supply: '100', description: 'Cotton',
      mediaUri: 'ipfs://shirt', mediaType: 'image/png',
      discountPct: '5', reserveN: '10', reserveBeneficiary: A, category: 1, votingUnits: '2',
      splits: [split({ value: '50', kind: 'project', projectId: '7', beneficiary: B, perChain: { 8453: '9' } })],
      transfersPausable: true, allowCredits: false, perChainSupply: { 8453: 'unlimited' },
    }],
    stages: [
      {
        durationValue: String(7 * 86_400), scheduleOn: true, schedule: toLocalDateTimeInput(START),
        issuanceRate: '10000', cutPct: '2.5',
        reservedPct: '30',
        reservedSplits: [
          split({ value: '20', lockedUntil: toLocalDateTimeInput(START + 3_600), perChain: { 8453: B } }),
          split({ value: '5', kind: 'hook', hookKind: 'custom', hookAddress: B, beneficiary: A, projectId: '3' }),
          split({ value: '5', kind: 'hook', hookKind: 'sticky', beneficiary: B, stickyGroup: 'tenure', stickyMinWeeks: '1', stickyMaxWeeks: '52' }),
        ],
        payouts: 'routed', routedMode: 'amounts',
        payoutSplits: [split({ value: '1.5', perChainAmount: { 8453: '2' } })],
        routedModeUsdc: 'all', payoutSplitsUsdc: [split({ value: '40', kind: 'project', projectId: '4', beneficiary: A, preferAddToBalance: true })],
        holdFees: true, surplusCapOn: true, surplusAmount: '3', routedSurplusOn: true,
        cashOuts: true, cashOutTax: 3000,
        ownerMinting: true, acceptPayments: false, pauseCreditTransfers: true, pause721Transfers: true,
        metadataExtra: 5,
        powers: { setTerminals: true, addPriceFeed: true },
      },
      {
        durationValue: 'custom', customDuration: '36', customUnit: 'hours',
        issuanceRate: '', startMode: 'cycles', startCycles: '3',
        payouts: 'flexible', cashOuts: true, taxCustomOn: true, taxCustomPct: '12.34', acceptPayments: true,
      },
      {
        durationValue: '0', issuanceRate: '5', startMode: 'date', startDate: toLocalDateTimeInput(START + 86_400 * 90),
        payouts: 'none', cashOuts: false, acceptPayments: true,
      },
    ],
  }))
}

function revnetDraft(): CreateDraft {
  return parseDraft(JSON.stringify({
    v: 1, flavor: 'revnet', savedRules: {}, name: 'Rev', ticker: 'REV', chains: [1, 8453],
    owner: A, accepts: ['eth'], issuanceBase: 'eth', storeCurrency: 'eth',
    stages: [
      {
        issuanceRate: '1000', cutOn: true, cutPct: '10', cutFreqDays: '14',
        reservedSplits: [split({ value: '20' })],
        cashOuts: true, cashOutTax: 1000,
        autoIssuances: [{ count: '500', address: A, chainId: 8453, perChain: {} }, { count: '7', address: B, chainId: null, perChain: {} }],
      },
      { issuanceRate: '', cutOn: false, cutPct: '', daysAfter: '28', cashOuts: false },
    ],
  }))
}

/** What a draft says once ids and open panels are set aside. */
const said = (draft: CreateDraft) =>
  JSON.parse(JSON.stringify(draft, (key, value) =>
    ['id', 'expanded', 'open', 'perChainOpen', 'perChainSupplyOpen', 'moreOpen'].includes(key) ? undefined : value))

const refusal = (change: (file: JbDraft) => void, from = projectDraft): string => {
  const file = toJbDraft(from())
  change(file)
  try {
    readJbDraftFile(JSON.stringify(file))
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('the file was accepted')
}

describe('the shared .jb file', () => {
  it('writes a project in plain units', () => {
    const file = toJbDraft(projectDraft())
    expect(parseJbDraft(writeJbDraftFile(projectDraft()))).toEqual(file)
    expect(file).toMatchObject({
      v: 2, kind: 'project', accepts: ['eth', 'usdc'], anyToken: false, bridge: 'both',
      links: { website: 'https://x.test', instagram: 'i' },
      approvalHook: B, approvalHookPerChain: { 8453: A }, logoUri: 'ipfs://logo',
    })
    const [first, second, third] = file.stages
    expect(first).toMatchObject({
      startAt: START, duration: 7 * 86_400, issuance: '10000', baseCurrency: 'usd', cutPercent: '2.5',
      cashOutTax: '0.3', approval: 'custom', pausePay: true, holdFees: true,
      surplusAllowance: { mode: 'limited', amount: '3', currency: 'eth' },
    })
    expect(first.reserved.map((row) => row.to)).toEqual(['address', 'hook', 'sticky'])
    expect(first.reserved[0]).toMatchObject({ share: '20', lockedUntil: START + 3_600, addressPerChain: { 8453: B } })
    expect(first.reserved[2].sticky).toEqual({ group: 'tenure', minWeeks: '1', maxWeeks: '52' })
    expect(first.payouts).toMatchObject([
      { token: 'eth', mode: 'amounts', currency: 'eth', splits: [{ amount: '1.5', share: '', amountPerChain: { 8453: '2' } }] },
      { token: 'usdc', mode: 'all', currency: 'usd', splits: [{ share: '40', to: 'project', projectId: '4', addToBalance: true }] },
    ])
    expect(second).toMatchObject({
      startAt: 0, startAfterCycles: '3', duration: 36 * 3_600, issuance: '', cashOutTax: '0.1234',
      surplusAllowance: { mode: 'unlimited' },
    })
    expect(second.payouts.map((payout) => payout.mode)).toEqual(['none', 'none'])
    expect(third).toMatchObject({ startAt: START + 86_400 * 90, startAfterCycles: '', cashOutTax: '1' })
    expect(file.shop.items[0]).toMatchObject({
      mediaUri: 'ipfs://shirt', mediaType: 'image/png', reserveEvery: '10', supplyPerChain: { 8453: 'unlimited' },
      splits: [{ to: 'project', projectId: '7', projectIdPerChain: { 8453: '9' }, address: B }],
    })
  })

  it('reads its own project file back as the same draft', () => {
    expect(said(fromJbDraft(toJbDraft(projectDraft())))).toEqual(said(projectDraft()))
  })

  it('writes a revnet with its fixed rules and reads it back', () => {
    const file = toJbDraft(revnetDraft())
    expect(file).toMatchObject({ kind: 'revnet', anyToken: true, afterMode: 'wait' })
    expect(file.stages[0]).toMatchObject({
      cutPercent: '10', cutDays: '14', cashOutTax: '0.1', pause721Transfers: true, payouts: [], approval: 'none',
      autoIssuances: [{ count: '500', address: A, chainId: 8453 }, { count: '7', address: B, chainId: 1 }],
    })
    expect(file.stages[1]).toMatchObject({ startAfterDays: '28', cutPercent: '', cutDays: '', cashOutTax: '0.9999', issuance: '' })
    const back = fromJbDraft(file)
    expect(toJbDraft(back)).toEqual(file)
    expect(back.stages[1]).toMatchObject({ cashOuts: false, daysAfter: '28', cutOn: false })
    expect(back.stages[0]).toMatchObject({ cashOuts: true, cashOutTax: 1000, taxCustomOn: false, cutOn: true })
  })

  it('writes a custom token project against its token', () => {
    const draft = parseDraft(JSON.stringify({ ...projectDraft(), customAddress: B, storeCurrency: 'token', accepts: ['eth'] }))
    const file = toJbDraft(draft)
    expect(file).toMatchObject({ accepts: ['custom'], customToken: B, shop: { currency: 'token' } })
    expect(file.stages[0]).toMatchObject({ baseCurrency: 'token', payouts: [{ token: 'custom', currency: 'token' }] })
    expect(fromJbDraft(file)).toMatchObject({ customAddress: B, storeCurrency: 'token', issuanceBase: null })
  })

  it('refuses a file from before version 2 and a file that is not one', () => {
    expect(() => readJbDraftFile(JSON.stringify(projectDraft()))).toThrow('a format this site no longer reads')
    expect(() => readJbDraftFile('{"projectType":"custom","details":{},"chainIds":[]}')).toThrow('a format this site no longer reads')
    expect(() => readJbDraftFile('not json')).toThrow("That doesn't look like a .jb file.")
  })

  it('refuses what this form cannot express, naming it', () => {
    const cases: [string, (file: JbDraft) => void][] = [
      ['approval rules that differ by stage', (file) => { file.stages[1].approval = '3days' }],
      ['stages priced in different currencies', (file) => { file.stages[1].baseCurrency = 'eth' }],
      ['payouts counted in another currency than their token', (file) => { file.stages[0].payouts[0].currency = 'usd' }],
      ['an owner allowance counted in another currency than its token', (file) => { file.stages[0].surplusAllowance.currency = 'usd' }],
      ['cash outs counted against one chain only', (file) => { file.stages[0].useTotalSurplusForCashOuts = false }],
      ['payouts only the owner can send', (file) => { file.stages[0].ownerMustSendPayouts = true }],
      ['a shop item left off some chains', (file) => { file.shop.items[0].excludedChains = [8453] }],
      ['a reserved item beneficiary that differs by chain', (file) => { file.shop.items[0].reserveBeneficiaryPerChain = { 8453: B } }],
      ['a time set to the second', (file) => { file.stages[0].startAt = START + 1 }],
      ['a ticker that is not 1 to 11 capital letters and digits', (file) => { file.ticker = 'trip' }],
      ['a chain this site does not launch on', (file) => { file.chains = [1, 999_999] }],
      ['mainnet and testnet chains together', (file) => { file.chains = [1, 84532] }],
      ['a cash out tax finer than four decimals', (file) => { file.stages[0].cashOutTax = '0.12345' }],
      ['a hook split that differs by chain', (file) => { file.stages[0].reserved[1].addressPerChain = { 8453: B } }],
      ['a value longer than this form holds', (file) => { file.stages[0].reserved[0].share = '20.000000001' }],
      ['a value longer than this form holds', (file) => { file.shop.categories[0].name = 'x'.repeat(41) }],
      ['an owner allowance beside payouts of everything', (file) => {
        file.stages[0].payouts[0] = { ...file.stages[0].payouts[0], mode: 'all', splits: [] }
      }],
    ]
    for (const [what, change] of cases) {
      expect(refusal(change)).toBe(`juicebox.money can't launch this file: it has ${what}.`)
    }
    expect(refusal((file) => { file.stages[0].cashOutTax = '1' }, revnetDraft)).toContain('a revnet cash out tax of 1')
    expect(refusal((file) => { file.anyToken = false }, revnetDraft)).toContain('a revnet that does not accept any token')
  })

  it('keeps a new Safe as the owner', () => {
    const draft = parseDraft(JSON.stringify({ ...projectDraft(), authorityMode: 'create', authoritySigners: [A, B], authorityThreshold: 2 }))
    const file = toJbDraft(draft)
    expect(file).toMatchObject({ owner: '', ownerPerChain: {}, safe: { signers: [A, B], threshold: 2 } })
    expect(fromJbDraft(file)).toMatchObject({ authorityMode: 'create', authoritySigners: [A, B], authorityThreshold: 2 })
  })
})
