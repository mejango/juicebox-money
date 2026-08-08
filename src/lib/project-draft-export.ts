import {
  NATIVE_TOKEN,
  SPLITS_TOTAL_PERCENT,
  USDC_ADDRESSES,
  jbDirectoryAbi,
  jbFundAccessLimitsAbi,
  jbSplitsAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  RESERVED_TOKEN_SPLIT_GROUP_ID,
  decode721RulesetMetadata,
  getAccountingContexts,
  getCurrentRuleset,
  getTokenAddress,
  getUpcomingRuleset,
  payoutSplitGroupId,
  v6Address,
} from '@bananapus/nana-sdk-core/v6'
import { CASH_OUTS_OFF_REVNET, lpSplitHookGeneration } from '@/lib/launch'
import { toLocalDateTimeInput } from '@/lib/format'
import {
  erc20Abi,
  formatUnits,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { newDraftSplit, type DraftSplit } from '@/components/create/SplitsEditor'
import {
  newDraftStage,
  type DraftStage,
} from '@/components/create/StageRulesEditor'
import { parseDraft, type CreateDraft } from '@/lib/draft'
import type { RawSplit } from '@/lib/splits-types'

/**
 * The project's own ERC-20 ticker, or '' when it has not deployed one. A read failure is
 * treated as "no token" (the caller warns) rather than falling back to any other symbol.
 */
async function readProjectTicker(
  client: PublicClient,
  chainId: JBChainId,
  projectId: number,
): Promise<string> {
  try {
    const token = await getTokenAddress(client, {
      chainId,
      projectId: BigInt(projectId),
    })
    if (!token) return ''
    return (await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'symbol',
    })) as string
  } catch {
    return ''
  }
}

const UNLIMITED_FLOOR = 2n ** 200n
const ZERO_ADDRESS = zeroAddress.toLowerCase()

export type ExportProjectProfile = {
  name: string
  tagline: string
  description: string
  payNotice?: string
  infoUri?: string
  twitter?: string
  discord?: string
  telegram?: string
  whatsapp?: string
  instagram?: string
}

export type ProjectDraftExportResult = {
  draft: CreateDraft
  warnings: string[]
}

type CurrencyAmount = { amount: bigint; currency: number }
type LiveContext = Awaited<ReturnType<typeof getAccountingContexts>>[number]

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

function percent(value: number): string {
  return String(Number(value.toFixed(6)))
}

/** The split's lock as the `datetime-local` wall clock the create flow parses
 *  back with `new Date(value)` — local in both directions. */
function lockDate(timestamp: number): string {
  return timestamp > 0 ? toLocalDateTimeInput(timestamp) : ''
}

function scaleDecimals(
  amount: bigint,
  fromDecimals: number,
  toDecimals: number,
): bigint {
  if (fromDecimals === toDecimals) return amount
  const factor = 10n ** BigInt(Math.abs(toDecimals - fromDecimals))
  return toDecimals > fromDecimals ? amount * factor : amount / factor
}

function splitRecipient(raw: RawSplit, value: string): DraftSplit {
  const split = newDraftSplit()
  split.value = value
  split.preferAddToBalance = raw.preferAddToBalance
  split.lockedUntil = lockDate(Number(raw.lockedUntil))

  if (raw.hook.toLowerCase() !== ZERO_ADDRESS) {
    split.kind = 'hook'
    // A redeploy of a market split should attach the CURRENT hook, which the preset
    // resolves per chain. A superseded generation stays a literal custom address so the
    // export round-trips verbatim rather than silently migrating the recipient.
    split.hookKind =
      lpSplitHookGeneration(raw.hook) === 'current' ? 'fundmarket' : 'custom'
    split.hookAddress = raw.hook
    if (raw.projectId > 0n) split.projectId = raw.projectId.toString()
    if (raw.beneficiary.toLowerCase() !== ZERO_ADDRESS) {
      split.beneficiary = raw.beneficiary
    }
  } else if (raw.projectId > 0n) {
    split.kind = 'project'
    split.projectId = raw.projectId.toString()
    split.beneficiary = raw.beneficiary
  } else {
    split.kind = 'address'
    split.recipient = raw.beneficiary
  }
  return split
}

function ownerSplit(owner: string, value: string): DraftSplit {
  const split = newDraftSplit()
  split.value = value
  split.kind = 'address'
  split.recipient = owner
  return split
}

