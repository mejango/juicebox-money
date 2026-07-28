import {
  DEFAULT_CASH_OUT_SLIPPAGE_BPS,
  cashOutProtocolFee,
  resolveCashOutRoute,
  slippageFloor,
  type CashOutRoute,
  type JBAccountingContext,
} from '@bananapus/nana-sdk-core/v6'
import {
  decodeFunctionData,
  encodeFunctionData,
  type Address,
  type PublicClient,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAccountingContexts: vi.fn(),
  getCashOutQuote: vi.fn(),
}))

vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => {
  const original = await importOriginal<
    typeof import('@bananapus/nana-sdk-core/v6')
  >()
  return {
    ...original,
    getAccountingContexts: mocks.getAccountingContexts,
    getCashOutQuote: mocks.getCashOutQuote,
  }
})

import {
  buildCashOutRequest,
  cashOutPriceFromTotals,
  getCashOutContext,
  getContextCashOutQuote,
  isNativeToken,
  minimumCashOutPriceAtIssuancePrice,
  minimumCashOutPriceFromTotals,
  netOfCashOutFee,
  shouldShowCashOutAsymptote,
} from '@/lib/cashOut'

const HOLDER = '0x1111111111111111111111111111111111111111' as Address
const TERMINAL = '0x2222222222222222222222222222222222222222' as Address
const TOKEN = '0x3333333333333333333333333333333333333333' as Address
const NATIVE = '0x000000000000000000000000000000000000eeee' as Address
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address

// The reads only ever forward this client through to the SDK, so a sentinel
// proves it is passed straight down without being rebuilt.
const CLIENT = { __sentinel: 'public-client' } as unknown as PublicClient

