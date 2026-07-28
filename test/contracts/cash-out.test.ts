import {
  DEFAULT_CASH_OUT_SLIPPAGE_BPS,
  cashOutProtocolFee,
  resolveCashOutRoute,
  slippageFloor,
  type CashOutRoute,
} from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, encodeFunctionData, type Address } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  buildCashOutRequest,
  cashOutPriceFromTotals,
  isNativeToken,
  minimumCashOutPriceAtIssuancePrice,
  minimumCashOutPriceFromTotals,
  shouldShowCashOutAsymptote,
} from '@/lib/cashOut'

const HOLDER = '0x1111111111111111111111111111111111111111' as Address
const TERMINAL = '0x2222222222222222222222222222222222222222' as Address
const TOKEN = '0x3333333333333333333333333333333333333333' as Address
const NATIVE = '0x000000000000000000000000000000000000eeee' as Address

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
