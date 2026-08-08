import { NATIVE_TOKEN, type JBChainId } from '@bananapus/nana-sdk-core'
import { zeroAddress, type Address, type PublicClient } from 'viem'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentRuleset: vi.fn(),
  getUpcomingRuleset: vi.fn(),
  getAccountingContexts: vi.fn(),
  getTokenAddress: vi.fn(),
}))

vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => {
  const original = await importOriginal<
    typeof import('@bananapus/nana-sdk-core/v6')
  >()
  return {
    ...original,
    getCurrentRuleset: mocks.getCurrentRuleset,
    getUpcomingRuleset: mocks.getUpcomingRuleset,
    getAccountingContexts: mocks.getAccountingContexts,
    getTokenAddress: mocks.getTokenAddress,
  }
})

import { buildProjectDraftExport } from '@/lib/project-draft-export'

const CHAIN = 1 as JBChainId
const OWNER = `0x${'11'.repeat(20)}` as Address
const RECIPIENT = `0x${'22'.repeat(20)}` as Address
const TOKEN = `0x${'33'.repeat(20)}` as Address
const DAY = 86_400

/** Every live read the export makes beyond the three mocked SDK helpers. */
function client(splits: Record<string, unknown[]> = {}): PublicClient {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'payoutLimitsOf':
        case 'surplusAllowancesOf':
          return []
        case 'splitsOf':
          return splits[functionName] ?? []
        case 'symbol':
          return 'TEST'
        default:
          throw new Error(`unexpected read: ${functionName}`)
      }
    }),
  } as unknown as PublicClient
}

function ruleset(overrides: Record<string, unknown> = {}) {
  return {
    ruleset: {
      id: 1n,
      cycleNumber: 1n,
      start: 1_700_000_000n,
      duration: 0n,
      weight: 10n ** 18n,
      weightCutPercent: 0n,
      approvalHook: zeroAddress,
      ...overrides,
    },
    metadata: {
      reservedPercent: 0n,
      cashOutTaxRate: 0n,
      baseCurrency: 1n,
      pausePay: false,
      pauseCreditTransfers: false,
      allowOwnerMinting: false,
      allowSetCustomToken: false,
      allowTerminalMigration: false,
      allowSetTerminals: false,
      allowSetController: false,
      allowAddAccountingContext: false,
      allowAddPriceFeed: false,
      ownerMustSendPayouts: false,
      holdFees: false,
      useTotalSurplusForCashOuts: false,
      useDataHookForPay: false,
      useDataHookForCashOut: false,
      dataHook: zeroAddress,
      metadata: 0n,
    },
  }
}

const PROFILE = {
  name: 'Test project',
  tagline: '',
  description: '',
}

function exportDraft(args: Record<string, unknown> = {}) {
  return buildProjectDraftExport({
    client: client(),
    chainId: CHAIN,
    projectId: 7,
    isRevnet: true,
    profile: PROFILE,
    chains: [CHAIN],
    authorityByChain: { [CHAIN]: OWNER },
    ...args,
  } as Parameters<typeof buildProjectDraftExport>[0])
}

beforeEach(() => {
  mocks.getCurrentRuleset.mockReset()
  mocks.getUpcomingRuleset.mockReset()
  mocks.getAccountingContexts.mockReset()
  mocks.getTokenAddress.mockReset()
  mocks.getTokenAddress.mockResolvedValue(TOKEN)
  mocks.getUpcomingRuleset.mockResolvedValue(null)
  mocks.getAccountingContexts.mockResolvedValue([
    { token: NATIVE_TOKEN, decimals: 18, currency: 1 },
  ])
})

// bendystraw's project row carries the ACCOUNTING symbol; using it as the draft ticker
// re-launched a clone with an ERC-20 tickered after what the original was paid IN.
describe('ticker resolution', () => {
  it('reads the ticker from the project ERC-20, not the accounting symbol', async () => {
    mocks.getCurrentRuleset.mockResolvedValue(ruleset())

    const { draft, warnings } = await exportDraft()

    expect(draft.ticker).toBe('TEST')
    expect(warnings).toEqual([])
  })

  it('leaves the ticker blank and warns when no ERC-20 exists', async () => {
    mocks.getCurrentRuleset.mockResolvedValue(ruleset())
    mocks.getTokenAddress.mockResolvedValue(null)

    const { draft, warnings } = await exportDraft()

    expect(draft.ticker).toBe('')
    expect(warnings).toEqual([
      expect.stringContaining('no ERC-20 token yet'),
    ])
  })
})

