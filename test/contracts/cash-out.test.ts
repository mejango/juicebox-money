import type { CashOutQuote } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, encodeFunctionData, type Address } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  buildCashOutRequest,
  cashOutPriceFromTotals,
  cashOutProtocolFee,
  isNativeToken,
  minReclaimedFloor,
  minimumCashOutPriceAtIssuancePrice,
  minimumCashOutPriceFromTotals,
  quotedOutputFloor,
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

  it('recognizes the protocol native-token sentinel case-insensitively', () => {
    expect(isNativeToken(NATIVE)).toBe(true)
    expect(isNativeToken(NATIVE.toUpperCase())).toBe(true)
    expect(isNativeToken(TOKEN)).toBe(false)
  })

  it('uses integer floors for the displayed and submitted minimum', () => {
    const quote: CashOutQuote = {
      reclaimAmount: 10_257n,
      reclaimAmountAfterFee: 10_001n,
    }

    expect(minReclaimedFloor(quote)).toBe(9_750n)
    expect(quotedOutputFloor(10_001n)).toBe(9_900n)
    expect(quotedOutputFloor(1n)).toBe(1n)
    expect(quotedOutputFloor(0n)).toBe(0n)
  })

  it('matches the protocol fee branches, including conservative unknown reads', () => {
    expect(
      cashOutProtocolFee({
        reclaimAmount: 4_000n,
        cashOutTaxRate: 5_000n,
        feeless: false,
        feeFreeSurplus: 1_000n,
      }),
    ).toBe(100n)
    expect(
      cashOutProtocolFee({
        reclaimAmount: 4_000n,
        cashOutTaxRate: 0n,
        feeless: false,
        feeFreeSurplus: 1_000n,
      }),
    ).toBe(25n)
    expect(
      cashOutProtocolFee({
        reclaimAmount: 4_000n,
        cashOutTaxRate: 0n,
        feeless: true,
        feeFreeSurplus: 4_000n,
      }),
    ).toBe(0n)
    expect(
      cashOutProtocolFee({
        reclaimAmount: 4_000n,
        cashOutTaxRate: 0n,
        feeless: null,
        feeFreeSurplus: null,
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
  it('round-trips the exact holder, token, beneficiary, count, and minimum', () => {
    const request = buildCashOutRequest({
      chainId: 1,
      terminal: TERMINAL,
      holder: HOLDER,
      projectId: 42n,
      cashOutCount: 3n * 10n ** 18n,
      tokenToReclaim: TOKEN,
      quote: { reclaimAmount: 10_000n, reclaimAmountAfterFee: 9_750n },
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
      9_506n,
      HOLDER,
      '0x',
    ])
  })

  it('fails closed instead of sending a zero minimum', () => {
    expect(() =>
      buildCashOutRequest({
        chainId: 1,
        terminal: TERMINAL,
        holder: HOLDER,
        projectId: 42n,
        cashOutCount: 1n,
        tokenToReclaim: TOKEN,
        quote: { reclaimAmount: 0n, reclaimAmountAfterFee: 0n },
        beneficiary: HOLDER,
      }),
    ).toThrow(/Nothing to reclaim/)
  })
})
