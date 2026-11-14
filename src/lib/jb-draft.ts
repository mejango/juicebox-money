import {
  emptyJbDraftItem,
  emptyJbDraftSplit,
  emptyJbDraftStage,
  jbDraftTokenCurrency,
  jbDraftUnsupported,
  parseJbDraft,
  serializeJbDraft,
  type JbDraft,
  type JbDraftChainMap,
  type JbDraftCurrency,
  type JbDraftItem,
  type JbDraftPayout,
  type JbDraftSplit,
  type JbDraftStage,
} from '@bananapus/nana-sdk-core/v6'
import { formatUnits } from 'viem'
import {
  isStickyRow,
  newDraftSplit,
  type DraftSplit,
} from '@/components/create/SplitsEditor'
import {
  CASH_OUT_TAXES,
  DURATION_PRESETS,
  newDraftStage,
  scheduledStart,
  stageCashOutTax,
  stageDurationSeconds,
  type DraftStage,
} from '@/components/create/stage-draft'
import { newDraftItem } from '@/components/create/store-draft'
import { SUPPORTED_CHAINS, environmentForChainIds } from '@/lib/chains'
import { parseDraft, type CreateDraft } from '@/lib/draft'
import { toLocalDateTimeInput } from '@/lib/format'
import {
  autoIssuanceMintChain,
  CASH_OUTS_OFF_REVNET,
  FOREVER_SECONDS,
  launchAcceptsAnyToken,
} from '@/lib/launch'

/**
 * The shared `.jb` file (the SDK's version 2 format) to and from this form's
 * own draft. The form's draft stays the browser's saved state; only files
 * cross here. Reading refuses what this form cannot express, so a file from
 * another site either opens whole or not at all.
 */

const SITE = 'juicebox.money'
const refuse = (what: string): never => {
  throw jbDraftUnsupported(SITE, what)
}

type Token = JbDraft['accepts'][number]

/** A typed number as the format's plain decimal, or '' when it isn't one. */
const num = (value: string): string => {
  const text = value.trim()
  return /^\d*(?:\.\d*)?$/.test(text) ? text : ''
}
const projectIdOf = (value: string) => num(value.replace('#', ''))
const unixOf = (local: string): number => {
  const ms = local ? new Date(local).getTime() : NaN
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
}
const chainMapOut = (
  map: Record<number, string>,
  clean: (value: string) => string = (value) => value.trim(),
): JbDraftChainMap =>
  Object.fromEntries(
    Object.entries(map)
      .map(([chainId, value]) => [chainId, clean(value)] as const)
      .filter(([chainId, value]) => Number(chainId) > 0 && value !== ''),
  )

function splitOut(row: DraftSplit, amounts = false): JbDraftSplit {
  const base: JbDraftSplit = {
    ...emptyJbDraftSplit(),
    share: amounts ? '' : num(row.value),
    amount: amounts ? num(row.value) : '',
    amountPerChain: amounts ? chainMapOut(row.perChainAmount, num) : {},
    lockedUntil: unixOf(row.lockedUntil),
  }
  if (isStickyRow(row)) {
    return {
      ...base,
      to: 'sticky',
      address: row.beneficiary.trim(),
      sticky: {
        group: row.stickyGroup,
        minWeeks: num(row.stickyMinWeeks),
        maxWeeks: num(row.stickyMaxWeeks),
      },
    }
  }
  if (row.kind === 'hook') {
    const shared = {
      address: row.beneficiary.trim(),
      projectId: projectIdOf(row.projectId),
    }
    // A superseded Market maker hook is kept by its address, never migrated.
    return row.hookKind === 'fundmarket'
      ? { ...base, ...shared, to: 'fundMarket' }
      : { ...base, ...shared, to: 'hook', hook: row.hookAddress.trim() }
  }
  if (row.kind === 'project') {
    return {
      ...base,
      to: 'project',
      projectId: projectIdOf(row.projectId),
      projectIdPerChain: chainMapOut(row.perChain, projectIdOf),
      address: row.beneficiary.trim(),
      addressPerChain: chainMapOut(row.perChainBeneficiary),
      addToBalance: row.preferAddToBalance,
    }
  }
  return {
    ...base,
    to: 'address',
    address: row.recipient.trim(),
    addressPerChain: chainMapOut(row.perChain),
  }
}