describe('revnet issuance-cut cadence', () => {
  // A revnet encodes its cut cadence as the ruleset DURATION, but the create
  // flow re-encodes it from `cutFreqDays` and never reads `durationValue`.
  // Left at the new-stage default, a 90-day-cut revnet re-imported — and
  // relaunched — with 30-day cuts, immutably.
  it('writes cutFreqDays from the ruleset duration', async () => {
    mocks.getCurrentRuleset.mockResolvedValue(
      ruleset({ duration: BigInt(90 * DAY), weightCutPercent: 100_000_000n }),
    )

    const { draft, warnings } = await exportDraft()

    expect(draft.stages[0].cutOn).toBe(true)
    expect(draft.stages[0].cutFreqDays).toBe('90')
    expect(warnings).toEqual([])
  })

  it('leaves the cadence alone when the cut is off', async () => {
    mocks.getCurrentRuleset.mockResolvedValue(
      ruleset({ duration: BigInt(90 * DAY), weightCutPercent: 0n }),
    )

    const { draft } = await exportDraft()

    expect(draft.stages[0].cutOn).toBe(false)
    expect(draft.stages[0].cutFreqDays).toBe('30')
  })

  it('warns instead of rounding a cadence the editor cannot express', async () => {
    mocks.getCurrentRuleset.mockResolvedValue(
      ruleset({ duration: 3_600n, weightCutPercent: 100_000_000n }),
    )

    const { warnings } = await exportDraft()

    expect(warnings.join(' ')).toContain('whole days')
  })

  it('does not touch cutFreqDays for a plain project (duration is the cycle)', async () => {
    mocks.getCurrentRuleset.mockResolvedValue(
      ruleset({ duration: BigInt(7 * DAY), weightCutPercent: 100_000_000n }),
    )

    const { draft } = await exportDraft({ isRevnet: false })

    expect(draft.stages[0].durationValue).toBe(String(7 * DAY))
    expect(draft.stages[0].cutFreqDays).toBe('30')
  })
})

describe('queued rulesets the export cannot represent', () => {
  it('warns when another configuration is stored after the live one', async () => {
    mocks.getCurrentRuleset.mockResolvedValue(ruleset())
    mocks.getUpcomingRuleset.mockResolvedValue(ruleset({ id: 2n }))

    const { warnings } = await exportDraft()

    expect(warnings.join(' ')).toContain('queued after it')
  })

  it('stays quiet for an auto-cycling project that re-reports its own id', async () => {
    mocks.getCurrentRuleset.mockResolvedValue(
      ruleset({ duration: BigInt(7 * DAY) }),
    )
    mocks.getUpcomingRuleset.mockResolvedValue(
      ruleset({ id: 1n, duration: BigInt(7 * DAY) }),
    )

    const { warnings } = await exportDraft({ isRevnet: false })

    expect(warnings).toEqual([])
  })
})

describe('split lock round trip', () => {
  // The draft's lock is a `datetime-local` value — local wall clock in both
  // directions (CreateForm parses it with `new Date(value)`). Pin a west-of-UTC
  // zone, where a UTC-emitting export re-encodes a just-expired lock as
  // still-locked hours into the future.
  const originalTz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'America/Los_Angeles'
  })
  afterAll(() => {
    process.env.TZ = originalTz
  })

  // 2025-08-06T17:06:00Z — minute-aligned, since the input is minute-precise.
  const LOCKED_UNTIL = 1_754_499_960

  it('renders a reserved split lock as local wall clock, not UTC', async () => {
    const live = ruleset({ weightCutPercent: 0n })
    live.metadata.reservedPercent = 5_000n // rows only exist with a reserve
    mocks.getCurrentRuleset.mockResolvedValue(live)
    const locked = {
      percent: 500_000_000,
      projectId: 0n,
      beneficiary: RECIPIENT,
      preferAddToBalance: false,
      lockedUntil: LOCKED_UNTIL,
      hook: zeroAddress,
    }

    const { draft } = await exportDraft({
      client: client({ splitsOf: [locked] }),
    })

    const row = draft.stages[0].reservedSplits[0]
    expect(row.lockedUntil).toBe('2025-08-06T10:06')
    // …and the create flow's own parse gets the original timestamp back.
    expect(Math.floor(new Date(row.lockedUntil).getTime() / 1000)).toBe(
      LOCKED_UNTIL,
    )
  })
})
