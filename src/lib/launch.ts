import {
  MappableAsset,
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  jb721TiersHookProjectDeployerAbi,
  jbOmnichainDeployerAbi,
  parseSuckerDeployerConfig,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  BASE_CURRENCY_ETH,
  BASE_CURRENCY_USD,
  buildAccountingContext,
  buildDeployRevnetTx,
  buildRevnetStageConfig,
  buildRulesetConfiguration,
  buildRulesetMetadata,
  buildTerminalConfigurations,
  tokenCurrencyId,
  v6Address,
} from '@bananapus/nana-sdk-core/v6'
import { zeroAddress, type Address, type TransactionReceipt } from 'viem'

/** 10,000 tokens per ETH/USD paid (18-decimal fixed point). */
export const DEFAULT_WEIGHT = 10n ** 22n

/** cashOutTaxRate sentinel: 100% tax = cash outs disabled. */
const CASH_OUTS_OFF = 10_000

/** JBFundAccessLimitGroup "unlimited" payout amount sentinel. */
const UNLIMITED_PAYOUT = 2n ** 224n - 1n

/** JB721 tier initialSupply sentinel for unlimited inventory. */
const TIER_UNLIMITED_SUPPLY = 999_999_999

export type TreasuryCurrency = 'eth' | 'usdc'

/** One store item, already pinned: encodedIpfsUri is the bytes32 digest of
 *  the item's CIDv0 metadata (see ipfs-cid.ts). Price is in the store
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
}

export const DEFAULT_ITEM_EXTRAS: Pick<
  StoreItem,
  | 'splitPercent'
  | 'splits'
  | 'discountPercent'
  | 'reserveFrequency'
  | 'reserveBeneficiary'
  | 'category'
  | 'votingUnits'
  | 'flags'
  | 'perChainSupply'
> = {
  splitPercent: 0,
  splits: [],
  discountPercent: 0,
  reserveFrequency: 0,
  reserveBeneficiary: null,
  category: 0,
  votingUnits: 0,
  flags: {
    allowOwnerMint: false,
    transfersPausable: false,
    cantBeRemoved: false,
    allowCredits: true,
    ownerCanEditDiscount: true,
  },
  perChainSupply: {},
}

/** The Uniswap V4 LP split hook ("Fund market") — same address on every
 *  supported chain (website/ deployments). */
export const LP_SPLIT_HOOK =
  '0xaf2d8a027955871cd2f3c4d2f32338e574e69bc0' as Address

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
  /** Unix seconds the FIRST stage must start at or after; 0 = deploy block.
   *  Later stages always encode 0 — the controller chains each after the
   *  previous stage's duration. */
  mustStartAtOrAfter: number
  /** Tokens issued per ETH/USD paid — 18-dec FP. On stage 2+, 0n = inherit
   *  the previous stage's (cut) rate. */
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
  /** Cap on owner surplus withdrawals (accounting units); null = unlimited. */
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
  /** Owner superpowers — all default off; supporters can see them. */
  allowSetTerminals: boolean
  allowSetController: boolean
  allowTerminalMigration: boolean
  allowSetCustomToken: boolean
  allowAddAccountingContext: boolean
  allowAddPriceFeed: boolean
  /** Revnet only: seconds between issuance cuts (0 = no cuts). */
  issuanceCutFrequency: number
  /** Revnet only: tokens minted to beneficiaries when the stage starts. */
  autoIssuances: { count: bigint; beneficiary: Address }[]
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
  /** Link the chains with CCIP suckers so tokens/treasury bridge. */
  linkChains: boolean
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

export const DEFAULT_STAGE: StageRules = {
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
  autoIssuances: [],
  allowSetTerminals: false,
  allowSetController: false,
  allowTerminalMigration: false,
  allowSetCustomToken: false,
  allowAddAccountingContext: false,
  allowAddPriceFeed: false,
  issuanceCutFrequency: 0,
}