/** A rate out of 10,000 as the format's 0 to 1 value. */
const taxOut = (rate: number) => formatUnits(BigInt(rate), 4)

/** Write this form's draft as the shared file's contents. */
export function toJbDraft(draft: CreateDraft): JbDraft {
  const revnet = draft.flavor === 'revnet'
  const kind = revnet ? 'revnet' : 'project'
  const custom = draft.customAddress.trim() !== ''
  const tokens: Token[] = custom ? ['custom'] : draft.accepts
  const funds = jbDraftTokenCurrency(tokens[0])
  const base: JbDraftCurrency = custom
    ? 'token'
    : (draft.issuanceBase ?? (draft.accepts.includes('eth') ? 'eth' : 'usd'))
  const multi = tokens.length > 1

  const stageOut = (stage: DraftStage, index: number): JbDraftStage => {
    const common = {
      ...emptyJbDraftStage(kind, tokens),
      baseCurrency: base,
      startAt: index === 0 ? (scheduledStart(stage) ?? 0) : 0,
      issuance: num(stage.issuanceRate),
      reserved: stage.reservedSplits.map((row) => splitOut(row)),
      metadataExtra: stage.metadataExtra,
    }
    if (revnet) {
      const cutOn = stage.cutOn && Number(stage.cutPct) > 0
      return {
        ...common,
        startAfterDays: index === 0 ? '' : num(stage.daysAfter),
        cutPercent: cutOn ? num(stage.cutPct) : '',
        cutDays: cutOn ? num(stage.cutFreqDays) : '',
        cashOutTax: taxOut(
          stage.cashOuts ? stageCashOutTax(stage) : CASH_OUTS_OFF_REVNET,
        ),
        autoIssuances: draft.chains.length
          ? stage.autoIssuances
              .filter((row) => row.count.trim() || row.address.trim())
              .map((row) => {
                const chainId = autoIssuanceMintChain(draft.chains, row.chainId)
                return {
                  count: num(row.count),
                  address: (row.perChain[chainId]?.trim() || row.address).trim(),
                  chainId,
                }
              })
          : [],
      }
    }
    const routed = stage.payouts === 'routed'
    const payouts: JbDraftPayout[] = tokens.map((token, n) => {
      const twin = multi && n === 1
      const rows = twin ? stage.payoutSplitsUsdc : stage.payoutSplits
      const amounts = (twin ? stage.routedModeUsdc : stage.routedMode) === 'amounts'
      // Fixed amounts with none set is a payout limit of zero: no payouts.
      const mode = !routed ? 'none' : !amounts ? 'all' : rows.length ? 'amounts' : 'none'
      return {
        token,
        mode,
        currency: jbDraftTokenCurrency(token),
        splits: mode === 'none' ? [] : rows.map((row) => splitOut(row, amounts)),
      }
    })
    const paysAll = routed && payouts.every((payout) => payout.mode === 'all')
    const allowance =
      stage.payouts === 'flexible' || (routed && !paysAll && stage.routedSurplusOn)
    const byDate = index > 0 && stage.startMode === 'date'
    return {
      ...common,
      startAt: byDate ? unixOf(stage.startDate) : common.startAt,
      startAfterCycles:
        index === 0 || (byDate && unixOf(stage.startDate) > 0)
          ? ''
          : num(stage.startCycles) || '1',
      duration: stageDurationSeconds(stage),
      cutPercent: num(stage.cutPct),
      cashOutTax: stage.cashOuts ? taxOut(stageCashOutTax(stage)) : '1',
      payouts,
      surplusAllowance: {
        mode: !allowance ? 'none' : stage.surplusCapOn ? 'limited' : 'unlimited',
        amount: allowance && stage.surplusCapOn ? num(stage.surplusAmount) : '',
        currency: funds,
      },
      approval: draft.approvalDeadline,
      holdFees: stage.payouts !== 'none' && stage.holdFees,
      ownerMinting: stage.ownerMinting,
      pausePay: !stage.acceptPayments,
      pauseCreditTransfers: stage.pauseCreditTransfers,
      pause721Transfers: stage.pause721Transfers,
      powers: { ...stage.powers },
    }
  }

  const itemOut = (item: CreateDraft['items'][number]): JbDraftItem => ({
    ...emptyJbDraftItem(),
    name: item.name,
    description: item.description,
    mediaUri: item.mediaUri,
    mediaType: item.mediaType,
    price: num(item.price),
    supply: num(item.supply),
    supplyPerChain: chainMapOut(item.perChainSupply, (value) =>
      value.trim().toLowerCase() === 'unlimited' ? 'unlimited' : num(value),
    ),
    discountPercent: num(item.discountPct),
    reserveEvery: num(item.reserveN),
    reserveBeneficiary: item.reserveBeneficiary.trim(),
    category: item.category,
    votingUnits: num(item.votingUnits),
    splits: item.splits.map((row) => splitOut(row)),
    allowOwnerMint: item.allowOwnerMint,
    transfersPausable: item.transfersPausable,
    cantBeRemoved: item.cantBeRemoved,
    allowCredits: item.allowCredits,
    ownerCanEditDiscount: item.ownerCanEditDiscount,
  })

  const newSafe = draft.authorityMode === 'create'
  return {
    v: 2,
    kind,
    name: draft.name,
    ticker: draft.ticker,
    tagline: draft.tagline,
    description: draft.description,
    payNotice: draft.payNotice,
    tags: draft.tags,
    logoUri: draft.logoUri,
    coverUri: draft.coverUri,
    links: {
      website: draft.links.infoUri ?? '',
      twitter: draft.links.twitter ?? '',
      discord: draft.links.discord ?? '',
      telegram: draft.links.telegram ?? '',
      instagram: draft.links.instagram ?? '',
      whatsapp: draft.links.whatsapp ?? '',
    },
    chains: draft.chains,
    linkChains: draft.linkChains,
    bridge: draft.bridge,
    owner: newSafe ? '' : draft.owner.trim(),
    ownerPerChain: newSafe ? {} : chainMapOut(draft.ownerPerChain),
    safe: newSafe
      ? {
          signers: (draft.authoritySigners ?? []).map((signer) => signer.trim()),
          threshold: draft.authorityThreshold ?? 0,
        }
      : null,
    accepts: tokens,
    customToken: draft.customAddress.trim(),
    anyToken: launchAcceptsAnyToken(draft.flavor, draft.allowAnyToken),
    approvalHook:
      !revnet && draft.approvalDeadline === 'custom' ? draft.approvalCustom.trim() : '',
    approvalHookPerChain:
      !revnet && draft.approvalDeadline === 'custom'
        ? chainMapOut(draft.approvalPerChain)
        : {},
    afterMode: revnet ? 'wait' : draft.afterMode,
    stages: draft.stages.map(stageOut),
    shop: {
      currency:
        draft.storeCurrency === 'token' && !custom
          ? funds
          : (draft.storeCurrency ?? funds),
      ...draft.storeConfig,
      categories: draft.storeCategories,
      items: draft.items.map(itemOut),
    },
  }
}

