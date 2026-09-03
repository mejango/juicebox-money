import {
  JBUniswapV4LPSplitHookContracts,
  MappableAsset,
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  jb721TiersHookProjectDeployerAbi,
  jbContractAddress,
  jbOmnichainDeployerAbi,
  parseSuckerDeployerConfig,
  type JBChainId,
  type JBSuckerBridge,
} from '@bananapus/nana-sdk-core'
import {
  BASE_CURRENCY_ETH,
  BASE_CURRENCY_USD,
  buildAccountingContext,
  build721RulesetMetadata,
  buildDeployRevnetTx,
  buildRevnetStageConfig,
  buildRulesetConfiguration,
  buildRulesetMetadata,
  buildTerminalConfigurations,
  projectIdFromLaunchLogs,
  requiredFeedPairs as sdkRequiredFeedPairs,
  TIER_UNLIMITED_SUPPLY,
  tokenCurrencyId,
  v6Address,
  type JBAccountingContext,
  type JBFeedPair,
} from '@bananapus/nana-sdk-core/v6'
import { zeroAddress, type Address, type TransactionReceipt } from 'viem'
import { chainName } from '@/lib/urn'

/** 10,000 tokens per ETH/USD paid (18-decimal fixed point). */
const DEFAULT_WEIGHT = 10n ** 22n

/**
 * cashOutTaxRate sentinel: 100% tax = cash outs disabled. Standard projects only.
 *
 * A REVNET cannot use this value — `REVDeployer` reverts with
 * `REVDeployer_CashOutsCantBeTurnedOffCompletely` on anything >= MAX_CASH_OUT_TAX_RATE — so
 * the revnet path encodes {@link CASH_OUTS_OFF_REVNET} instead. Both live here because
 * having a third copy in CreateForm is how the export came to decode 9,999 as "on at 99.99%".
 */
export const CASH_OUTS_OFF = 10_000

/** The closest a revnet can get to disabling cash outs, since 10,000 reverts at deploy. */
export const CASH_OUTS_OFF_REVNET = 9_999

/** JBFundAccessLimitGroup "unlimited" payout amount sentinel. */
const UNLIMITED_PAYOUT = 2n ** 224n - 1n

/**
 * Whether a stage routes EVERY accepted token's funds out entirely, leaving no
 * surplus anywhere — the one payout configuration where cash outs are formally
 * disabled.
 *
 * A token whose routed payouts have no limit ("route all funds by percentage")
 * retains no surplus, but a project accepting ETH and USDC can route one and
 * cap the other: the capped token keeps a surplus, so cash outs stay ON. Only
 * an every-token sweep turns them off.
 *
 * ONE predicate for the whole flow — the encoder below, the create-flow plan
 * builder, and the stage editor's summary all call this, so what the review
 * screen says and what the immutable ruleset encodes cannot disagree.
 */
export function routesAllFunds(
  payouts: StageRules['payouts'],
  /** Per accepted token: does that token route everything (no payout limit)? */
  perTokenRoutesEverything: readonly boolean[],
): boolean {
  return (
    payouts === 'routed' &&
    perTokenRoutesEverything.length > 0 &&
    perTokenRoutesEverything.every(Boolean)
  )
}

/**
 * `REVDeployer.deploySuckersFor` reads bit 2 of the CURRENT stage's app
 * metadata and reverts without it (REVDeployer.sol:646-650). Stages are
 * immutable, so a stage that ships without this bit can never be extended to
 * another chain — launch-time suckers are exempt, which is why the gap only
 * surfaces later.
 */
const REV_METADATA_ALLOW_SUCKER_DEPLOYMENT = 1 << 2

export type TreasuryCurrency = 'eth' | 'usdc'

/** One store item, already pinned: encodedIpfsUri is the bytes32 digest of
 *  the item's CIDv0 metadata. Price is in the store
 *  currency's base units (18-dec for ETH prices, 6-dec for USD prices). */
export type StoreItem = {
  price: bigint
  /** null = unlimited inventory. */
  supply: number | null
  encodedIpfsUri: `0x${string}`
  /** Share of each sale routed to `splits`, out of 1e9. 0 = none. */
  splitPercent: number
  /** Relative shares of the split bucket (sum to 1e9). */
  splits: SplitConfig[]
  /** Initial discount out of 200 (0.5% steps — uint8 cap). */
  discountPercent: number
  /** Reserve 1 of every N mints for the beneficiary. 0 = off. */
  reserveFrequency: number
  reserveBeneficiary: Address | null
  /** Tier category (0 = default). Tiers sort by category at encode. */
  category: number
  /** Custom voting power per item (0 = none). */
  votingUnits: number
  flags: {
    allowOwnerMint: boolean
    transfersPausable: boolean
    cantBeRemoved: boolean
    /** Inverted encodings: credits allowed / owner can edit discounts. */
    allowCredits: boolean
    ownerCanEditDiscount: boolean
  }
  /** Per-chain supply overrides (null value = unlimited on that chain). */
  perChainSupply: Record<number, number | null>
  /**
   * Per-chain split recipients, when the editor's per-chain overrides are used.
   *
   * The item metadata is pinned ONCE for every chain, but a split row may name a different
   * recipient (or project id) on each — so the recipients cannot be baked in alongside the
   * pin. Absent for callers that already resolved `splits` for the chain they are building
   * (the live Shop editor does exactly that), which is why the lookup falls back to `splits`.
   */
  perChainSplits?: Record<number, SplitConfig[]>
}

/**
 * The Uniswap V4 LP split hook ("Fund market"), from the SDK's generated
 * deployment table — the same address on every chain that has one, but NOT every
 * chain has one, which is the whole reason the lookup below exists: a reserved
 * split whose `hook` has no code makes split processing revert, so the option has
 * to be withheld per chain. Optimism Sepolia (11155420) is absent from the table
 * because deploy-all has no `JBUniswapV4LPSplitHook.json` there.
 */