describe('cash-out arithmetic', () => {
  it('derives the payment asymptote from issuance price and tax', () => {
    expect(minimumCashOutPriceAtIssuancePrice(0.0001, 4_000)).toBeCloseTo(
      0.00006,
      12,
    )
  })

  it('shows the payment asymptote only when the live quote can fall toward it', () => {
    expect(shouldShowCashOutAsymptote(0.000066, 0.00006)).toBe(true)
    expect(shouldShowCashOutAsymptote(0.00006, 0.00006)).toBe(false)
    expect(shouldShowCashOutAsymptote(0.000009, 0.00144)).toBe(false)
  })

  it('recognizes the protocol native-token sentinel case-insensitively', () => {
    expect(isNativeToken(NATIVE)).toBe(true)
    expect(isNativeToken(NATIVE.toUpperCase())).toBe(true)
    expect(isNativeToken(TOKEN)).toBe(false)
  })

  it('keeps the cross-client 1% default and its integer floors', () => {
    expect(DEFAULT_CASH_OUT_SLIPPAGE_BPS).toBe(100n)
    expect(slippageFloor(10_001n)).toBe(9_900n)
    expect(slippageFloor(1n)).toBe(1n)
    expect(slippageFloor(0n)).toBe(0n)
  })

  it('matches the exact /40 protocol fee branches the UI relies on', () => {
    expect(
      cashOutProtocolFee({
        reclaimAmount: 4_000n,
        cashOutTaxRate: 5_000n,
        feeFreeSurplus: 1_000n,
      }),
    ).toBe(100n)
    expect(
      cashOutProtocolFee({
        reclaimAmount: 4_000n,
        cashOutTaxRate: 0n,
        feeFreeSurplus: 1_000n,
      }),
    ).toBe(25n)
    expect(
      cashOutProtocolFee({
        reclaimAmount: 4_000n,
        cashOutTaxRate: 0n,
        beneficiaryIsFeeless: true,
        feeFreeSurplus: 4_000n,
      }),
    ).toBe(0n)
    // Unknown surplus reads pass the full reclaim as feeable (conservative).
    expect(
      cashOutProtocolFee({
        reclaimAmount: 4_000n,
        cashOutTaxRate: 0n,
        feeFreeSurplus: 4_000n,
      }),
    ).toBe(100n)
  })

  it('nets an ambient reclaim quote of the exact terminal fee', () => {
    // Non-zero tax: the 2.5% fee applies to the full reclaim, floor division.
    expect(
      netOfCashOutFee({
        gross: 4_001n,
        cashOutTaxRate: 5_000n,
        feeFreeSurplus: 0n,
      }),
    ).toBe(3_901n)
    // Zero tax: the fee applies only up to the fee-free surplus.
    expect(
      netOfCashOutFee({
        gross: 4_000n,
        cashOutTaxRate: 0n,
        feeFreeSurplus: 1_000n,
      }),
    ).toBe(3_975n)
    // Zero tax with the whole reclaim fee-free-covered: full fee.
    expect(
      netOfCashOutFee({
        gross: 4_000n,
        cashOutTaxRate: 0n,
        feeFreeSurplus: 4_000n,
      }),
    ).toBe(3_900n)
    expect(
      netOfCashOutFee({ gross: 0n, cashOutTaxRate: 0n, feeFreeSurplus: 0n }),
    ).toBe(0n)
  })

  it('derives the expected one-token price without floating-point inputs', () => {
    const one = 10n ** 18n
    expect(
      cashOutPriceFromTotals({
        balance: 100n * one,
        tokenSupply: 100n * one,
        cashOutTaxRate: 0,
        balanceDecimals: 18,
      }),
    ).toBe(1)
    expect(
      cashOutPriceFromTotals({
        balance: 100n * one,
        tokenSupply: 100n * one,
        cashOutTaxRate: 10_000,
        balanceDecimals: 18,
      }),
    ).toBe(0.01)
    expect(
      cashOutPriceFromTotals({
        balance: 0n,
        tokenSupply: 100n * one,
        cashOutTaxRate: 0,
        balanceDecimals: 18,
      }),
    ).toBeNull()
  })

  it('returns null rather than a bogus price when the curve underflows or overflows', () => {
    const one = 10n ** 18n
    // A dust balance against an enormous supply floors to zero inside the
    // integer curve; a zero price must not be reported as a real quote.
    expect(
      cashOutPriceFromTotals({
        balance: 1n,
        tokenSupply: 10n ** 30n,
        cashOutTaxRate: 0,
        balanceDecimals: 18,
      }),
    ).toBeNull()
    // A balance far past Number's range would format to Infinity, which would
    // poison every downstream chart axis. Guarded to null instead.
    expect(
      cashOutPriceFromTotals({
        balance: 10n ** 400n,
        tokenSupply: one,
        cashOutTaxRate: 0,
        balanceDecimals: 0,
      }),
    ).toBeNull()
    expect(
      minimumCashOutPriceFromTotals({
        balance: 10n ** 400n,
        tokenSupply: one,
        cashOutTaxRate: 0,
        balanceDecimals: 0,
      }),
    ).toBeNull()
  })

  it('has no cash-out price for an empty treasury or a supply-less project', () => {
    const one = 10n ** 18n
    expect(
      minimumCashOutPriceFromTotals({
        balance: 0n,
        tokenSupply: 100n * one,
        cashOutTaxRate: 2_000,
        balanceDecimals: 18,
      }),
    ).toBeNull()
    expect(
      minimumCashOutPriceFromTotals({
        balance: 100n * one,
        tokenSupply: 0n,
        cashOutTaxRate: 2_000,
        balanceDecimals: 18,
      }),
    ).toBeNull()
    expect(
      cashOutPriceFromTotals({
        balance: 100n * one,
        tokenSupply: 0n,
        cashOutTaxRate: 2_000,
        balanceDecimals: 18,
      }),
    ).toBeNull()
  })

  it('has no payment asymptote without a usable issuance price', () => {
    expect(minimumCashOutPriceAtIssuancePrice(0, 4_000)).toBeNull()
    expect(minimumCashOutPriceAtIssuancePrice(-1, 4_000)).toBeNull()
    expect(minimumCashOutPriceAtIssuancePrice(Number.NaN, 4_000)).toBeNull()
    expect(
      minimumCashOutPriceAtIssuancePrice(Number.POSITIVE_INFINITY, 4_000),
    ).toBeNull()
  })

  it('derives the asymptotic minimum cash-out price', () => {
    const one = 10n ** 18n
    expect(
      minimumCashOutPriceFromTotals({
        balance: 100n * one,
        tokenSupply: 100n * one,
        cashOutTaxRate: 2_000,
        balanceDecimals: 18,
      }),
    ).toBe(0.8)
    expect(
      minimumCashOutPriceFromTotals({
        balance: 100n * one,
        tokenSupply: 100n * one,
        cashOutTaxRate: 10_000,
        balanceDecimals: 18,
      }),
    ).toBeNull()
  })
})