/** The text of a `.jb` file for this form's draft. */
export function writeJbDraftFile(draft: CreateDraft): string {
  return serializeJbDraft(toJbDraft(draft))
}

const hasEntries = (map: object) => Object.keys(map).length > 0
const sameAsFirst = <T>(values: T[]) => values.every((value) => value === values[0])

/** The form's inputs hold minutes, so a time with seconds cannot be kept. */
function localOf(seconds: number): string {
  if (seconds === 0) return ''
  if (seconds % 60 !== 0) refuse('a time set to the second')
  return toLocalDateTimeInput(seconds)
}

function splitIn(row: JbDraftSplit, amounts = false): DraftSplit {
  const base: DraftSplit = {
    ...newDraftSplit(),
    value: amounts ? row.amount : row.share,
    perChainAmount: { ...row.amountPerChain },
    lockedUntil: localOf(row.lockedUntil),
  }
  if (row.to === 'address') {
    return { ...base, recipient: row.address, perChain: { ...row.addressPerChain } }
  }
  if (row.to === 'project') {
    return {
      ...base,
      kind: 'project',
      projectId: row.projectId,
      perChain: { ...row.projectIdPerChain },
      beneficiary: row.address,
      perChainBeneficiary: { ...row.addressPerChain },
      preferAddToBalance: row.addToBalance,
    }
  }
  if (hasEntries(row.addressPerChain)) refuse('a hook split that differs by chain')
  if (row.to === 'sticky') {
    return {
      ...base,
      kind: 'hook',
      hookKind: 'sticky',
      beneficiary: row.address,
      stickyGroup: row.sticky!.group,
      stickyMinWeeks: row.sticky!.minWeeks,
      stickyMaxWeeks: row.sticky!.maxWeeks,
    }
  }
  return {
    ...base,
    kind: 'hook',
    hookKind: row.to === 'fundMarket' ? 'fundmarket' : 'custom',
    hookAddress: row.hook,
    projectId: row.projectId,
    beneficiary: row.address,
  }
}