const LP_SPLIT_HOOK_ADDRESSES = jbContractAddress['6'][
  JBUniswapV4LPSplitHookContracts.JBUniswapV4LPSplitHook
] as Partial<Record<JBChainId, Address>>

export const LP_SPLIT_HOOK = LP_SPLIT_HOOK_ADDRESSES[1] as Address

/**
 * Superseded LP-split-hook generations, newest first. Splits written by earlier releases
 * still point at these; the editor must RECOGNIZE them so the row reads as a market split
 * instead of an opaque custom hook, but it must never encode one into a new split.
 */
export const LEGACY_LP_SPLIT_HOOKS: readonly Address[] = [
  // generation 2 — `JBUniswapV4LPSplitHook_deprecated2`
  '0xaf2d8a027955871cd2f3c4d2f32338e574e69bc0',
  // generation 1 — `JBUniswapV4LPSplitHook_deprecated`
  '0x2f23b09975eb9305670b01e94c11e702792f25a3',
] as Address[]

/** The market-split hook to encode on `chainId`, or null when it has no deployment. */
export function lpSplitHookOn(chainId: number): Address | null {
  return LP_SPLIT_HOOK_ADDRESSES[chainId as JBChainId] ?? null
}

/** Which generation `hook` belongs to, or null when it is an unrelated contract. */
export function lpSplitHookGeneration(
  hook: string,
): 'current' | 'legacy' | null {
  const address = hook.toLowerCase()
  if (address === LP_SPLIT_HOOK.toLowerCase()) return 'current'
  return LEGACY_LP_SPLIT_HOOKS.some(h => h.toLowerCase() === address)
    ? 'legacy'
    : null
}

/** The selected chains that cannot carry a market split. */
export function chainsWithoutLpSplitHook(
  chainIds: readonly number[],
): number[] {
  return chainIds.filter(id => !lpSplitHookOn(id))
}

/**
 * The market-split hook for `chainId`, throwing rather than encoding a codeless address.
 * The UI blocks this combination up front; this is the encoder's fail-closed backstop.
 */
export function requireLpSplitHook(chainId: number): Address {
  const hook = lpSplitHookOn(chainId)
  if (!hook) {
    throw new Error(
      `${chainName(chainId)} has no market split hook deployed — remove the "Fund market" recipient or deselect that chain.`,
    )
  }
  return hook
}

/** One split recipient: an address, a project (its tokens go to
 *  `beneficiary`), or a split hook. Percent is out of 1e9. */
export type SplitConfig = {
  percent: number
  projectId: bigint
  beneficiary: Address
  /** Project payouts only: add to balance instead of paying (no tokens). */
  preferAddToBalance: boolean
  /** Unix seconds this split can't be changed before. 0 = unlocked. */
  lockedUntil: number
  /** A split hook contract, or address(0). */
  hook: Address
}

/** Duration sentinel for a final stage that lasts forever (uint32 max). */
export const FOREVER_SECONDS = 4_294_967_295

/** The approval condition queued ruleset edits must clear (shared across
 *  every stage, matching website/). 'none' = no condition (address(0)). */
export type ApprovalDeadline =
  | 'none'
  | '3hours'
  | '1day'
  | '3days'
  | '7days'
  | 'custom'

/** Seconds each deadline hook demands between queueing and start. A stage
 *  queued at launch that starts sooner than this is REJECTED by the hook
 *  (JBDeadline.approvalStatusOf → Failed) and silently never takes effect. */
export const DEADLINE_SECONDS: Record<
  Exclude<ApprovalDeadline, 'none' | 'custom'>,
  number
> = {
  '3hours': 3 * 3600,
  '1day': 86_400,
  '3days': 3 * 86_400,
  '7days': 7 * 86_400,
}

/** JBRulesets.deriveStartFrom: the start a ruleset queued on `base` gets —
 *  the first cycle boundary of the base at or after `mustStartAtOrAfter`. */
export function deriveStartFrom(
  baseStart: number,
  baseDuration: number,
  mustStartAtOrAfter: number,
): number {
  if (baseDuration === 0) return mustStartAtOrAfter
  const nextImmediate = baseStart + baseDuration
  if (nextImmediate >= mustStartAtOrAfter) return nextImmediate
  let start =
    mustStartAtOrAfter - ((mustStartAtOrAfter - nextImmediate) % baseDuration)
  while (mustStartAtOrAfter > start) start += baseDuration
  return start
}

/** Seconds a deployed JBDeadline hook demands, by its address on `chainId`; 0 for no hook or a custom one. */
export function deadlineSecondsForHook(hook: Address | undefined, chainId: number): number {
  if (!hook || hook === zeroAddress) return 0
  for (const key of Object.keys(DEADLINE_SECONDS) as (keyof typeof DEADLINE_SECONDS)[]) {
    const addr = v6Address(DEADLINE_CONTRACT[key], chainId as JBChainId)
    if (addr && addr.toLowerCase() === hook.toLowerCase()) return DEADLINE_SECONDS[key]
  }
  return 0
}

const DEADLINE_CONTRACT: Record<
  Exclude<ApprovalDeadline, 'none' | 'custom'>,
  'JBDeadline3Hours' | 'JBDeadline1Day' | 'JBDeadline3Days' | 'JBDeadline7Days'
> = {
  '3hours': 'JBDeadline3Hours',
  '1day': 'JBDeadline1Day',
  '3days': 'JBDeadline3Days',
  '7days': 'JBDeadline7Days',
}