describe('cash-out accounting context reads', () => {
  const usdcContext: JBAccountingContext = {
    token: USDC,
    decimals: 6,
    currency: 3_181_390_099,
  }
  const nativeContext: JBAccountingContext = {
    token: NATIVE,
    decimals: 18,
    currency: 61_166,
  }

  it('takes the first registered context as the accounting token, not native', async () => {
    mocks.getAccountingContexts.mockResolvedValue([usdcContext, nativeContext])

    await expect(
      getCashOutContext(CLIENT, { chainId: 8453, projectId: 42n }),
    ).resolves.toEqual(usdcContext)
    expect(mocks.getAccountingContexts).toHaveBeenCalledWith(CLIENT, {
      chainId: 8453,
      projectId: 42n,
    })
  })

  it('reports no context for a project with no registered terminal token', async () => {
    mocks.getAccountingContexts.mockResolvedValue([])

    await expect(
      getCashOutContext(CLIENT, { chainId: 1, projectId: 7n }),
    ).resolves.toBeNull()
  })

  it('quotes in the context own decimals and token-keyed currency', async () => {
    const quote = { reclaimAmount: 10_000n, reclaimAmountAfterFee: 9_750n }
    mocks.getCashOutQuote.mockResolvedValue(quote)

    await expect(
      getContextCashOutQuote(CLIENT, {
        chainId: 8453,
        projectId: 42n,
        cashOutCount: 3n * 10n ** 18n,
        context: usdcContext,
      }),
    ).resolves.toBe(quote)
    // A 6-decimal accounting token must be quoted at 6 decimals in its own
    // token-keyed currency, or the read silently converts through a price feed.
    expect(mocks.getCashOutQuote).toHaveBeenCalledWith(CLIENT, {
      chainId: 8453,
      projectId: 42n,
      cashOutCount: 3n * 10n ** 18n,
      decimals: 6n,
      currency: 3_181_390_099n,
    })
  })

  it('propagates a failed context read instead of quoting against a default', async () => {
    mocks.getAccountingContexts.mockRejectedValue(new Error('rpc down'))

    await expect(
      getCashOutContext(CLIENT, { chainId: 1, projectId: 7n }),
    ).rejects.toThrow(/rpc down/)
  })
})

describe('cash-out transaction request', () => {
  it('round-trips the treasury route: exact fee, 1% floor, empty metadata', () => {
    const route = resolveCashOutRoute({
      reclaimAmount: 10_000n,
      cashOutTaxRate: 5_000n,
      hookSpecifications: [],
    })
    expect(route.route).toBe('treasury')
    expect(route.treasuryProtocolFee).toBe(250n)
    expect(route.expectedReturn).toBe(9_750n)

    const request = buildCashOutRequest({
      chainId: 1,
      terminal: TERMINAL,
      holder: HOLDER,
      projectId: 42n,
      cashOutCount: 3n * 10n ** 18n,
      tokenToReclaim: TOKEN,
      route,
      beneficiary: HOLDER,
    })
    const data = encodeFunctionData(request)
    const decoded = decodeFunctionData({ abi: request.abi, data })

    expect(data.slice(0, 10)).toBe('0x13da8317')
    expect(decoded.functionName).toBe('cashOutTokensOf')
    expect(decoded.args).toEqual([
      HOLDER,
      42n,
      3n * 10n ** 18n,
      TOKEN,
      9_652n,
      HOLDER,
      '0x',
    ])
  })

  it('keeps a zero terminal minimum and the metadata floor on the amm route', () => {
    const route: CashOutRoute = {
      route: 'amm',
      expectedReturn: 12_000n,
      minimumReturn: 11_880n,
      terminalMinimum: 0n,
      metadata: '0xabcdef',
      treasuryGross: 10_000n,
      treasuryProtocolFee: 250n,
      treasuryNet: 9_750n,
      buyback: null,
    }
    const request = buildCashOutRequest({
      chainId: 1,
      terminal: TERMINAL,
      holder: HOLDER,
      projectId: 42n,
      cashOutCount: 3n * 10n ** 18n,
      tokenToReclaim: TOKEN,
      route,
      beneficiary: HOLDER,
    })
    expect(request.args[4]).toBe(0n)
    expect(request.args[6]).toBe('0xabcdef')
  })

  it('fails closed instead of sending an unprotected request', () => {
    expect(() =>
      buildCashOutRequest({
        chainId: 1,
        terminal: TERMINAL,
        holder: HOLDER,
        projectId: 42n,
        cashOutCount: 1n,
        tokenToReclaim: TOKEN,
        route: resolveCashOutRoute({
          reclaimAmount: 0n,
          cashOutTaxRate: 5_000n,
          hookSpecifications: [],
        }),
        beneficiary: HOLDER,
      }),
    ).toThrow(/Nothing to reclaim/)
  })
})