const sumOf = (rows: JbDraftSplit[]) =>
  String(Number(rows.reduce((sum, row) => sum + (Number(row.share) || 0), 0).toFixed(6)))

/** The format's 0 to 1 tax as a rate out of 10,000. */
function taxIn(value: string): number {
  const rate = Number(value || '0') * 10_000
  if (!Number.isFinite(rate) || rate > 10_000) refuse('a cash out tax above 1')
  if (Math.abs(rate - Math.round(rate)) > 1e-6) {
    refuse('a cash out tax finer than four decimals')
  }
  return Math.round(rate)
}

const taxFields = (
  rate: number,
): Pick<DraftStage, 'cashOutTax' | 'taxCustomOn' | 'taxCustomPct'> =>
  CASH_OUT_TAXES.some((tax) => tax.rate === rate)
    ? { cashOutTax: rate, taxCustomOn: false, taxCustomPct: '' }
    : { cashOutTax: 0, taxCustomOn: true, taxCustomPct: formatUnits(BigInt(rate), 2) }

function durationFields(
  seconds: number,
): Pick<DraftStage, 'durationValue' | 'customDuration' | 'customUnit'> {
  const preset =
    seconds === 0 ||
    seconds === FOREVER_SECONDS ||
    DURATION_PRESETS.some(([value]) => value === seconds)
  if (preset) return { durationValue: String(seconds), customDuration: '', customUnit: 'days' }
  const units = [
    ['years', 31_536_000],
    ['weeks', 604_800],
    ['days', 86_400],
  ] as const
  const [customUnit, size] = units.find(([, each]) => seconds % each === 0) ?? [
    'hours' as const,
    3_600,
  ]
  const customDuration = String(seconds / size)
  if (Math.round(Number(customDuration) * size) !== seconds) refuse('a cycle length this form cannot show')
  return { durationValue: 'custom', customDuration, customUnit }
}

/** Keys the form sets for its own display, not part of what a draft says. */
const DISPLAY_KEYS = new Set([
  'id',
  'expanded',
  'open',
  'perChainOpen',
  'perChainSupplyOpen',
  'moreOpen',
])
/** What a draft says, whatever order its keys were written in. */
const said = (value: unknown): string =>
  JSON.stringify(value, (key, entry) =>
    DISPLAY_KEYS.has(key)
      ? undefined
      : entry && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          )
        : entry,
  )