/** One stage = one queued JBRulesetConfig. */
export type StageRules = {
  /** Seconds. 0 = flexible/open-ended (last stage only — a 0-duration
   *  non-final stage never advances). FOREVER_SECONDS = lasts forever. */
  duration: number
  /** Unix seconds the stage must start at or after; 0 = deploy block, which
   *  on a later stage snaps to the previous stage's next cycle boundary
   *  (JBRulesets.deriveStartFrom). An absolute value lets a later stage wait
   *  N cycles or a date; the contract still snaps it UP to a boundary. */
  mustStartAtOrAfter: number
  /** Tokens issued per ETH/USD paid — 18-dec FP. On stage 2+, the raw sentinel `1n` means
   *  inherit the previous stage's (cut) rate — "A weight of 1 is a special case that
   *  represents inheriting the cut weight of the previous ruleset" (JBRulesets.sol:822-823).
   *  `0n` is GENUINE ZERO ISSUANCE, permanently, and revnet stages are immutable. */
  weight: bigint
  /** Issuance cut applied each cycle, out of 1e9. */
  weightCutPercent: number
  /** Share of newly issued tokens kept back from payers, out of 10000. */
  reservedPercent: number
  /** Where reserved tokens go. Any unallocated remainder → the owner. */
  reservedSplits: SplitConfig[]
  /** 'none': funds only leave via cash outs (if enabled).
   *  'flexible': unlimited surplus allowance — the owner can withdraw any
   *  amount from surplus, anytime; cash outs share the same surplus.
   *  'routed': payout limit + splits — anyone can trigger payouts that
   *  route funds to the recipients. */
  payouts: 'none' | 'flexible' | 'routed'
  /** Recipients for 'routed' payouts. Unallocated remainder → the owner. */
  payoutSplits: SplitConfig[]
  /** For 'routed': null routes ALL funds by percentage (unlimited payout
   *  limit ⇒ no surplus, cash outs off). A fixed amount (in the accounting
   *  token's units) caps total payouts — the rest stays as surplus. */
  payoutLimitAmount: bigint | null
  /** Multi-token (ETH+USDC) routed payouts: USDC gets its own splits and
   *  limit; the primary fields cover ETH (or the single token). */
  payoutSplitsUsdc: SplitConfig[]
  payoutLimitAmountUsdc: bigint | null
  /** Owner surplus access: on for 'flexible'; optional alongside
   *  fixed-amount routed payouts. */
  surplusAllowanceOn: boolean
  /** Cap on owner surplus withdrawals, parsed at the primary accounting
   *  token's decimals. Applied to EACH accounting context as that amount in
   *  the context's own currency (re-denominated at encode). null =
   *  unlimited. */
  surplusAllowanceAmount: bigint | null
  /** Hold payout/allowance fees in the project instead of processing them,
   *  so they can be unlocked if the funds come back. */
  holdFees: boolean
  /** Cash-out tax out of 10000, or null = cash outs disabled. */
  cashOutTaxRate: number | null
  allowOwnerMinting: boolean
  /** Pause payments (and with them, token issuance) for this stage. */
  pausePay: boolean
  /** Freeze internal credit transfers (claimed ERC-20s stay transferable). */
  pauseCreditTransfers: boolean
  /** Pause transfers of 721 tiers which opted into ruleset-controlled pauses. */
  pause721Transfers: boolean
  /** App-specific uint14 metadata; unrelated integration bits are preserved. */
  metadataExtra: number
  /** Owner superpowers — all default off; supporters can see them. */
  allowSetTerminals: boolean
  allowSetController: boolean
  allowTerminalMigration: boolean
  allowSetCustomToken: boolean
  allowAddAccountingContext: boolean
  allowAddPriceFeed: boolean
  /** Revnet only: seconds between issuance cuts (0 = no cuts). */
  issuanceCutFrequency: number
  /** Revnet only: tokens minted to beneficiaries when the stage starts.
   *  Each entry mints ONCE per launch, on its chosen chain (unset/unselected
   *  falls back to the first selected chain). EVERY chain's config encodes
   *  the FULL list byte-identically — REVDeployer folds all rows into the
   *  cross-chain configuration hash and mints only rows whose chainId
   *  matches the local chain. */
  autoIssuances: { count: bigint; beneficiary: Address; chainId?: number | null }[]
}

/** What the treasury holds: standard tokens (ETH and/or USDC), or one
 *  custom ERC-20 (exclusive — priced in itself, no feeds needed). */
export type AccountingConfig = {
  tokens: TreasuryCurrency[]
  custom: { address: Address; decimals: number } | null
}

export type LaunchPlan = {
  accounting: AccountingConfig
  /** Issuance denomination when accounting is standard tokens: null =
   *  follow accounting (ETH when present, else USD). Custom-token
   *  accounting always prices in the token itself. */
  issuanceBase: 'eth' | 'usd' | null
  /** 'project' launches via the 721 project deployer with owner-changeable
   *  rules; 'revnet' deploys fixed-forever stages via REVDeployer. */
  flavor: 'project' | 'revnet'
  /** The project name. Revnets also use it as the ERC-20 name — REVDeployer
   *  folds it into the cross-chain config hash and the token's deploy salt.
   *  The 721 collection name is `store.name`. */
  projectName: string
  /** Revnet only: the operator address and the token ticker. */
  operator: Address | null
  ticker: string
  /** The queued stages, in order. At least one. */
  stages: StageRules[]
  /** What happens after the last timed stage (website/'s "Afterwards"):
   *  'wait' appends a standby stage (payments paused, no issuance),
   *  'terminal' appends a forever clone of the last stage,
   *  'cycle' lets the last ruleset repeat as-is. Ignored when the last
   *  stage is open-ended (duration 0) or forever. */
  afterMode: 'wait' | 'terminal' | 'cycle'
  approvalDeadline: ApprovalDeadline
  /** Resolved custom approval-hook address for THIS chain ('custom'). */
  approvalCustomAddress: Address | null
  /** Include the any-token swap-router terminal (project flavor). */
  allowAnyToken: boolean
  /** Owner (project) for this chain; null = connected wallet at send. */
  owner: Address | null
  /** Every chain this launch targets (sucker config needs the full set). */
  chains: number[]
  /** Link the chains with suckers so tokens/treasury bridge. */
  linkChains: boolean
  /** Bridge infrastructure for the suckers: 'ccip' connects any pair and
   *  carries any mapped asset; 'native' is Ethereum↔L2 rollup bridges (ETH
   *  only — the SDK throws on other pairs/assets); 'both' deploys one of
   *  each per pair, falling back to CCIP alone where native can't serve. */
  bridge: JBSuckerBridge
  /** The 721 store collection. Always deployed — even with zero items — so
   *  every project can stock its store later without a ruleset change. */
  store: {
    name: string
    symbol: string
    /** Tier pricing currency — 'token' = the custom accounting token. */
    currency: 'eth' | 'usd' | 'token'
    /** Collection flags (website/'s store config). */
    preventOverspending: boolean
    noNewTiersWithReserves: boolean
    noNewTiersWithVotes: boolean
    noNewTiersWithOwnerMinting: boolean
    issueTokensForSplits: boolean
    /** Let items cash out for surplus (mutually exclusive with token cash
     *  outs — the UI enforces it). */
    itemsRedeem: boolean
    /** Revnet only: what the operator may do to the store after launch. */
    operatorCanAdjustTiers: boolean
    operatorCanUpdateMetadata: boolean
    operatorCanMint: boolean
    operatorCanIncreaseDiscount: boolean
    items: StoreItem[]
  }
}

