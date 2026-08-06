import {
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  jbContractAddress,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  BASE_CURRENCY_ETH,
  BASE_CURRENCY_USD,
  TIER_UNLIMITED_SUPPLY,
  tokenCurrencyId,
} from '@bananapus/nana-sdk-core/v6'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  zeroAddress,
  type Abi,
  type Address,
} from 'viem'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STORE_FLAGS,
  FOREVER_SECONDS,
  build721TierConfigs,
  buildLaunchRequest,
  createSimpleProjectStage,
  nativeBridgeViable,
  resolveStages,
  type LaunchPlan,
  type SplitConfig,
  type StageRules,
  type StoreItem,
} from '@/lib/launch'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const CUSTOM = '0x3333333333333333333333333333333333333333' as Address
const HOOK = '0x4444444444444444444444444444444444444444' as Address
const SALT = `0x${'12'.repeat(32)}` as const
const URI = 'ipfs://QmProjectMetadata'

type EncodableRequest = {
  abi: Abi
  functionName: string
  args: readonly unknown[]
}

type LaunchRuleset = {
  metadata: { cashOutTaxRate: number; baseCurrency: number; metadata: number }
  splitGroups: {
    groupId: bigint
    splits: { percent: number; beneficiary: Address; hook: Address }[]
  }[]
  fundAccessLimitGroups: {
    token: Address
    payoutLimits: { amount: bigint; currency: number }[]
    surplusAllowances: { amount: bigint; currency: number }[]
  }[]
}

type ProjectLaunchConfig = {
  rulesetConfigurations: LaunchRuleset[]
  terminalConfigurations: {
    terminal: Address
    accountingContextsToAccept: {
      token: Address
      decimals: number
      currency: number
    }[]
  }[]
}

function plan(overrides: Partial<LaunchPlan> = {}): LaunchPlan {
  return {
    accounting: { tokens: ['eth'], custom: null },
    issuanceBase: null,
    flavor: 'project',
    operator: null,
    ticker: 'TEST',
    stages: [createSimpleProjectStage()],
    afterMode: 'cycle',
    approvalDeadline: 'none',
    approvalCustomAddress: null,
    allowAnyToken: false,
    owner: ALICE,
    chains: [1],
    linkChains: false,
    bridge: 'ccip',
    store: {
      name: 'Test collection',
      symbol: 'TEST',
      currency: 'eth',
      ...DEFAULT_STORE_FLAGS,
      items: [],
    },
    ...overrides,
  }
}

function requestFor(launchPlan: LaunchPlan, chainId: JBChainId = 1) {
  return buildLaunchRequest({
    chainId,
    owner: ALICE,
    projectUri: URI,
    creationFee: 123n,
    plan: launchPlan,
    salt: SALT,
  })
}

function encode(request: ReturnType<typeof buildLaunchRequest>) {
  return encodeFunctionData(request as unknown as EncodableRequest)
}

function projectConfig(
  request: ReturnType<typeof buildLaunchRequest>,
): ProjectLaunchConfig {
  // The builder returns a union of deployer tuple types; this branch is pinned
  // by the launchProjectFor assertion before its project config is inspected.
  return request.args[2] as unknown as ProjectLaunchConfig
}

function split(overrides: Partial<SplitConfig> = {}): SplitConfig {
  return {
    percent: 1_000_000_000,
    projectId: 0n,
    beneficiary: BOB,
    preferAddToBalance: false,
    lockedUntil: 0,
    hook: zeroAddress,
    ...overrides,
  }
}