function reservedRows(
  splits: readonly RawSplit[],
  reservedPercent: number,
  owner: string,
): DraftSplit[] {
  if (reservedPercent <= 0) return []
  const rows = splits.map((split) =>
    splitRecipient(
      split,
      percent(reservedPercent * (Number(split.percent) / SPLITS_TOTAL_PERCENT)),
    ),
  )
  const allocated = splits.reduce((sum, split) => sum + Number(split.percent), 0)
  const remainder = Math.max(0, SPLITS_TOTAL_PERCENT - allocated)
  if (remainder > 0 && owner) {
    rows.push(
      ownerSplit(
        owner,
        percent(reservedPercent * (remainder / SPLITS_TOTAL_PERCENT)),
      ),
    )
  }
  return rows.filter((row) => Number(row.value) > 0)
}

function payoutPercentRows(splits: readonly RawSplit[]): DraftSplit[] {
  return splits
    .map((split) =>
      splitRecipient(
        split,
        percent((Number(split.percent) / SPLITS_TOTAL_PERCENT) * 100),
      ),
    )
    .filter((row) => Number(row.value) > 0)
}

function payoutAmountRows(
  splits: readonly RawSplit[],
  limit: bigint,
  decimals: number,
  owner: string,
): DraftSplit[] {
  const rows = splits.map((split) => {
    const amount = (limit * BigInt(split.percent)) / BigInt(SPLITS_TOTAL_PERCENT)
    return splitRecipient(split, formatUnits(amount, decimals))
  })
  const allocated = splits.reduce((sum, split) => sum + Number(split.percent), 0)
  const remainder = Math.max(0, SPLITS_TOTAL_PERCENT - allocated)
  if (remainder > 0 && owner) {
    const amount = (limit * BigInt(remainder)) / BigInt(SPLITS_TOTAL_PERCENT)
    rows.push(ownerSplit(owner, formatUnits(amount, decimals)))
  }
  return rows.filter((row) => Number(row.value) > 0)
}

function deadlineFor(
  approvalHook: Address,
  chainId: JBChainId,
): { deadline: CreateDraft['approvalDeadline']; custom: string } {
  if (approvalHook.toLowerCase() === ZERO_ADDRESS) {
    return { deadline: 'none', custom: '' }
  }
  const known = [
    ['3hours', 'JBDeadline3Hours'],
    ['1day', 'JBDeadline1Day'],
    ['3days', 'JBDeadline3Days'],
    ['7days', 'JBDeadline7Days'],
  ] as const
  for (const [deadline, contract] of known) {
    if (sameAddress(approvalHook, v6Address(contract, chainId))) {
      return { deadline, custom: '' }
    }
  }
  return { deadline: 'custom', custom: approvalHook }
}

async function readContext(
  client: PublicClient,
  chainId: JBChainId,
  projectId: bigint,
  rulesetId: bigint,
  context: LiveContext,
) {
  const terminal = v6Address('JBMultiTerminal', chainId)
  const limits = v6Address('JBFundAccessLimits', chainId)
  const splits = v6Address('JBSplits', chainId)
  const [payoutLimits, surplusAllowances, payoutSplits] = await Promise.all([
    client.readContract({
      address: limits,
      abi: jbFundAccessLimitsAbi,
      functionName: 'payoutLimitsOf',
      args: [projectId, rulesetId, terminal, context.token],
    }) as Promise<readonly CurrencyAmount[]>,
    client.readContract({
      address: limits,
      abi: jbFundAccessLimitsAbi,
      functionName: 'surplusAllowancesOf',
      args: [projectId, rulesetId, terminal, context.token],
    }) as Promise<readonly CurrencyAmount[]>,
    client.readContract({
      address: splits,
      abi: jbSplitsAbi,
      functionName: 'splitsOf',
      args: [projectId, rulesetId, payoutSplitGroupId(context.token)],
    }) as Promise<readonly RawSplit[]>,
  ])
  return { context, payoutLimits, surplusAllowances, payoutSplits }
}

/**
 * Reconstruct the current onchain ruleset into the native create-flow schema.
 * Any unavoidable gaps are returned as warnings for confirmation before save.
 */
/**
 * Is the any-token router-registry terminal in this project's terminal list?
 *
 * Chains without a registry deployment can't have one, and a directory read
 * that fails leaves the answer unknown — both report `false`, matching what a
 * redeploy could actually reproduce there.
 */