const DEFAULT_STAGE: StageRules = {
  duration: 0,
  mustStartAtOrAfter: 0,
  weight: DEFAULT_WEIGHT,
  weightCutPercent: 0,
  reservedPercent: 0,
  reservedSplits: [],
  payouts: 'none',
  payoutSplits: [],
  payoutLimitAmount: null,
  payoutSplitsUsdc: [],
  payoutLimitAmountUsdc: null,
  surplusAllowanceOn: false,
  surplusAllowanceAmount: null,
  holdFees: false,
  cashOutTaxRate: null,
  allowOwnerMinting: false,
  pausePay: false,
  pauseCreditTransfers: false,
  pause721Transfers: false,
  metadataExtra: 0,
  autoIssuances: [],
  allowSetTerminals: false,
  allowSetController: false,
  allowTerminalMigration: false,
  allowSetCustomToken: false,
  allowAddAccountingContext: false,
  allowAddPriceFeed: false,
  issuanceCutFrequency: 0,
}

/**
 * Rules used by the create flow's "Simple project" flavor. The first
 * ruleset stays open-ended and leaves every owner-managed project control
 * available, so the owner can launch now and express durable preferences in
 * a later ruleset.
 */
export function createSimpleProjectStage(): StageRules {
  return {
    ...DEFAULT_STAGE,
    payouts: 'flexible',
    surplusAllowanceOn: true,
    allowOwnerMinting: true,
    allowSetTerminals: true,
    allowSetController: true,
    allowTerminalMigration: true,
    allowSetCustomToken: true,
    allowAddAccountingContext: true,
    allowAddPriceFeed: true,
  }
}

export const DEFAULT_STORE_FLAGS = {
  preventOverspending: false,
  noNewTiersWithReserves: false,
  noNewTiersWithVotes: false,
  noNewTiersWithOwnerMinting: false,
  issueTokensForSplits: false,
  itemsRedeem: false,
  operatorCanAdjustTiers: true,
  operatorCanUpdateMetadata: true,
  operatorCanMint: true,
  operatorCanIncreaseDiscount: true,
}

/**
 * Expand the "Afterwards" choice into the final queued stage, exactly like
 * website/'s resolveStages: only applies when the last stage is timed.
 */
export function resolveStages(plan: LaunchPlan): StageRules[] {
  const last = plan.stages[plan.stages.length - 1]
  const lastTimed = last.duration > 0 && last.duration !== FOREVER_SECONDS
  if (!lastTimed || plan.afterMode === 'cycle') return plan.stages
  if (plan.afterMode === 'terminal') {
    return [...plan.stages, { ...last, duration: FOREVER_SECONDS }]
  }
  // 'wait': standby — payments (and issuance) pause, cash outs preserved.
  return [
    ...plan.stages,
    {
      ...DEFAULT_STAGE,
      weight: 0n,
      pausePay: true,
      cashOutTaxRate: last.cashOutTaxRate,
    },
  ]
}

/**
 * Relative shares of a split bucket, summing to EXACTLY 1e9.
 *
 * The last row absorbs the rounding remainder, which is what makes the total exact —
 * `JBSplits` reverts on a group over 1e9. This lived in three places with two different
 * rounding modes (floor vs round) and a `<= 0` guard in only one of them, so the copies
 * without it could emit a zero-or-negative final split, which also reverts.
 */
export function splitShares(values: readonly number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (!(total > 0)) return values.map(() => 0)

  const shares = values.map(value => Math.floor((value / total) * 1e9))
  const assigned = shares.slice(0, -1).reduce((sum, share) => sum + share, 0)
  shares[shares.length - 1] = 1e9 - assigned
  // ANY zero share is unencodable, not just the last: flooring sends a sufficiently tiny row
  // to 0 while the last row still absorbs a positive remainder. A 0% split reverts on-chain,
  // so surface it here where the percentages can still be edited.
  if (shares.some(share => share <= 0)) {
    throw new Error(
      'These split percentages cannot be represented — one share is too small to encode.',
    )
  }
  return shares
}

/** Reserved-token splits live in group 1; payout splits in group
 *  uint256(token). Split percents are out of 1e9. */
const RESERVED_SPLIT_GROUP = 1n

function toJbSplits(splits: SplitConfig[]) {
  return splits.map(split => ({
    percent: split.percent,
    projectId: split.projectId,
    beneficiary: split.beneficiary,
    preferAddToBalance: split.preferAddToBalance,
    lockedUntil: split.lockedUntil,
    hook: split.hook,
  }))
}

function treasuryToken(
  currency: TreasuryCurrency,
  chainId: JBChainId,
): Address {
  return currency === 'usdc' ? USDC_ADDRESSES[chainId] : NATIVE_TOKEN
}