/** Read the shared file's contents into this form's draft, or refuse it whole. */
export function fromJbDraft(file: JbDraft): CreateDraft {
  const revnet = file.kind === 'revnet'
  const custom = file.accepts.includes('custom')
  const tokens = file.accepts as Token[]
  if (tokens.length === 0) refuse('no accepted token')
  if (custom !== (file.customToken !== '')) refuse('a custom token without its address')
  const funds = jbDraftTokenCurrency(tokens[0])
  const multi = tokens.length > 1

  if (file.ticker !== file.ticker.toUpperCase().replace(/[^A-Z0-9]/g, '') || file.ticker.length > 11) {
    refuse('a ticker that is not 1 to 11 capital letters and digits')
  }
  const supported = file.chains.every((id) =>
    SUPPORTED_CHAINS.some((chain) => chain.id === id),
  )
  if (!supported) refuse('a chain this site does not launch on')
  const environment = environmentForChainIds(file.chains)
  if (file.chains.some((id) => environmentForChainIds([id]) !== environment)) {
    refuse('mainnet and testnet chains together')
  }
  if (revnet && !file.anyToken) refuse('a revnet that does not accept any token')

  const bases = file.stages.map((stage) => stage.baseCurrency)
  if (!sameAsFirst(bases)) refuse('stages priced in different currencies')
  if (custom && bases[0] !== 'token') refuse('issuance priced in another currency than its token')
  const approvals = file.stages.map((stage) => stage.approval)
  if (!sameAsFirst(approvals)) refuse('approval rules that differ by stage')
  if (!custom && file.shop.currency === 'token') refuse('a shop priced in a token it does not accept')

  const stageIn = (stage: JbDraftStage, index: number): DraftStage => {
    const first = index === 0
    const common: DraftStage = {
      ...newDraftStage(first, file.kind),
      scheduleOn: first && stage.startAt > 0,
      schedule: first ? localOf(stage.startAt) : '',
      issuanceRate: stage.issuance,
      cutPct: stage.cutPercent,
      reservedPct: sumOf(stage.reserved),
      reservedSplits: stage.reserved.map((row) => splitIn(row)),
      metadataExtra: stage.metadataExtra,
    }
    if (revnet) {
      const rate = taxIn(stage.cashOutTax)
      if (rate > CASH_OUTS_OFF_REVNET) refuse('a revnet cash out tax of 1')
      const off = rate === CASH_OUTS_OFF_REVNET
      return {
        ...common,
        daysAfter: first ? common.daysAfter : stage.startAfterDays,
        cutOn: Number(stage.cutPercent) > 0,
        cutFreqDays: stage.cutDays || common.cutFreqDays,
        cashOuts: !off,
        ...(off ? {} : taxFields(rate)),
        autoIssuances: stage.autoIssuances.map((row) => ({
          id: crypto.randomUUID(),
          count: row.count,
          address: row.address,
          chainId: row.chainId,
          perChain: {},
        })),
      }
    }
    if (!stage.useTotalSurplusForCashOuts) refuse('cash outs counted against one chain only')
    if (stage.ownerMustSendPayouts) refuse('payouts only the owner can send')
    stage.payouts.forEach((payout) => {
      if (payout.currency !== jbDraftTokenCurrency(payout.token)) {
        refuse('payouts counted in another currency than their token')
      }
    })
    const modes = stage.payouts.map((payout) => payout.mode)
    const allowance = stage.surplusAllowance
    if (allowance.mode !== 'none' && allowance.currency !== funds) {
      refuse('an owner allowance counted in another currency than its token')
    }
    const routed = modes.some((mode) => mode !== 'none')
    const paysAll = modes.every((mode) => mode === 'all')
    if (paysAll && allowance.mode !== 'none') {
      refuse('an owner allowance beside payouts of everything')
    }
    const rate = taxIn(stage.cashOutTax)
    const rowsOf = (n: number) =>
      (stage.payouts[n]?.splits ?? []).map((row) => splitIn(row, modes[n] === 'amounts'))
    // "None" beside a paying token is fixed amounts with none set.
    const modeOf = (n: number) => (modes[n] === 'all' ? 'all' : 'amounts')
    return {
      ...common,
      ...durationFields(stage.duration),
      startMode: !first && stage.startAt > 0 ? 'date' : 'cycles',
      startCycles: stage.startAfterCycles || '1',
      startDate: first ? '' : localOf(stage.startAt),
      payouts: routed ? 'routed' : allowance.mode === 'none' ? 'none' : 'flexible',
      routedMode: routed ? modeOf(0) : 'all',
      payoutSplits: routed ? rowsOf(0) : [],
      routedModeUsdc: routed && multi ? modeOf(1) : 'all',
      payoutSplitsUsdc: routed && multi ? rowsOf(1) : [],
      holdFees: stage.holdFees,
      surplusCapOn: allowance.mode === 'limited',
      surplusAmount: allowance.mode === 'limited' ? allowance.amount : '',
      routedSurplusOn: routed && allowance.mode !== 'none',
      cashOuts: rate < 10_000,
      ...(rate < 10_000 ? taxFields(rate) : {}),
      ownerMinting: stage.ownerMinting,
      acceptPayments: !stage.pausePay,
      pauseCreditTransfers: stage.pauseCreditTransfers,
      pause721Transfers: stage.pause721Transfers,
      powers: { ...stage.powers },
    }
  }

  const itemIn = (item: JbDraftItem): CreateDraft['items'][number] => {
    if (item.excludedChains.length) refuse('a shop item left off some chains')
    if (hasEntries(item.reserveBeneficiaryPerChain)) {
      refuse('a reserved item beneficiary that differs by chain')
    }
    const { mediaFile: _file, mediaPreview: _preview, ...blank } = newDraftItem()
    return {
      ...blank,
      name: item.name,
      description: item.description,
      mediaUri: item.mediaUri,
      mediaType: item.mediaType,
      price: item.price,
      supply: item.supply,
      perChainSupply: { ...item.supplyPerChain },
      discountPct: item.discountPercent,
      reserveN: item.reserveEvery,
      reserveBeneficiary: item.reserveBeneficiary,
      category: item.category,
      votingUnits: item.votingUnits,
      splits: item.splits.map((row) => splitIn(row)),
      allowOwnerMint: item.allowOwnerMint,
      transfersPausable: item.transfersPausable,
      cantBeRemoved: item.cantBeRemoved,
      allowCredits: item.allowCredits,
      ownerCanEditDiscount: item.ownerCanEditDiscount,
    }
  }

  const { currency: storeCurrency, categories, items, ...storeConfig } = file.shop
  const built: CreateDraft = {
    v: 1,
    flavor: file.kind,
    savedRules: {},
    name: file.name,
    ticker: file.ticker,
    tagline: file.tagline,
    description: file.description,
    payNotice: file.payNotice,
    tags: file.tags,
    logoUri: file.logoUri,
    coverUri: file.coverUri,
    links: {
      infoUri: file.links.website,
      twitter: file.links.twitter,
      discord: file.links.discord,
      telegram: file.links.telegram,
      whatsapp: file.links.whatsapp,
      instagram: file.links.instagram,
    },
    owner: file.owner,
    ownerPerChain: { ...file.ownerPerChain },
    authorityMode: file.safe ? 'create' : 'existing',
    authoritySigners: file.safe ? file.safe.signers : ['', '', ''],
    authorityThreshold: file.safe ? file.safe.threshold : 2,
    allowAnyToken: file.anyToken,
    approvalCustom: file.approvalHook,
    approvalPerChain: { ...file.approvalHookPerChain },
    accepts: custom ? ['eth'] : (tokens as CreateDraft['accepts']),
    customAddress: file.customToken,
    issuanceBase: custom ? null : (bases[0] as 'eth' | 'usd'),
    linkChains: file.linkChains,
    bridge: file.bridge,
    chains: file.chains,
    stages: file.stages.map(stageIn),
    afterMode: file.afterMode,
    approvalDeadline: revnet ? '1day' : approvals[0],
    storeCurrency,
    storeConfig,
    storeCategories: categories,
    items: items.map(itemIn),
  }
  // The form's own reader caps and cleans what it holds. A value it would
  // change is one this form cannot keep, so the file is refused, not trimmed.
  const kept = parseDraft(JSON.stringify(built))
  if (said(kept) !== said(built)) refuse('a value longer than this form holds')
  return kept
}

/** Read the text of a `.jb` file into this form's draft. Throws a message to show. */
export function readJbDraftFile(text: string): CreateDraft {
  return fromJbDraft(parseJbDraft(text))
}
