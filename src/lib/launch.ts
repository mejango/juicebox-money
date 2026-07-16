import {
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  jb721TiersHookProjectDeployerAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  BASE_CURRENCY_ETH,
  BASE_CURRENCY_USD,
  buildAccountingContext,
  buildRulesetConfiguration,
  buildRulesetMetadata,
  buildTerminalConfigurations,
  v6Address,
} from '@bananapus/nana-sdk-core/v6'
import { zeroAddress, type Address, type TransactionReceipt } from 'viem'

/** 1,000,000 tokens per ETH/USD paid (18-decimal fixed point). */
export const DEFAULT_WEIGHT = 10n ** 24n

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
}

export type LaunchPlan = {
  currency: TreasuryCurrency
  /** Tokens issued per ETH (or USD, for USDC treasuries) paid — 18-dec FP. */
  weight: bigint
  /** Share of newly issued tokens kept for the owner, out of 10000. */
  reservedPercent: number
  /** 'none': funds only leave via cash outs (if enabled). 'flexible': the
   *  owner can pay out any amount to anyone, anytime (⇒ no surplus). */
  payouts: 'none' | 'flexible'
  /** Cash-out tax out of 10000, or null = cash outs disabled. */
  cashOutTaxRate: number | null
  allowOwnerMinting: boolean
  /** The 721 store collection. Always deployed — even with zero items — so
   *  every project can stock its store later without a ruleset change. */
  store: {
    name: string
    symbol: string
    items: StoreItem[]
  }
}

export const DEFAULT_PLAN: Omit<LaunchPlan, 'store'> = {
  currency: 'eth',
  weight: DEFAULT_WEIGHT,
  reservedPercent: 0,
  payouts: 'none',
  cashOutTaxRate: null,
  allowOwnerMinting: false,
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
  const isUsd = plan.currency === 'usdc'
  const token = treasuryToken(plan.currency, chainId)
  const context = buildAccountingContext(token, isUsd ? 6 : 18)

  const metadata = buildRulesetMetadata({
    baseCurrency: isUsd ? BASE_CURRENCY_USD : BASE_CURRENCY_ETH,
    reservedPercent: plan.reservedPercent,
    // Flexible payouts leave no surplus, so cash outs would be worthless —
    // keep them formally disabled in that mode.
    cashOutTaxRate:
      plan.payouts === 'flexible' ? CASH_OUTS_OFF : (plan.cashOutTaxRate ?? CASH_OUTS_OFF),
    allowOwnerMinting: plan.allowOwnerMinting,
  })

  const rulesetConfigurations = [
    buildRulesetConfiguration({
      weight: plan.weight,
      metadata,
      fundAccessLimitGroups:
        plan.payouts === 'flexible'
          ? [
              {
                terminal: v6Address('JBMultiTerminal', chainId),
                token,
                payoutLimits: [
                  { amount: UNLIMITED_PAYOUT, currency: context.currency },
                ],
                surplusAllowances: [],
              },
            ]
          : [],
    }),
  ]

  const terminalConfigurations = buildTerminalConfigurations({
    chainId,
    accountingContexts: [context],
  })

  const store = args.plan.store
  const tiers = store.items.map(item => ({
    price: item.price,
    initialSupply: item.supply ?? TIER_UNLIMITED_SUPPLY,
    votingUnits: 0,
    reserveFrequency: 0,
    reserveBeneficiary: zeroAddress,
    encodedIpfsUri: item.encodedIpfsUri,
    category: 0,
    discountPercent: 0,
    flags: {
      allowOwnerMint: false,
      useReserveBeneficiaryAsDefault: false,
      transfersPausable: false,
      useVotingUnits: false,
      cantBeRemoved: false,
      cantIncreaseDiscountPercent: false,
      cantBuyWithCredits: false,
    },
    splitPercent: 0,
    splits: [],
  }))

  return {
    chainId,
    address: v6Address('JB721TiersHookProjectDeployer', chainId),
    abi: jb721TiersHookProjectDeployerAbi,
    functionName: 'launchProjectFor' as const,
    args: [
      args.owner,
      {
        name: store.name,
        symbol: store.symbol,
        baseUri: 'ipfs://',
        tokenUriResolver: zeroAddress,
        contractUri: args.projectUri,
        tiersConfig: {
          tiers,
          // Tier prices are in a standard currency (never token-keyed):
          // ETH prices in 18 decimals, USD prices in 6 (1 USDC pays $1).
          currency: isUsd ? BASE_CURRENCY_USD : BASE_CURRENCY_ETH,
          decimals: isUsd ? 6 : 18,
        },
        flags: {
          noNewTiersWithReserves: false,
          noNewTiersWithVotes: false,
          noNewTiersWithOwnerMinting: false,
          preventOverspending: false,
          issueTokensForSplits: false,
        },
      },
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