/**
 * The accounting contexts and ruleset base currency a plan encodes on
 * `chainId`. ONE derivation, shared by {@link buildLaunchRequest} (which
 * encodes them) and {@link requiredFeedPairs} (which proves the price feeds
 * they imply exist) — a second copy is how the guard could drift from the
 * launch it guards.
 *
 * Custom tokens are exclusive and price everything in themselves (their
 * token-keyed currency id); otherwise ETH and/or USDC contexts, with the base
 * currency following ETH when present.
 */
function launchAccounting(
  accounting: AccountingConfig,
  issuanceBase: LaunchPlan['issuanceBase'],
  chainId: JBChainId,
): { contexts: JBAccountingContext[]; baseCurrency: number } {
  const contexts = accounting.custom
    ? [
        buildAccountingContext(
          accounting.custom.address,
          accounting.custom.decimals,
        ),
      ]
    : accounting.tokens.map(t =>
        buildAccountingContext(treasuryToken(t, chainId), t === 'usdc' ? 6 : 18),
      )
  const baseCurrency = accounting.custom
    ? tokenCurrencyId(accounting.custom.address)
    : (issuanceBase ?? (accounting.tokens.includes('eth') ? 'eth' : 'usd')) ===
        'eth'
      ? BASE_CURRENCY_ETH
      : BASE_CURRENCY_USD
  return { contexts, baseCurrency }
}

/** One JBPrices pair a launched project's terminal will read at runtime,
 *  carrying the human denomination names the launch-guard copy needs.
 *  Order is irrelevant — JBPrices resolves direct and inverse feeds. */
export type FeedPair = JBFeedPair & {
  aLabel: string
  bLabel: string
}

/**
 * Every JBPrices pair the launched project's terminal must be able to resolve
 * (SDK `requiredFeedPairs`, fed the exact contexts and base currency
 * {@link buildLaunchRequest} encodes), labelled for the block copy.
 *
 * Custom-token plans yield nothing: their single context's currency IS the base
 * currency, and the terminal short-circuits equal currencies.
 */
export function requiredFeedPairs(
  accounting: AccountingConfig,
  issuanceBase: LaunchPlan['issuanceBase'],
  chainId: JBChainId,
): FeedPair[] {
  const { contexts, baseCurrency } = launchAccounting(
    accounting,
    issuanceBase,
    chainId,
  )
  const labels = new Map<number, string>([
    [BASE_CURRENCY_ETH, 'ETH'],
    [BASE_CURRENCY_USD, 'USD'],
    [tokenCurrencyId(NATIVE_TOKEN), 'ETH'],
    [tokenCurrencyId(USDC_ADDRESSES[chainId]), 'USDC'],
  ])
  const label = (currency: number) =>
    labels.get(currency) ?? `currency ${currency}`
  return sdkRequiredFeedPairs(contexts, baseCurrency).map(pair => ({
    ...pair,
    aLabel: label(pair.pricingCurrency),
    bLabel: label(pair.unitCurrency),
  }))
}

/** The ONE chain an auto-issuance row mints on: the row's stored choice
 *  while it's still a selected chain, else the first selected chain. Must
 *  be config-chain independent — every chain encodes the SAME row list and
 *  REVDeployer mints only rows whose chainId matches the local chain. */
export function autoIssuanceMintChain(
  chains: number[],
  chainId?: number | null,
): number {
  return chainId != null && chains.includes(chainId) ? chainId : chains[0]
}

/** The decimals stage amounts are parsed with in the create form (its
 *  primary accounting token): the custom token's, else 18 when ETH is
 *  accepted, else USDC's 6. */
function planAmountDecimals(accounting: AccountingConfig): number {
  if (accounting.custom) return accounting.custom.decimals
  return accounting.tokens.includes('eth') ? 18 : 6
}

/** Re-denominate a fixed-point amount from `from` decimals to `to` decimals
 *  (flooring when precision shrinks). */
function scaleDecimals(amount: bigint, from: number, to: number): bigint {
  if (to === from) return amount
  return to > from
    ? amount * 10n ** BigInt(to - from)
    : amount / 10n ** BigInt(from - to)
}

/**
 * Assemble the launch request for one chain. Pure — no wallet, no network —
 * so it's directly testable via `simulateContract`.
 *
 * Every launch goes through `JB721TiersHookProjectDeployer.launchProjectFor`
 * (even with zero store items) so the store hook exists from day 1. The
 * deployer injects the hook as the ruleset's pay data hook itself — its
 * ruleset tuple omits dataHook/useDataHookForPay, and viem drops those extra
 * metadata keys by name.
 *
 * Multi-chain launches are independent per-chain transactions. When
 * `plan.linkChains` is set and more than one chain is selected, the omnichain
 * branch below ALSO configures suckers (`suckerConfigFor`) — the plan is the
 * same on every chain, so the rulesets come out byte-identical either way.
 */
