import {
  buyableAsset,
  defaultsToDollars,
  payButtonAction,
} from '@/lib/pay-choices'
import { describe, expect, it } from 'vitest'

describe('pay panel currency choice', () => {
  it('opens on dollars when the wallet holds none of the accepted tokens', () => {
    expect(defaultsToDollars({ isConnected: true, balances: [0n, 0n] })).toBe(
      true,
    )
  })

  it('leaves the default alone when any accepted token has a balance', () => {
    expect(defaultsToDollars({ isConnected: true, balances: [0n, 1n] })).toBe(
      false,
    )
  })

  it('waits for balances rather than guessing at an empty wallet', () => {
    // No balances read yet is not the same as no balance, and defaulting on it
    // would move the menu under a payer who is about to be shown a token they
    // do hold.
    expect(defaultsToDollars({ isConnected: true, balances: [] })).toBe(false)
  })

  it('says nothing about a visitor who has not signed in', () => {
    expect(defaultsToDollars({ isConnected: false, balances: [0n] })).toBe(false)
  })

  it('sends dollars to the purchase, and everything else to the payment', () => {
    expect(payButtonAction({ isConnected: false, payWithDollars: true })).toBe(
      'signIn',
    )
    expect(payButtonAction({ isConnected: true, payWithDollars: true })).toBe(
      'buyFirst',
    )
    expect(payButtonAction({ isConnected: true, payWithDollars: false })).toBe(
      'confirm',
    )
  })
})

describe('what a payer should buy to pay this project', () => {
  it('names the one asset the project accepts', () => {
    // "ETH or USDC" asks the payer to make a choice the project already made —
    // and on a USDC-only project it invites buying the half that cannot pay it.
    expect(buyableAsset({ accepted: ['USDC'] })).toBe('USDC')
    expect(buyableAsset({ accepted: ['ETH'] })).toBe('ETH')
  })

  it('follows the token already selected when the project takes both', () => {
    expect(
      buyableAsset({ accepted: ['ETH', 'USDC'], preferred: 'USDC' }),
    ).toBe('USDC')
    expect(buyableAsset({ accepted: ['ETH', 'USDC'], preferred: 'ETH' })).toBe(
      'ETH',
    )
  })

  it('ignores a selection the on-ramp cannot deliver', () => {
    expect(
      buyableAsset({ accepted: ['USDC', 'DAI'], preferred: 'DAI' }),
    ).toBe('USDC')
  })

  it('falls back to ETH rather than naming nothing', () => {
    expect(buyableAsset({ accepted: ['DAI'] })).toBe('ETH')
  })
})