export const DEFAULT_ACCOUNTING: AccountingConfig = {
  tokens: ['eth'],
  custom: null,
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

export const DEFAULT_PLAN: Omit<LaunchPlan, 'store'> = {
  accounting: DEFAULT_ACCOUNTING,
  issuanceBase: null,
  flavor: 'project',
  operator: null,
  ticker: '',
  stages: [DEFAULT_STAGE],
  afterMode: 'wait',
  approvalDeadline: '1day',
  approvalCustomAddress: null,
  allowAnyToken: true,
  owner: null,
  chains: [],
  linkChains: true,
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

export function treasuryToken(
  currency: TreasuryCurrency,
  chainId: JBChainId,
): Address {
  return currency === 'usdc' ? USDC_ADDRESSES[chainId] : NATIVE_TOKEN
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
 * Multi-chain launches are independent per-chain transactions — no suckers
 * are configured, so byte-identical rulesets aren't required.
 */
export function buildLaunchRequest(args: {
  chainId: JBChainId
  owner: Address
  projectUri: string
  creationFee: bigint
  plan: LaunchPlan
  /** Unique per launch run (the hook's create2 salt). */
  salt: `0x${string}`
}) {
  const { chainId, plan } = args
  const { accounting } = plan
  // Custom tokens are exclusive and price everything in themselves (their
  // token-keyed currency id) so no feed is needed; otherwise ETH and/or
  // USDC contexts, with the base currency following ETH when present.
  const contexts = accounting.custom
    ? [
        buildAccountingContext(
          accounting.custom.address,
          accounting.custom.decimals,
        ),
      ]
    : accounting.tokens.map(t =>
        buildAccountingContext(
          treasuryToken(t, chainId),
          t === 'usdc' ? 6 : 18,
        ),
      )
  const baseCurrency = accounting.custom
    ? tokenCurrencyId(accounting.custom.address)
    : (plan.issuanceBase ?? (accounting.tokens.includes('eth') ? 'eth' : 'usd')) ===
        'eth'
      ? BASE_CURRENCY_ETH
      : BASE_CURRENCY_USD

  if (plan.flavor === 'revnet') {
    // Fixed-forever stages via REVDeployer (website/ parity). Stage starts
    // are ABSOLUTE and strictly increasing — the caller bakes them into
    // mustStartAtOrAfter. Reserved% / reservedSplits map to the stage's
    // splitPercent / splits; the split bucket must total exactly 1e9, so
    // any unallocated remainder goes to the operator.
    const operator = plan.operator ?? args.owner
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
        autoIssuances: stage.autoIssuances.map(a => ({
          chainId,
          count: a.count,
          beneficiary: a.beneficiary,
        })),
        // 0n on later stages = inherit the previous (cut) rate — the JB
        // ruleset weight semantic REVDeployer passes straight through.
        initialIssuance: stage.weight,
        splitPercent: stage.reservedPercent,
        splits: stage.reservedPercent > 0 ? splits : [],
        issuanceCutFrequency: stage.issuanceCutFrequency,
        issuanceCutPercent: stage.weightCutPercent,
        cashOutTaxRate: stage.cashOutTaxRate ?? 0,
      })
    })

    return buildDeployRevnetTx({
      chainId,
      config: {
        description: {
          name: plan.store.name,
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

  const rulesetConfigurations = stages.map((stage, i) =>
    buildRulesetConfiguration({
      // Only the first stage carries a real start; later stages encode 0 so
      // the controller chains each after the previous stage's duration.
      mustStartAtOrAfter: i === 0 ? stage.mustStartAtOrAfter : 0,
      duration: stage.duration,
      weight: stage.weight,
      weightCutPercent: stage.weightCutPercent,
      approvalHook,
      metadata: buildRulesetMetadata({
        baseCurrency,
        reservedPercent: stage.reservedPercent,
        // Routing ALL funds (unlimited payout limit) leaves no surplus for
        // cash outs — keep them formally disabled in that mode. Fixed-amount
        // routing and flexible (surplus allowance) leave surplus intact.
        cashOutTaxRate:
          stage.payouts === 'routed' && stage.payoutLimitAmount === null
            ? CASH_OUTS_OFF
            : (stage.cashOutTaxRate ?? CASH_OUTS_OFF),
        allowOwnerMinting: stage.allowOwnerMinting,
        holdFees: stage.holdFees,
        pausePay: stage.pausePay,
        pauseCreditTransfers: stage.pauseCreditTransfers,
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
              surplusAllowances: stage.surplusAllowanceOn
                ? [
                    {
                      amount: stage.surplusAllowanceAmount ?? UNLIMITED_PAYOUT,
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
        args.owner,
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
      args.owner,
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
    { version: 6 },
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

/** The tiered-721 hook config shared by both deploy flavors. */
function build721HookConfig(
  store: LaunchPlan['store'],
  projectUri: string,
  accounting: AccountingConfig,
  chainId: JBChainId,
) {
  // Tier pricing: a standard currency, or the custom accounting token
  // itself (token-keyed id, its own decimals — no feed needed).
  const pricing =
    store.currency === 'token' && accounting.custom
      ? {
          currency: tokenCurrencyId(accounting.custom.address),
          decimals: accounting.custom.decimals,
        }
      : store.currency === 'usd'
        ? { currency: BASE_CURRENCY_USD, decimals: 6 }
        : { currency: BASE_CURRENCY_ETH, decimals: 18 }
  // Tiers must be sorted by category ascending; per-chain supply overrides
  // pick this chain's number (null = unlimited here).
  const tiers = [...store.items]
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
        splits: toJbSplits(item.splits),
      }
    })
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

const ERC721_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * Pull the new project id out of a launch receipt: the JBProjects ERC-721
 * mint is the Transfer log with 4 topics whose `from` is the zero address —
 * its tokenId topic IS the project id. Store launches deploy the hook but
 * mint no hook 721s, so this holds for both launch paths.
 */
export function projectIdFromReceipt(
  receipt: TransactionReceipt,
): number | null {
  for (const log of receipt.logs) {
    if (
      log.topics[0] === ERC721_TRANSFER_TOPIC &&
      log.topics.length === 4 &&
      BigInt(log.topics[1] ?? '0x0') === 0n
    ) {
      return parseInt(log.topics[3] as string, 16)
    }
  }
  return null
}