export function buildLaunchRequest(args: {
  chainId: JBChainId
  /** The sending wallet. Only used for sessions pinned before `plan.owner`
   *  became concrete — see `owner` below. */
  owner: Address
  projectUri: string
  creationFee: bigint
  plan: LaunchPlan
  /** Unique per launch run (the hook's create2 salt). */
  salt: `0x${string}`
}) {
  const { chainId, plan } = args
  const { accounting } = plan
  // The plan is the authority: its owner was frozen when the run was pinned.
  // A multichain launch is sucker-linked, so resolving "the connected wallet"
  // per chain at SEND time would hand a run resumed from a different wallet
  // split-brain ownership across the group. `args.owner` is the fallback for
  // sessions persisted before the freeze, which recorded no owner at all.
  const owner = plan.owner ?? args.owner
  const { contexts, baseCurrency } = launchAccounting(
    accounting,
    plan.issuanceBase,
    chainId,
  )

  if (plan.flavor === 'revnet') {
    // Fixed-forever stages via REVDeployer (website/ parity). Stage starts
    // are ABSOLUTE and strictly increasing — the caller bakes them into
    // mustStartAtOrAfter. Reserved% / reservedSplits map to the stage's
    // splitPercent / splits; the split bucket must total exactly 1e9, so
    // any unallocated remainder goes to the operator.
    const operator = plan.operator ?? owner
    const stageConfigurations = plan.stages.map(stage => {
      const splits = [...toJbSplits(stage.reservedSplits)]
      const allocated = splits.reduce((sum, split) => sum + split.percent, 0)
      if (stage.reservedPercent > 0 && allocated < 1_000_000_000) {
        splits.push({
          percent: 1_000_000_000 - allocated,
          projectId: 0n,
          beneficiary: operator,
          preferAddToBalance: false,
          lockedUntil: 0,
          hook: zeroAddress,
        })
      }
      return buildRevnetStageConfig({
        startsAtOrAfter: stage.mustStartAtOrAfter,
        // The SAME full row list on every chain, each row pinned to ITS
        // mint chain — REVDeployer hashes all rows into the cross-chain
        // configuration and mints only rows matching the local chain, so
        // the encoding must be independent of the config chain.
        autoIssuances: stage.autoIssuances.map(a => ({
          chainId: autoIssuanceMintChain(plan.chains, a.chainId),
          count: a.count,
          beneficiary: a.beneficiary,
        })),
        // The raw sentinel 1n on later stages = inherit the previous (cut) rate
        // (JBRulesets.sol:822-823); 0n is genuine, permanent zero issuance. REVDeployer
        // passes this weight straight through, and revnet stages are immutable — a caller
        // that follows the old comment ships zero-issuance stages that can never be fixed.
        initialIssuance: stage.weight,
        splitPercent: stage.reservedPercent,
        splits: stage.reservedPercent > 0 ? splits : [],
        issuanceCutFrequency: stage.issuanceCutFrequency,
        issuanceCutPercent: stage.weightCutPercent,
        cashOutTaxRate: stage.cashOutTaxRate ?? 0,
        extraMetadata:
          build721RulesetMetadata({
            metadata: stage.metadataExtra,
            // A revnet cannot change this in a later stage. Keep the global
            // gate closed forever and let each tier's immutable flag choose
            // transferable (false) or non-transferable (true).
            pauseTransfers: true,
          }) | REV_METADATA_ALLOW_SUCKER_DEPLOYMENT,
      })
    })

    return buildDeployRevnetTx({
      chainId,
      config: {
        description: {
          name: plan.projectName,
          ticker: plan.ticker,
          uri: args.projectUri,
          salt: args.salt,
        },
        baseCurrency,
        operator,
        scopeCashOutsToLocalBalances: false,
        stageConfigurations,
      },
      accountingContexts: contexts,
      suckerConfig: suckerConfigFor(plan, chainId, args.salt),
      creationFee: args.creationFee,
      tiered721Config:
        plan.store.items.length > 0
          ? {
              baseline721HookConfiguration: build721HookConfig(
                plan.store,
                args.projectUri,
                accounting,
                chainId,
              ),
              salt: args.salt,
              preventOperatorAdjustingTiers: !plan.store.operatorCanAdjustTiers,
              preventOperatorUpdatingMetadata:
                !plan.store.operatorCanUpdateMetadata,
              preventOperatorMinting: !plan.store.operatorCanMint,
              preventOperatorIncreasingDiscountPercent:
                !plan.store.operatorCanIncreaseDiscount,
            }
          : undefined,
    })
  }

  const stages = resolveStages(plan)

  // The approval condition is shared across stages. It's meaningless when
  // the last stage lasts forever — force address(0) then (website/ parity).
  const lastForever =
    stages[stages.length - 1].duration === FOREVER_SECONDS
  const approvalHook =
    plan.approvalDeadline === 'none' || lastForever
      ? zeroAddress
      : plan.approvalDeadline === 'custom'
        ? (plan.approvalCustomAddress ?? zeroAddress)
        : v6Address(DEADLINE_CONTRACT[plan.approvalDeadline], chainId)

  const rulesetConfigurations = stages.map((stage) =>
    buildRulesetConfiguration({
      // 0 on a later stage = the previous stage's next cycle boundary; an
      // absolute value waits N cycles or a date (the contract snaps it up).
      mustStartAtOrAfter: stage.mustStartAtOrAfter,
      duration: stage.duration,
      weight: stage.weight,
      weightCutPercent: stage.weightCutPercent,
      approvalHook,
      metadata: buildRulesetMetadata({
        baseCurrency,
        reservedPercent: stage.reservedPercent,
        // Routing EVERY accepted token's funds (unlimited payout limit on each)
        // leaves no surplus for cash outs — keep them formally disabled in that
        // mode. One token capped at fixed amounts, or flexible (surplus
        // allowance), leaves surplus intact.
        cashOutTaxRate: routesAllFunds(
          stage.payouts,
          contexts.map(
            ctx => payoutLimitFor(plan, stage, ctx.token, chainId) === null,
          ),
        )
          ? CASH_OUTS_OFF
          : (stage.cashOutTaxRate ?? CASH_OUTS_OFF),
        allowOwnerMinting: stage.allowOwnerMinting,
        holdFees: stage.holdFees,
        pausePay: stage.pausePay,
        pauseCreditTransfers: stage.pauseCreditTransfers,
        metadata: build721RulesetMetadata({
          metadata: stage.metadataExtra,
          pauseTransfers: stage.pause721Transfers,
        }),
        allowSetTerminals: stage.allowSetTerminals,
        allowSetController: stage.allowSetController,
        allowTerminalMigration: stage.allowTerminalMigration,
        allowSetCustomToken: stage.allowSetCustomToken,
        allowAddAccountingContext: stage.allowAddAccountingContext,
        // Custom-token projects price in the token itself; adding a feed
        // later is how the owner unlocks ETH/USD pricing — keep it allowed.
        allowAddPriceFeed: stage.allowAddPriceFeed || accounting.custom !== null,
        useDataHookForCashOut: plan.store.itemsRedeem,
      }),
      splitGroups: [
        ...(stage.reservedPercent > 0 && stage.reservedSplits.length > 0
          ? [
              {
                groupId: RESERVED_SPLIT_GROUP,
                splits: toJbSplits(stage.reservedSplits),
              },
            ]
          : []),
        ...(stage.payouts === 'routed'
          ? contexts.flatMap(ctx => {
              const splits = payoutSplitsFor(plan, stage, ctx.token, chainId)
              return splits.length > 0
                ? [{ groupId: BigInt(ctx.token), splits: toJbSplits(splits) }]
                : []
            })
          : []),
      ],
      // One fund-access group per accounting context (website/ parity).
      fundAccessLimitGroups:
        stage.payouts === 'none'
          ? []
          : contexts.map(ctx => ({
              terminal: v6Address('JBMultiTerminal', chainId),
              token: ctx.token,
              payoutLimits:
                stage.payouts === 'routed'
                  ? [
                      {
                        amount:
                          payoutLimitFor(plan, stage, ctx.token, chainId) ??
                          UNLIMITED_PAYOUT,
                        currency: ctx.currency,
                      },
                    ]
                  : [],
              // The single allowance amount means "this much in each
              // context's own currency" — re-denominate it from the form's
              // parse decimals into the context's.
              surplusAllowances: stage.surplusAllowanceOn
                ? [
                    {
                      amount:
                        stage.surplusAllowanceAmount === null
                          ? UNLIMITED_PAYOUT
                          : scaleDecimals(
                              stage.surplusAllowanceAmount,
                              planAmountDecimals(accounting),
                              ctx.decimals,
                            ),
                      currency: ctx.currency,
                    },
                  ]
                : [],
            })),
    }),
  )

  // The router-registry terminal makes the project accept ANY token via
  // swap routing; without it, payers must pay in the accounting token(s).
  const terminalConfigurations = plan.allowAnyToken
    ? buildTerminalConfigurations({ chainId, accountingContexts: contexts })
    : [
        {
          terminal: v6Address('JBMultiTerminal', chainId),
          accountingContextsToAccept: contexts,
        },
      ]

  // Linked multichain launches go through the omnichain deployer: same
  // 721-hook config, plus the sucker deployment config (shared salt pairs
  // the suckers). Its ruleset tuple takes FULL metadata; the deployer
  // injects the 721 hook as the pay data hook itself.
  if (plan.linkChains && plan.chains.length > 1) {
    return {
      chainId,
      address: v6Address('JBOmnichainDeployer', chainId),
      abi: jbOmnichainDeployerAbi,
      functionName: 'launchProjectFor' as const,
      args: [
        owner,
        args.projectUri,
        {
          deployTiersHookConfig: build721HookConfig(
            args.plan.store,
            args.projectUri,
            accounting,
            chainId,
          ),
          useDataHookForCashOut: plan.store.itemsRedeem,
          salt: args.salt,
        },
        rulesetConfigurations,
        terminalConfigurations,
        '',
        suckerConfigFor(plan, chainId, args.salt),
      ],
      value: args.creationFee,
    } as const
  }

  return {
    chainId,
    address: v6Address('JB721TiersHookProjectDeployer', chainId),
    abi: jb721TiersHookProjectDeployerAbi,
    functionName: 'launchProjectFor' as const,
    args: [
      owner,
      build721HookConfig(args.plan.store, args.projectUri, accounting, chainId),
      {
        projectUri: args.projectUri,
        rulesetConfigurations,
        terminalConfigurations,
        memo: '',
      },
      v6Address('JBController', chainId),
      args.salt,
    ],
    value: args.creationFee,
  } as const
}