describe('project launch encoding', () => {
  it('round-trips the 721 project deployer call through its canonical ABI', () => {
    const request = requestFor(plan())
    const data = encode(request)
    const decoded = decodeFunctionData({ abi: request.abi, data })

    expect(request.functionName).toBe('launchProjectFor')
    expect(request.value).toBe(123n)
    expect(data.slice(0, 10)).toBe('0xc04ae38f')
    expect(decoded.functionName).toBe('launchProjectFor')
    expect(decoded.args).toHaveLength(5)
  })

  it.each([
    {
      label: 'ETH',
      accounting: { tokens: ['eth'] as const, custom: null },
      token: NATIVE_TOKEN,
      decimals: 18,
      contextCurrency: tokenCurrencyId(NATIVE_TOKEN),
      baseCurrency: BASE_CURRENCY_ETH,
    },
    {
      label: 'USDC',
      accounting: { tokens: ['usdc'] as const, custom: null },
      token: USDC_ADDRESSES[1],
      decimals: 6,
      contextCurrency: tokenCurrencyId(USDC_ADDRESSES[1]),
      baseCurrency: BASE_CURRENCY_USD,
    },
    {
      label: 'custom token',
      accounting: { tokens: [] as const, custom: { address: CUSTOM, decimals: 8 } },
      token: CUSTOM,
      decimals: 8,
      contextCurrency: tokenCurrencyId(CUSTOM),
      baseCurrency: tokenCurrencyId(CUSTOM),
    },
  ])('uses the contract currency and decimals for $label accounting', row => {
    const launchPlan = plan({
      accounting: {
        tokens: [...row.accounting.tokens],
        custom: row.accounting.custom,
      },
      store: {
        ...plan().store,
        currency: row.accounting.custom ? 'token' : row.label === 'USDC' ? 'usd' : 'eth',
      },
    })
    const request = requestFor(launchPlan)
    const config = projectConfig(request)
    const contexts = config.terminalConfigurations.flatMap(
      terminal => terminal.accountingContextsToAccept,
    )

    expect(contexts).toEqual([
      expect.objectContaining({
        token: row.token,
        decimals: row.decimals,
        currency: row.contextCurrency,
      }),
    ])
    expect(config.rulesetConfigurations[0].metadata.baseCurrency).toBe(
      row.baseCurrency,
    )
    expect(() => encode(request)).not.toThrow()
  })

  it('keeps ETH and USDC payout limits, currencies, and splits separate', () => {
    const ethSplit = split({ percent: 600_000_000 })
    const usdcSplit = split({ beneficiary: ALICE, hook: HOOK })
    const stage: StageRules = {
      ...createSimpleProjectStage(),
      payouts: 'routed',
      payoutSplits: [ethSplit],
      payoutLimitAmount: 2n * 10n ** 18n,
      payoutSplitsUsdc: [usdcSplit],
      payoutLimitAmountUsdc: 3_000_000n,
      surplusAllowanceOn: false,
      surplusAllowanceAmount: null,
      cashOutTaxRate: 5_000,
    }
    const request = requestFor(
      plan({ accounting: { tokens: ['eth', 'usdc'], custom: null }, stages: [stage] }),
    )
    const ruleset = projectConfig(request).rulesetConfigurations[0]
    const eth = ruleset.fundAccessLimitGroups.find(
      group => group.token.toLowerCase() === NATIVE_TOKEN.toLowerCase(),
    )
    const usdc = ruleset.fundAccessLimitGroups.find(
      group => group.token.toLowerCase() === USDC_ADDRESSES[1].toLowerCase(),
    )

    expect(eth?.payoutLimits).toEqual([
      { amount: 2n * 10n ** 18n, currency: tokenCurrencyId(NATIVE_TOKEN) },
    ])
    expect(usdc?.payoutLimits).toEqual([
      { amount: 3_000_000n, currency: tokenCurrencyId(USDC_ADDRESSES[1]) },
    ])
    expect(ruleset.splitGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          groupId: BigInt(NATIVE_TOKEN),
          splits: [expect.objectContaining({ beneficiary: BOB, percent: 600_000_000 })],
        }),
        expect.objectContaining({
          groupId: BigInt(USDC_ADDRESSES[1]),
          splits: [expect.objectContaining({ beneficiary: ALICE, hook: HOOK })],
        }),
      ]),
    )
    expect(ruleset.metadata.cashOutTaxRate).toBe(5_000)
  })

  it('denominates the surplus allowance in each accounting context own decimals', () => {
    // The single form field means "this amount in each context's own
    // currency": a 1.0 cap (parsed at the ETH-led 18 decimals) must reach
    // the 6-decimal USDC context as 1e6, not 1e18.
    const stage: StageRules = {
      ...createSimpleProjectStage(),
      surplusAllowanceOn: true,
      surplusAllowanceAmount: 10n ** 18n,
    }
    const ruleset = projectConfig(
      requestFor(
        plan({ accounting: { tokens: ['eth', 'usdc'], custom: null }, stages: [stage] }),
      ),
    ).rulesetConfigurations[0]
    const eth = ruleset.fundAccessLimitGroups.find(
      group => group.token.toLowerCase() === NATIVE_TOKEN.toLowerCase(),
    )
    const usdc = ruleset.fundAccessLimitGroups.find(
      group => group.token.toLowerCase() === USDC_ADDRESSES[1].toLowerCase(),
    )

    expect(eth?.surplusAllowances).toEqual([
      { amount: 10n ** 18n, currency: tokenCurrencyId(NATIVE_TOKEN) },
    ])
    expect(usdc?.surplusAllowances).toEqual([
      { amount: 10n ** 6n, currency: tokenCurrencyId(USDC_ADDRESSES[1]) },
    ])
  })

  it('keeps the unlimited surplus allowance sentinel un-scaled in every context', () => {
    const stage: StageRules = {
      ...createSimpleProjectStage(),
      surplusAllowanceOn: true,
      surplusAllowanceAmount: null,
    }
    const ruleset = projectConfig(
      requestFor(
        plan({ accounting: { tokens: ['eth', 'usdc'], custom: null }, stages: [stage] }),
      ),
    ).rulesetConfigurations[0]

    for (const group of ruleset.fundAccessLimitGroups) {
      expect(group.surplusAllowances).toEqual([
        expect.objectContaining({ amount: 2n ** 224n - 1n }),
      ])
    }
  })

  it('disables cash outs when an unlimited routed payout consumes all funds', () => {
    const stage: StageRules = {
      ...createSimpleProjectStage(),
      payouts: 'routed',
      payoutSplits: [split()],
      payoutLimitAmount: null,
      cashOutTaxRate: 0,
    }
    const ruleset = projectConfig(requestFor(plan({ stages: [stage] })))
      .rulesetConfigurations[0]

    expect(ruleset.metadata.cashOutTaxRate).toBe(10_000)
    expect(ruleset.fundAccessLimitGroups[0].payoutLimits[0].amount).toBe(
      2n ** 224n - 1n,
    )
  })

  it('uses the omnichain deployer ABI only for explicitly linked chains', () => {
    const request = requestFor(
      plan({ chains: [1, 10], linkChains: true, bridge: 'ccip' }),
    )
    const data = encode(request)

    expect(request.address).toBe(jbContractAddress['6'].JBOmnichainDeployer[1])
    expect(data.slice(0, 10)).toBe('0x2d993173')
    expect(decodeFunctionData({ abi: request.abi, data }).functionName).toBe(
      'launchProjectFor',
    )
  })

  it('encodes a revnet deployment through the SDK-provided request', () => {
    const request = requestFor(
      plan({
        flavor: 'revnet',
        operator: BOB,
        ticker: 'REV',
        stages: [
          {
            ...createSimpleProjectStage(),
            reservedPercent: 2_500,
            reservedSplits: [split({ percent: 500_000_000 })],
          },
        ],
      }),
    )
    const data = encode(request)
    const decoded = decodeFunctionData({ abi: request.abi, data })

    expect(request.functionName).toBe('deployFor')
    expect(decoded.functionName).toBe('deployFor')
    expect(data).toMatch(/^0x[0-9a-f]+$/)
  })

  it('encodes eligible 721 transfer pauses for project rulesets and revnet stages', () => {
    const projectStage = {
      ...createSimpleProjectStage(),
      pause721Transfers: true,
      metadataExtra: 1 << 2,
    }
    const projectRuleset = projectConfig(
      requestFor(plan({ stages: [projectStage] })),
    ).rulesetConfigurations[0]
    expect(projectRuleset.metadata.metadata).toBe(5)

    const revnetRequest = requestFor(
      plan({
        flavor: 'revnet',
        operator: BOB,
        ticker: 'REV',
        stages: [projectStage],
      }),
    )
    const revnetConfig = revnetRequest.args[1] as unknown as {
      stageConfigurations: readonly { extraMetadata: number }[]
    }
    expect(revnetConfig.stageConfigurations[0].extraMetadata).toBe(5)
  })

  // REVDeployer.deploySuckersFor reverts unless bit 2 of the CURRENT stage's app
  // metadata is set (REVDeployer.sol:646-650), and stages are immutable — a stage
  // launched without it can never be extended to another chain. Launch-time
  // suckers skip the check, so nothing fails until someone tries to extend.
  it('sets the allow-sucker-deployment bit on every revnet stage by default', () => {
    const request = requestFor(
      plan({
        flavor: 'revnet',
        operator: BOB,
        ticker: 'REV',
        stages: [createSimpleProjectStage(), createSimpleProjectStage()],
      }),
    )
    const config = request.args[1] as unknown as {
      stageConfigurations: readonly { extraMetadata: number }[]
    }

    expect(config.stageConfigurations).toHaveLength(2)
    for (const stage of config.stageConfigurations) {
      expect(stage.extraMetadata & (1 << 2)).toBe(1 << 2)
    }
  })

  // deployFor(revnetId, config, ...): the union's tuple branch is pinned
  // by the functionName assertion in the revnet encoding test above.
  const autoIssuancesOn = (revnetPlan: LaunchPlan, chainId: JBChainId) => {
    const request = requestFor(revnetPlan, chainId)
    const config = request.args[1] as unknown as {
      stageConfigurations: readonly {
        autoIssuances: readonly {
          chainId: number
          count: bigint
          beneficiary: Address
        }[]
      }[]
    }
    return config.stageConfigurations[0].autoIssuances
  }

  it('encodes every auto-issuance in every chain of a multichain revnet', () => {
    // A row mints on ITS chosen chain, but every chain's config must carry
    // the full row list: REVDeployer folds all rows into
    // encodedConfiguration (which must hash identically across chains) and
    // mints only rows whose chainId matches the local chain. An unset row
    // chainId defaults to the first selected chain.
    const chains = [1, 10, 8453] as const
    const count = 1_000n * 10n ** 18n
    const revnetPlan = plan({
      flavor: 'revnet',
      operator: BOB,
      ticker: 'REV',
      chains: [...chains],
      linkChains: true,
      stages: [
        {
          ...createSimpleProjectStage(),
          autoIssuances: [{ count, beneficiary: ALICE }],
        },
      ],
    })

    for (const chainId of chains) {
      expect(autoIssuancesOn(revnetPlan, chainId)).toEqual([
        { chainId: 1, count, beneficiary: ALICE },
      ])
    }

    // Only the chosen chain's deployer mints the row: 1,000 tokens total.
    const minted = chains
      .flatMap(chainId =>
        autoIssuancesOn(revnetPlan, chainId).filter(a => a.chainId === chainId),
      )
      .reduce((sum, issuance) => sum + issuance.count, 0n)
    expect(minted).toBe(count)
  })

  it('keeps stage configs byte-identical with rows minting on different chains', () => {
    const chains = [1, 10, 8453] as const
    const revnetPlan = plan({
      flavor: 'revnet',
      operator: BOB,
      ticker: 'REV',
      chains: [...chains],
      linkChains: true,
      stages: [
        {
          ...createSimpleProjectStage(),
          autoIssuances: [
            { count: 1_000n * 10n ** 18n, beneficiary: ALICE, chainId: 1 },
            { count: 5n * 10n ** 18n, beneficiary: CUSTOM, chainId: 8453 },
          ],
        },
      ],
    })

    // Every chain carries BOTH rows, each pinned to its chosen chain.
    for (const chainId of chains) {
      expect(
        autoIssuancesOn(revnetPlan, chainId).map(a => a.chainId),
      ).toEqual([1, 8453])
    }

    // The abi-encoded stage tuples must be byte-identical across chains —
    // REVDeployer hashes them into the cross-chain revnet identity.
    const encodedStagesOn = (chainId: JBChainId) => {
      const request = requestFor(revnetPlan, chainId)
      const deployFor = (request.abi as Abi).find(
        entry => entry.type === 'function' && entry.name === 'deployFor',
      ) as Extract<Abi[number], { type: 'function' }>
      const configParam = deployFor.inputs[1] as {
        components: readonly { name?: string }[]
      }
      const stagesParam = configParam.components.find(
        component => component.name === 'stageConfigurations',
      )!
      const config = request.args[1] as { stageConfigurations: unknown }
      return encodeAbiParameters(
        [stagesParam] as Parameters<typeof encodeAbiParameters>[0],
        [config.stageConfigurations],
      )
    }
    const reference = encodedStagesOn(1)
    expect(reference).toMatch(/^0x[0-9a-f]+$/)
    expect(encodedStagesOn(10)).toBe(reference)
    expect(encodedStagesOn(8453)).toBe(reference)
  })

  it('falls back to the first selected chain for a row pinned to an unselected chain', () => {
    // A draft import can carry a chainId the user has since deselected —
    // the encode falls back rather than minting nowhere.
    const revnetPlan = plan({
      flavor: 'revnet',
      operator: BOB,
      ticker: 'REV',
      chains: [10, 8453],
      linkChains: true,
      stages: [
        {
          ...createSimpleProjectStage(),
          autoIssuances: [{ count: 7n, beneficiary: ALICE, chainId: 1 }],
        },
      ],
    })
    for (const chainId of [10, 8453] as const) {
      expect(autoIssuancesOn(revnetPlan, chainId)).toEqual([
        { chainId: 10, count: 7n, beneficiary: ALICE },
      ])
    }
  })
})