async function routerTerminalAttached(
  client: PublicClient,
  chainId: JBChainId,
  projectId: bigint,
): Promise<boolean> {
  let registry: string
  try {
    registry = v6Address('JBRouterTerminalRegistry', chainId)
  } catch {
    return false
  }
  const terminals = (await client
    .readContract({
      address: v6Address('JBDirectory', chainId),
      abi: jbDirectoryAbi,
      functionName: 'terminalsOf',
      args: [projectId],
    })
    .catch(() => [])) as readonly string[]
  return terminals.some((terminal) => sameAddress(terminal, registry))
}

export async function buildProjectDraftExport({
  client,
  chainId,
  projectId,
  isRevnet,
  profile,
  chains,
  authorityByChain,
}: {
  client: PublicClient
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
  profile: ExportProjectProfile
  chains: number[]
  authorityByChain: Record<number, string>
}): Promise<ProjectDraftExportResult> {
  const pid = BigInt(projectId)
  const current = await getCurrentRuleset(client, { chainId, projectId: pid })
  if (BigInt(current.ruleset.id) === 0n) {
    throw new Error('No live ruleset could be verified for this project.')
  }
  const contexts = await getAccountingContexts(client, { chainId, projectId: pid })
  if (!contexts.length) {
    throw new Error('No live accounting context could be verified for this project.')
  }

  const custom = contexts.filter(
    (context) =>
      !sameAddress(context.token, NATIVE_TOKEN) &&
      !sameAddress(context.token, USDC_ADDRESSES[chainId]),
  )
  if (custom.length > 1 || (custom.length && contexts.length > 1)) {
    throw new Error(
      'This project’s accounting-token combination cannot be represented by the create editor.',
    )
  }

  // Whether this project accepts ANY token via the router-registry terminal is
  // a real, observable property of the deployment — hardcoding `false` meant a
  // redeployed clone silently lost (or, read the other way, gained) the
  // any-token router the original chose.
  const allowAnyToken = await routerTerminalAttached(client, chainId, pid)

  const rulesetId = BigInt(current.ruleset.id)
  const [access, rawReserved, upcoming] = await Promise.all([
    Promise.all(
      contexts.map((context) =>
        readContext(client, chainId, pid, rulesetId, context),
      ),
    ),
    client.readContract({
      address: v6Address('JBSplits', chainId),
      abi: jbSplitsAbi,
      functionName: 'splitsOf',
      args: [pid, rulesetId, RESERVED_TOKEN_SPLIT_GROUP_ID],
    }) as Promise<readonly RawSplit[]>,
    getUpcomingRuleset(client, { chainId, projectId: pid }).catch(() => null),
  ])

  const warnings: string[] = []
  if (chains.length > 1) {
    warnings.push(
      `Rules, funds, and splits were reconstructed from ${chainId}. Review them and the bridge choice before redeploying across the other chains.`,
    )
  }
  if (
    current.metadata.dataHook.toLowerCase() !== ZERO_ADDRESS ||
    current.metadata.useDataHookForPay ||
    current.metadata.useDataHookForCashOut
  ) {
    warnings.push(
      'The deployment uses a data hook. The draft includes a fresh empty shop, but existing shop inventory and custom hook behavior are not copied.',
    )
  }
  // The export reconstructs the CURRENT ruleset only. A stored next
  // configuration — every stage after the first of a multi-stage revnet — has
  // no representation in the single-stage draft, so say so rather than let the
  // redeploy silently drop it. An auto-cycling project re-reports its own id
  // here; only a distinct stored configuration counts.
  if (
    upcoming &&
    BigInt(upcoming.ruleset.id) !== 0n &&
    BigInt(upcoming.ruleset.id) !== BigInt(current.ruleset.id)
  ) {
    warnings.push(
      `Only the live ${isRevnet ? 'stage' : 'ruleset'} was reconstructed. This project has another ${isRevnet ? 'stage' : 'ruleset'} queued after it, which the draft does not include.`,
    )
  }
  if (current.metadata.ownerMustSendPayouts) {
    warnings.push(
      'The live rules require owner-sent payouts; that low-level flag is not editable in the create flow.',
    )
  }
  if (Number(current.metadata.metadata || 0) !== 0) {
    warnings.push(
      'The live rules contain custom metadata bits which are not editable in the create flow.',
    )
  }

  // The ticker is read from the project's OWN ERC-20, never from bendystraw's project
  // row: that row's `tokenSymbol` is the ACCOUNTING symbol, so inheriting it re-launches
  // the clone with an ERC-20 tickered after what the original was paid IN ("ETH").
  const ticker = await readProjectTicker(client, chainId, projectId)
  if (!ticker) {
    warnings.push(
      'This deployment has no ERC-20 token yet, so the draft has no ticker. Pick one before redeploying.',
    )
  }

  const owner = authorityByChain[chainId] ?? ''
  if (!owner) {
    throw new Error(
      `The ${isRevnet ? 'operator' : 'owner'} could not be verified on this chain.`,
    )
  }

  const payoutConfigurations = access.map((item) => ({
    item,
    values: item.payoutLimits.filter((limit) => limit.amount > 0n),
  }))
  const allowanceConfigurations = access.map((item) => ({
    item,
    values: item.surplusAllowances.filter((allowance) => allowance.amount > 0n),
  }))
  for (const { item, values } of [
    ...payoutConfigurations,
    ...allowanceConfigurations,
  ]) {
    if (values.length > 1) {
      throw new Error(
        'A token uses multiple fund-access currencies, which the create editor cannot reproduce.',
      )
    }
    if (
      values[0] &&
      Number(values[0].currency) !== Number(item.context.currency)
    ) {
      throw new Error(
        'A fund-access limit uses a custom currency, which the create editor cannot reproduce.',
      )
    }
  }

  const configuredPayouts = payoutConfigurations.filter(
    ({ values }) => values.length,
  )
  if (configuredPayouts.length && configuredPayouts.length !== access.length) {
    throw new Error(
      'Only some accepted tokens have payout limits, which the create editor cannot reproduce.',
    )
  }
  const configuredAllowances = allowanceConfigurations.filter(
    ({ values }) => values.length,
  )
  if (
    configuredAllowances.length &&
    configuredAllowances.length !== access.length
  ) {
    throw new Error(
      'Only some accepted tokens have surplus allowances, which the create editor cannot reproduce.',
    )
  }
  if (configuredAllowances.length > 1) {
    const [first, ...rest] = configuredAllowances
    const firstValue = first.values[0]
    const allUnlimited = configuredAllowances.every(
      ({ values }) => values[0].amount >= UNLIMITED_FLOOR,
    )
    const allFinite = configuredAllowances.every(
      ({ values }) => values[0].amount < UNLIMITED_FLOOR,
    )
    const amountsMatch =
      allFinite &&
      rest.every(
        ({ item, values }) =>
          scaleDecimals(
            firstValue.amount,
            first.item.context.decimals,
            item.context.decimals,
          ) === values[0].amount,
      )
    if (!allUnlimited && !amountsMatch) {
      throw new Error(
        'The accepted tokens use different surplus allowances, which the create editor cannot reproduce.',
      )
    }
  }

  const stage: DraftStage = newDraftStage(true, isRevnet ? 'revnet' : 'project')
  const duration = Number(current.ruleset.duration)
  stage.durationValue = String(duration)
  stage.issuanceRate = formatUnits(current.ruleset.weight, 18)
  stage.cutOn = Number(current.ruleset.weightCutPercent) > 0
  stage.cutPct = percent(Number(current.ruleset.weightCutPercent) / 10_000_000)
  // A revnet encodes its issuance-cut cadence as the ruleset DURATION, and the
  // create flow reads it back from `cutFreqDays` (never `durationValue`). Left
  // at the new-stage default a 90-day-cut revnet would re-import — and relaunch
  // — with 30-day cuts, immutably.
  if (isRevnet && stage.cutOn) {
    if (duration >= 86_400 && duration % 86_400 === 0) {
      stage.cutFreqDays = String(duration / 86_400)
    } else {
      warnings.push(
        `The issuance cut runs every ${duration} seconds, which the create editor can only express in whole days. Set the cut frequency before redeploying.`,
      )
    }
  }
  stage.reservedPct = percent(Number(current.metadata.reservedPercent) / 100)
  stage.reservedSplits = reservedRows(
    rawReserved,
    Number(current.metadata.reservedPercent) / 100,
    owner,
  )
  stage.holdFees = current.metadata.holdFees
  // 9,999 is the revnet "off" encoding (10,000 reverts at deploy), so decoding `< 10_000` as
  // ON round-tripped an exported revnet back with cash outs ENABLED at 99.99%.
  stage.cashOuts = Number(current.metadata.cashOutTaxRate) < CASH_OUTS_OFF_REVNET
  stage.cashOutTax = Number(current.metadata.cashOutTaxRate)
  stage.taxCustomOn = ![0, 1000, 2500, 5000, 7500, CASH_OUTS_OFF_REVNET].includes(
    stage.cashOutTax,
  )
  stage.taxCustomPct = percent(stage.cashOutTax / 100)
  stage.ownerMinting = current.metadata.allowOwnerMinting
  stage.acceptPayments = !current.metadata.pausePay
  stage.pauseCreditTransfers = current.metadata.pauseCreditTransfers
  stage.pause721Transfers = decode721RulesetMetadata(
    Number(current.metadata.metadata ?? 0),
  ).pauseTransfers
  stage.metadataExtra = Number(current.metadata.metadata ?? 0)
  stage.powers = {
    setTerminals: current.metadata.allowSetTerminals,
    setController: current.metadata.allowSetController,
    terminalMigration: current.metadata.allowTerminalMigration,
    setCustomToken: current.metadata.allowSetCustomToken,
    addAccountingContext: current.metadata.allowAddAccountingContext,
    addPriceFeed: current.metadata.allowAddPriceFeed,
  }

  const hasPayoutLimits = access.some((item) =>
    item.payoutLimits.some((limit) => limit.amount > 0n),
  )
  const hasAllowances = access.some((item) =>
    item.surplusAllowances.some((allowance) => allowance.amount > 0n),
  )
  stage.payouts = hasPayoutLimits
    ? 'routed'
    : hasAllowances
      ? 'flexible'
      : 'none'

  for (const item of access) {
    const isUsdc = sameAddress(item.context.token, USDC_ADDRESSES[chainId])
    const firstLimit = item.payoutLimits.find((limit) => limit.amount > 0n)
    const isUnlimited = !!firstLimit && firstLimit.amount >= UNLIMITED_FLOOR
    const mode = isUnlimited ? 'all' : 'amounts'
    const rows = !firstLimit
      ? []
      : isUnlimited
        ? payoutPercentRows(item.payoutSplits)
        : payoutAmountRows(
            item.payoutSplits,
            firstLimit.amount,
            item.context.decimals,
            owner,
          )
    if (isUsdc) {
      stage.routedModeUsdc = mode
      stage.payoutSplitsUsdc = rows
    } else {
      stage.routedMode = mode
      stage.payoutSplits = rows
    }
  }

  const firstAllowance = access
    .flatMap((item) =>
      item.surplusAllowances
        .filter((allowance) => allowance.amount > 0n)
        .map((allowance) => ({ item, allowance })),
    )
    .at(0)
  if (firstAllowance) {
    stage.routedSurplusOn = hasPayoutLimits
    stage.surplusCapOn = firstAllowance.allowance.amount < UNLIMITED_FLOOR
    stage.surplusAmount = stage.surplusCapOn
      ? formatUnits(
          firstAllowance.allowance.amount,
          firstAllowance.item.context.decimals,
        )
      : ''
  }

  const accepts = contexts.flatMap((context) =>
    sameAddress(context.token, NATIVE_TOKEN)
      ? (['eth'] as const)
      : sameAddress(context.token, USDC_ADDRESSES[chainId])
        ? (['usdc'] as const)
        : [],
  )
  const deadline = deadlineFor(current.ruleset.approvalHook, chainId)
  const rawDraft = {
    v: 1,
    flavor: isRevnet ? 'revnet' : 'project',
    name: profile.name,
    ticker,
    tagline: profile.tagline,
    description: profile.description,
    payNotice: profile.payNotice ?? '',
    tags: [],
    links: {
      infoUri: profile.infoUri ?? '',
      twitter: profile.twitter ?? '',
      discord: profile.discord ?? '',
      telegram: profile.telegram ?? '',
      whatsapp: profile.whatsapp ?? '',
      instagram: profile.instagram ?? '',
    },
    owner,
    ownerPerChain: authorityByChain,
    allowAnyToken,
    approvalCustom: deadline.custom,
    approvalPerChain: {},
    accepts: accepts.length ? accepts : ['eth'],
    customAddress: custom[0]?.token ?? '',
    issuanceBase:
      Number(current.metadata.baseCurrency) === 2 ? 'usd' : 'eth',
    linkChains: chains.length > 1,
    bridge: 'ccip',
    chains,
    stages: [stage],
    afterMode: duration > 0 ? 'cycle' : 'wait',
    approvalDeadline: deadline.deadline,
    storeCurrency: custom.length
      ? 'token'
      : accepts.includes('eth')
        ? 'eth'
        : 'usd',
    storeConfig: {},
    storeCategories: [],
    items: [],
  }
  return { draft: parseDraft(JSON.stringify(rawDraft)), warnings }
}