/**
 * Whether a launch attaches the any-token router-terminal registry — the
 * terminal that lets payers pay in ANY token, swap-routed into the accounting
 * token(s).
 *
 * Revnets always attach it: REVDeployer builds its own terminal list and
 * includes `JBRouterTerminalRegistry` on every chain where that registry is
 * deployed, so `allowAnyToken` only decides the project flavors. Resolving it
 * in one place keeps the wizard's copy, the draft it saves and the calldata it
 * encodes on the same answer.
 */
export function launchAcceptsAnyToken(
  flavor: 'simple' | 'project' | 'revnet',
  allowAnyToken: boolean,
): boolean {
  return flavor === 'revnet' || allowAnyToken
}

/** Whether 'native' bridging can serve this selection. Native bridges only
 *  connect Ethereum with an L2 (so every pair must include the L1 — i.e.
 *  exactly two chains, one of them Ethereum) and only carry ETH (USDC
 *  mappings silently drop; custom/USDC-only accounting throws in the SDK).
 *  'both' needs no check — it falls back to CCIP per pair and per asset. */
export function nativeBridgeViable(
  chains: number[],
  tokens: string[],
  customToken: boolean,
): boolean {
  const l1s = [1, 11155111]
  return (
    chains.length === 2 &&
    chains.some(id => l1s.includes(id)) &&
    !customToken &&
    tokens.length === 1 &&
    tokens[0] === 'eth'
  )
}

/**
 * The per-chain address overrides actually in play for a launch: the non-empty
 * entries belonging to the SELECTED chains, trimmed.
 *
 * Deselecting a chain keeps its override in the draft (re-selecting restores
 * it) and the encode reads only the selected chains — so a leftover entry must
 * never gate validation or a summary either. Validating every entry ever typed
 * let a half-typed address on a deselected chain dead-end the launch button
 * with no rendered field and no error to explain it.
 */
export function activeChainOverrides(
  byChain: Record<number, string>,
  chains: number[],
): string[] {
  return chains.map(chainId => byChain[chainId]?.trim() ?? '').filter(Boolean)
}

/** Sucker deployment config for one chain: CCIP deployer + token mappings
 *  per remote chain, sharing ONE salt so the suckers pair. Unlinked (or
 *  single-chain) launches pass empty configurations. Custom-token
 *  accounting maps no terminal tokens — only project tokens bridge. */
