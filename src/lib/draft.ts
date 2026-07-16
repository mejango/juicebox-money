import type { DraftItem } from '@/components/create/StoreEditor'
import type { DraftSplit } from '@/components/create/SplitsEditor'
import type { DraftStage } from '@/components/create/StageRulesEditor'
import type { ApprovalDeadline, TreasuryCurrency } from '@/lib/launch'

/**
 * .jb draft files + localStorage persistence (website/ parity: the draft is
 * the sanitized wizard state; import whitelists known fields and caps array
 * sizes — it's the security boundary for untrusted files). Uploaded files
 * (logo/cover/item media) can't serialize; they're dropped with a note.
 */

export const DRAFT_KEY = 'jbm-create-draft'

export type CreateDraft = {
  v: 1
  flavor: 'project' | 'revnet'
  name: string
  ticker: string
  tagline: string
  description: string
  payNotice: string
  tags: string[]
  links: Record<string, string>
  owner: string
  ownerPerChain: Record<number, string>
  allowAnyToken: boolean
  approvalCustom: string
  approvalPerChain: Record<number, string>
  accepts: TreasuryCurrency[]
  customAddress: string
  issuanceBase: 'eth' | 'usd' | null
  chains: number[]
  stages: DraftStage[]
  afterMode: 'wait' | 'terminal' | 'cycle'
  approvalDeadline: ApprovalDeadline
  storeCurrency: 'eth' | 'usd' | 'token' | null
  storeConfig: {
    collectionName: string
    collectionSymbol: string
    preventOverspending: boolean
    noNewTiersWithReserves: boolean
    noNewTiersWithVotes: boolean
    noNewTiersWithOwnerMinting: boolean
    issueTokensForSplits: boolean
    itemsRedeem: boolean
  }
  items: Omit<DraftItem, 'mediaFile' | 'mediaPreview'>[]
}

export function draftFileName(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  return `${slug}.jb`
}

function sanitizeChainMap(source: unknown): Record<number, string> {
  const target: Record<number, string> = {}
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [k, v] of Object.entries(source).slice(0, 16)) {
      const id = Number(k)
      if (Number.isInteger(id) && typeof v === 'string')
        target[id] = v.slice(0, 64)
    }
  }
  return target
}

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.slice(0, max) : ''
const bool = (v: unknown): boolean => v === true
const numStr = (v: unknown, max = 20): string =>
  typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : ''

function sanitizeSplit(raw: unknown): DraftSplit {
  const s = (raw ?? {}) as Record<string, unknown>
  const perChain: Record<number, string> = {}
  const perChainBeneficiary: Record<number, string> = {}
  for (const [source, target] of [
    [s.perChain, perChain],
    [s.perChainBeneficiary, perChainBeneficiary],
  ] as const) {
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const [k, v] of Object.entries(source).slice(0, 16)) {
        const id = Number(k)
        if (Number.isInteger(id) && typeof v === 'string')
          target[id] = v.slice(0, 64)
      }
    }
  }
  return {
    id: crypto.randomUUID(),
    value: numStr(s.value, 10),
    kind:
      s.kind === 'project' ? 'project' : s.kind === 'hook' ? 'hook' : 'address',
    recipient: str(s.recipient, 64),
    projectId: numStr(s.projectId, 11),
    beneficiary: str(s.beneficiary, 64),
    perChain,
    perChainBeneficiary,
    perChainOpen: false,
    hookKind: s.hookKind === 'custom' ? 'custom' : 'fundmarket',
    hookAddress: str(s.hookAddress, 64),
    preferAddToBalance: bool(s.preferAddToBalance),
    lockedUntil: str(s.lockedUntil, 20),
  }
}

function sanitizeStage(raw: unknown): DraftStage {
  const s = (raw ?? {}) as Record<string, unknown>
  const powers = (s.powers ?? {}) as Record<string, unknown>
  return {
    id: crypto.randomUUID(),
    durationValue: numStr(s.durationValue, 12) || '0',
    customDuration: numStr(s.customDuration, 6),
    customUnit: ['hours', 'days', 'weeks', 'years'].includes(
      s.customUnit as string,
    )
      ? (s.customUnit as DraftStage['customUnit'])
      : 'days',
    scheduleOn: bool(s.scheduleOn),
    schedule: str(s.schedule, 32),
    issuanceRate: numStr(s.issuanceRate, 15),
    cutOn: bool(s.cutOn),
    cutPct: numStr(s.cutPct, 5),
    cutFreqDays: numStr(s.cutFreqDays, 5) || '30',
    daysAfter: numStr(s.daysAfter, 5) || '30',
    reservedPct: numStr(s.reservedPct, 5) || '0',
    reservedSplits: (Array.isArray(s.reservedSplits) ? s.reservedSplits : [])
      .slice(0, 100)
      .map(sanitizeSplit),
    payouts: ['none', 'flexible', 'routed'].includes(s.payouts as string)
      ? (s.payouts as DraftStage['payouts'])
      : 'none',
    routedMode: s.routedMode === 'amounts' ? 'amounts' : 'all',
    payoutSplits: (Array.isArray(s.payoutSplits) ? s.payoutSplits : [])
      .slice(0, 100)
      .map(sanitizeSplit),
    holdFees: bool(s.holdFees),
    cashOuts: bool(s.cashOuts),
    cashOutTax:
      typeof s.cashOutTax === 'number' &&
      Number.isInteger(s.cashOutTax) &&
      s.cashOutTax >= 0 &&
      s.cashOutTax < 10_000
        ? s.cashOutTax
        : 0,
    taxCustomOn: bool(s.taxCustomOn),
    taxCustomPct: numStr(s.taxCustomPct, 5),
    ownerMinting: bool(s.ownerMinting),
    acceptPayments: s.acceptPayments === undefined ? true : bool(s.acceptPayments),
    pauseCreditTransfers: bool(s.pauseCreditTransfers),
    powers: {
      setTerminals: bool(powers.setTerminals),
      setController: bool(powers.setController),
      terminalMigration: bool(powers.terminalMigration),
      setCustomToken: bool(powers.setCustomToken),
      addAccountingContext: bool(powers.addAccountingContext),
      addPriceFeed: bool(powers.addPriceFeed),
    },
    expanded: false,
    open: {},
  }
}