describe('launch helper invariants', () => {
  it('only permits native bridges for an Ethereum + one-L2 ETH pair', () => {
    expect(nativeBridgeViable([1, 10], ['eth'], false)).toBe(true)
    expect(nativeBridgeViable([11155111, 84532], ['eth'], false)).toBe(true)
    expect(nativeBridgeViable([10, 8453], ['eth'], false)).toBe(false)
    expect(nativeBridgeViable([1, 10, 8453], ['eth'], false)).toBe(false)
    expect(nativeBridgeViable([1, 10], ['usdc'], false)).toBe(false)
    expect(nativeBridgeViable([1, 10], ['eth'], true)).toBe(false)
  })

  it('expands terminal and standby aftermath without mutating the input stage', () => {
    const timed = { ...createSimpleProjectStage(), duration: 86_400, cashOutTaxRate: 2_000 }
    const terminal = resolveStages(plan({ stages: [timed], afterMode: 'terminal' }))
    const waiting = resolveStages(plan({ stages: [timed], afterMode: 'wait' }))

    expect(terminal).toHaveLength(2)
    expect(terminal[1]).toEqual(expect.objectContaining({ duration: FOREVER_SECONDS }))
    expect(waiting[1]).toEqual(
      expect.objectContaining({ weight: 0n, pausePay: true, cashOutTaxRate: 2_000 }),
    )
    expect(timed.duration).toBe(86_400)
  })

  // A store item's metadata is pinned ONCE for every chain, but a split row can name a
  // different recipient per chain (SplitsEditor exposes those overrides for store items too).
  // Resolving recipients against one chain and reusing them everywhere silently pays chain[0]'s
  // address on all the others.
  it('encodes each chain its own store-item split recipients', () => {
    const item: StoreItem = {
      price: 1_000n,
      supply: null,
      encodedIpfsUri: `0x${'1'.padStart(64, '0')}`,
      splitPercent: 500_000_000,
      splits: [
        {
          percent: 1e9,
          projectId: 0n,
          beneficiary: ALICE,
          preferAddToBalance: false,
          lockedUntil: 0,
          hook: zeroAddress,
        },
      ],
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
      perChainSplits: {
        1: [
          {
            percent: 1e9,
            projectId: 0n,
            beneficiary: ALICE,
            preferAddToBalance: false,
            lockedUntil: 0,
            hook: zeroAddress,
          },
        ],
        8453: [
          {
            percent: 1e9,
            projectId: 0n,
            beneficiary: BOB,
            preferAddToBalance: false,
            lockedUntil: 0,
            hook: zeroAddress,
          },
        ],
      },
    }

    expect(build721TierConfigs([item], 1)[0].splits[0].beneficiary).toBe(ALICE)
    expect(build721TierConfigs([item], 8453)[0].splits[0].beneficiary).toBe(BOB)
  })

  it('falls back to the resolved splits when no per-chain map is supplied', () => {
    // The live Shop editor builds its items per chain already, so `splits` is correct there.
    const item: StoreItem = {
      price: 1_000n,
      supply: null,
      encodedIpfsUri: `0x${'2'.padStart(64, '0')}`,
      splitPercent: 500_000_000,
      splits: [
        {
          percent: 1e9,
          projectId: 0n,
          beneficiary: BOB,
          preferAddToBalance: false,
          lockedUntil: 0,
          hook: zeroAddress,
        },
      ],
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
    expect(build721TierConfigs([item], 42_161)[0].splits[0].beneficiary).toBe(BOB)
  })

  it('sorts tiers and applies per-chain supply and inverted flags exactly', () => {
    const item = (category: number, supply: number | null): StoreItem => ({
      price: 1_000n,
      supply,
      encodedIpfsUri: `0x${String(category + 1).padStart(64, '0')}`,
      splitPercent: 0,
      splits: [],
      discountPercent: 4,
      reserveFrequency: 2,
      reserveBeneficiary: BOB,
      category,
      votingUnits: 7,
      flags: {
        allowOwnerMint: true,
        transfersPausable: false,
        cantBeRemoved: true,
        allowCredits: true,
        ownerCanEditDiscount: true,
      },
      perChainSupply: category === 2 ? { 1: null } : { 1: 9 },
    })
    const tiers = build721TierConfigs([item(2, 5), item(1, 4)], 1)

    expect(tiers.map(tier => tier.category)).toEqual([1, 2])
    expect(tiers.map(tier => tier.initialSupply)).toEqual([9, TIER_UNLIMITED_SUPPLY])
    expect(tiers[0].flags).toEqual(
      expect.objectContaining({
        useReserveBeneficiaryAsDefault: true,
        useVotingUnits: true,
        cantIncreaseDiscountPercent: false,
        cantBuyWithCredits: false,
      }),
    )
  })
})