function suckerConfigFor(
  plan: LaunchPlan,
  chainId: JBChainId,
  salt: `0x${string}`,
) {
  if (!plan.linkChains || plan.chains.length < 2) {
    return { deployerConfigurations: [], salt }
  }
  const assets = plan.accounting.custom
    ? []
    : [
        ...(plan.accounting.tokens.includes('eth')
          ? [MappableAsset.NATIVE]
          : []),
        ...(plan.accounting.tokens.includes('usdc')
          ? [MappableAsset.USDC]
          : []),
      ]
  const config = parseSuckerDeployerConfig(
    chainId,
    plan.chains as JBChainId[],
    assets,
    { version: 6, bridge: plan.bridge },
  )
  return {
    // version 6 always yields the peer'd shape; the SDK type is a v5|v6
    // union so narrow it here.
    deployerConfigurations: config.deployerConfigurations as readonly {
      deployer: Address
      peer: `0x${string}`
      mappings: readonly {
        localToken: Address
        minGas: number
        remoteToken: `0x${string}`
      }[]
    }[],
    salt,
  }
}

/** Whether this context uses the stage's USDC-specific payout config
 *  (only when BOTH standard tokens are accepted). */
function usesUsdcConfig(
  plan: LaunchPlan,
  token: Address,
  chainId: JBChainId,
): boolean {
  return (
    plan.accounting.custom === null &&
    plan.accounting.tokens.length > 1 &&
    token.toLowerCase() === USDC_ADDRESSES[chainId].toLowerCase()
  )
}

function payoutSplitsFor(
  plan: LaunchPlan,
  stage: StageRules,
  token: Address,
  chainId: JBChainId,
): SplitConfig[] {
  return usesUsdcConfig(plan, token, chainId)
    ? stage.payoutSplitsUsdc
    : stage.payoutSplits
}

function payoutLimitFor(
  plan: LaunchPlan,
  stage: StageRules,
  token: Address,
  chainId: JBChainId,
): bigint | null {
  return usesUsdcConfig(plan, token, chainId)
    ? stage.payoutLimitAmountUsdc
    : stage.payoutLimitAmount
}

/**
 * Encode already-pinned store items for JB721TiersHook.adjustTiers.
 *
 * This is deliberately shared by project launch and the live Shop editor so
 * stocking an existing collection cannot drift from the tier encoding used
 * when that collection was deployed.
 */
export function build721TierConfigs(
  items: StoreItem[],
  chainId: JBChainId,
) {
  // Tiers must be sorted by category ascending; per-chain supply overrides
  // pick this chain's number (null = unlimited here).
  return [...items]
    .sort((a, b) => a.category - b.category)
    .map(item => {
      const supply =
        chainId in item.perChainSupply
          ? item.perChainSupply[chainId]
          : item.supply
      return {
        price: item.price,
        initialSupply: supply ?? TIER_UNLIMITED_SUPPLY,
        votingUnits: item.votingUnits,
        reserveFrequency: item.reserveFrequency,
        reserveBeneficiary: item.reserveBeneficiary ?? zeroAddress,
        encodedIpfsUri: item.encodedIpfsUri,
        category: item.category,
        discountPercent: item.discountPercent,
        flags: {
          allowOwnerMint: item.flags.allowOwnerMint,
          useReserveBeneficiaryAsDefault:
            item.reserveFrequency > 0 && item.reserveBeneficiary !== null,
          transfersPausable: item.flags.transfersPausable,
          useVotingUnits: item.votingUnits > 0,
          cantBeRemoved: item.flags.cantBeRemoved,
          cantIncreaseDiscountPercent: !item.flags.ownerCanEditDiscount,
          cantBuyWithCredits: !item.flags.allowCredits,
        },
        splitPercent: item.splitPercent,
        // Per-chain recipients when the create flow supplied them; otherwise `splits`, which
        // the caller already resolved for this chain.
        splits: toJbSplits(item.perChainSplits?.[chainId] ?? item.splits),
      }
    })
}

/** The tiered-721 hook config shared by both deploy flavors. */
function build721HookConfig(
  store: LaunchPlan['store'],
  projectUri: string,
  accounting: AccountingConfig,
  chainId: JBChainId,
) {
  // Tier pricing: a standard currency, or the custom accounting token
  // itself (token-keyed id, its own decimals — no feed needed).
  //
  // Refuse the combination the fallback would silently mis-encode: 'token'
  // without a custom accounting token has nothing to price against, and
  // dropping through to ETH/18 turns "10 TOKEN" into 10 ETH.
  if (store.currency === 'token' && !accounting.custom) {
    throw new Error(
      'Shop items are priced in the project token, but no custom accounting token is configured. Pick ETH or USD pricing.',
    )
  }
  const pricing =
    store.currency === 'token' && accounting.custom
      ? {
          currency: tokenCurrencyId(accounting.custom.address),
          decimals: accounting.custom.decimals,
        }
      : store.currency === 'usd'
        ? { currency: BASE_CURRENCY_USD, decimals: 6 }
        : { currency: BASE_CURRENCY_ETH, decimals: 18 }
  const tiers = build721TierConfigs(store.items, chainId)
  return {
    name: store.name,
    symbol: store.symbol,
    baseUri: 'ipfs://',
    tokenUriResolver: zeroAddress,
    contractUri: projectUri,
    tiersConfig: {
      tiers,
      currency: pricing.currency,
      decimals: pricing.decimals,
    },
    flags: {
      noNewTiersWithReserves: store.noNewTiersWithReserves,
      noNewTiersWithVotes: store.noNewTiersWithVotes,
      noNewTiersWithOwnerMinting: store.noNewTiersWithOwnerMinting,
      preventOverspending: store.preventOverspending,
      issueTokensForSplits: store.issueTokensForSplits,
    },
  }
}

/**
 * Pull the new project id from the canonical controller's LaunchProject log.
 */
export function projectIdFromReceipt(
  receipt: TransactionReceipt,
  chainId: JBChainId,
): number | null {
  const projectId = projectIdFromLaunchLogs(receipt.logs, { chainId })
  if (projectId === null || projectId > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null
  }
  return Number(projectId)
}