function sanitizeItem(raw: unknown): Omit<DraftItem, 'mediaFile' | 'mediaPreview'> {
  const s = (raw ?? {}) as Record<string, unknown>
  return {
    id: crypto.randomUUID(),
    name: str(s.name, 100),
    price: numStr(s.price, 20),
    supply: numStr(s.supply, 9),
    description: str(s.description, 1000),
    discountPct: numStr(s.discountPct, 5),
    reserveN: numStr(s.reserveN, 5),
    reserveBeneficiary: str(s.reserveBeneficiary, 64),
    splits: (Array.isArray(s.splits) ? s.splits : [])
      .slice(0, 100)
      .map(sanitizeSplit),
    moreOpen: false,
  }
}

/** Parse untrusted .jb JSON into a sanitized draft, or throw a friendly
 *  error. Every field is whitelisted; arrays are capped. */
export function parseDraft(text: string): CreateDraft {
  if (text.length > 2_000_000) throw new Error('That file is too large.')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error("That doesn't look like a .jb file.")
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error("That doesn't look like a .jb file.")
  }
  const d = raw as Record<string, unknown>
  if (!Array.isArray(d.stages) || typeof d.name !== 'string') {
    throw new Error('No Juicebox draft found in that file.')
  }
  const links: Record<string, string> = {}
  const rawLinks = (d.links ?? {}) as Record<string, unknown>
  for (const key of [
    'infoUri',
    'twitter',
    'discord',
    'telegram',
    'whatsapp',
    'instagram',
  ]) {
    links[key] = str(rawLinks[key], 300)
  }
  const stages = d.stages.slice(0, 20).map(sanitizeStage)
  if (stages.length === 0) throw new Error('No stages found in that file.')
  stages[0].expanded = true
  return {
    v: 1,
    flavor: d.flavor === 'revnet' ? 'revnet' : 'project',
    name: str(d.name, 100),
    ticker: str(d.ticker, 11).toUpperCase().replace(/[^A-Z0-9]/g, ''),
    tagline: str(d.tagline, 100),
    description: str(d.description, 5000),
    payNotice: str(d.payNotice, 1000),
    tags: (Array.isArray(d.tags) ? d.tags : [])
      .filter((t): t is string => typeof t === 'string')
      .map(t => t.slice(0, 30))
      .slice(0, 3),
    links,
    owner: str(d.owner, 64),
    ownerPerChain: sanitizeChainMap(d.ownerPerChain),
    allowAnyToken: d.allowAnyToken === undefined ? true : bool(d.allowAnyToken),
    approvalCustom: str(d.approvalCustom, 64),
    approvalPerChain: sanitizeChainMap(d.approvalPerChain),
    accepts: (Array.isArray(d.accepts) ? d.accepts : ['eth'])
      .filter((t): t is TreasuryCurrency => t === 'eth' || t === 'usdc')
      .slice(0, 2).length
      ? (Array.isArray(d.accepts) ? d.accepts : ['eth'])
          .filter((t): t is TreasuryCurrency => t === 'eth' || t === 'usdc')
          .slice(0, 2)
      : ['eth'],
    customAddress: str(d.customAddress, 64),
    issuanceBase:
      d.issuanceBase === 'eth' ? 'eth' : d.issuanceBase === 'usd' ? 'usd' : null,
    chains: (Array.isArray(d.chains) ? d.chains : [])
      .filter(c => Number.isInteger(c))
      .slice(0, 16) as number[],
    stages,
    afterMode: ['wait', 'terminal', 'cycle'].includes(d.afterMode as string)
      ? (d.afterMode as CreateDraft['afterMode'])
      : 'wait',
    approvalDeadline: ['none', '3hours', '1day', '3days', '7days'].includes(
      d.approvalDeadline as string,
    )
      ? (d.approvalDeadline as ApprovalDeadline)
      : '1day',
    storeCurrency:
      d.storeCurrency === 'usd'
        ? 'usd'
        : d.storeCurrency === 'eth'
          ? 'eth'
          : d.storeCurrency === 'token'
            ? 'token'
            : null,
    storeConfig: (() => {
      const c = (d.storeConfig ?? {}) as Record<string, unknown>
      return {
        collectionName: str(c.collectionName, 100),
        collectionSymbol: str(c.collectionSymbol, 11),
        preventOverspending: bool(c.preventOverspending),
        noNewTiersWithReserves: bool(c.noNewTiersWithReserves),
        noNewTiersWithVotes: bool(c.noNewTiersWithVotes),
        noNewTiersWithOwnerMinting: bool(c.noNewTiersWithOwnerMinting),
        issueTokensForSplits: bool(c.issueTokensForSplits),
        itemsRedeem: bool(c.itemsRedeem),
      }
    })(),
    items: (Array.isArray(d.items) ? d.items : [])
      .slice(0, 100)
      .map(sanitizeItem),
  }
}
