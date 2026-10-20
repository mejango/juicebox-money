import { describe, expect, it } from 'vitest'
import { activityAmountToken, combinedActivityParts, feedAmountToken } from '@/components/ActivityList'
import type { BsActivityEvent } from '@/lib/bendystraw'

const ETH = '0x000000000000000000000000000000000000eeee'
const USDC = { symbol: 'USDC', decimals: 6 }

function pay(id: string, token: string | null, decimals: number | null, amount = '100000000000000', tokenSymbol: string | null = null): BsActivityEvent {
  return {
    id,
    chainId: 1,
    projectId: 12,
    timestamp: 1,
    from: '0xpayer',
    txHash: '0xtx',
    payEvent: { amount, amountUsd: '0', beneficiary: '0xpayer', memo: null, newlyIssuedTokenCount: '0', token, decimals, tokenSymbol },
    cashOutTokensEvent: null,
  }
}

const label = (group: BsActivityEvent[]) => {
  const parts = combinedActivityParts(group, 'tokens')
  return activityAmountToken(parts.amountRaw, parts.amountAsset, USDC, 1)
}

describe('activity amounts use each event’s own token', () => {
  // eth:12 accepts ETH then USDC; its 0.0001 ETH pay once read "100,000,000 USDC".
  it('labels an ETH pay as ETH on a project whose accounting token is USDC', () => {
    expect(label([pay('a', ETH, 18)])).toEqual({ raw: '100000000000000', symbol: 'ETH', decimals: 18 })
  })

  it('drops to USD for an unresolved or unknown token, never the project’s', () => {
    expect(label([pay('a', null, null)])).toBeNull()
    expect(label([pay('a', '0x00000000000000000000000000000000000000aa', 18)])).toBeNull()
    expect(label([pay('a', null, null, '1', 'DAI')])).toBeNull()
  })

  it('labels any token with the symbol the indexer read', () => {
    const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f'
    expect(label([pay('a', DAI, 18, '1', 'DAI')])).toEqual({ raw: '1', symbol: 'DAI', decimals: 18 })
    expect(label([pay('a', DAI, 18, '1', '$DAI')])).toEqual({ raw: '1', symbol: 'DAI', decimals: 18 })
    expect(label([pay('a', DAI, 18, '1', 'DAI'), pay('b', DAI, 18, '2', 'DAI')])).toEqual({ raw: '3', symbol: 'DAI', decimals: 18 })
  })

  it('sums a fan-out only when every pay shares a token', () => {
    expect(label([pay('a', ETH, 18, '1'), pay('b', ETH, 18, '2')])).toEqual({ raw: '3', symbol: 'ETH', decimals: 18 })
    expect(label([pay('a', ETH, 18, '1'), pay('b', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, '2')])).toBeNull()
  })
})

describe('activity amounts on a project that accepts several tokens', () => {
  it('still labels an event in its own token with no shared accounting token', () => {
    const parts = combinedActivityParts([pay('a', ETH, 18, '1', 'ETH')], 'tokens')
    expect(activityAmountToken(parts.amountRaw, parts.amountAsset, null, 1)).toEqual({ raw: '1', symbol: 'ETH', decimals: 18 })
  })

  it('falls back to the addition’s USD value when its token is unresolved', () => {
    const event: BsActivityEvent = {
      ...pay('a', null, null),
      payEvent: null,
      addToBalanceEvent: { amount: '5', amountUsd: '5000000000000000000', from: '0xpayer', memo: null, token: null, decimals: null, tokenSymbol: null },
    }
    const parts = combinedActivityParts([event], 'tokens')
    expect(activityAmountToken(parts.amountRaw, parts.amountAsset, null, 1)).toBeNull()
    expect(parts.amountUsd).toBe('5000000000000000000')
  })
})

describe('cross-project feeds show the event’s own token over USD', () => {
  const project = { tokenSymbol: 'USDC', decimals: 6 }
  const feed = (event: BsActivityEvent) => feedAmountToken(combinedActivityParts([event], 'tokens'), project, 1)
  const priced = (event: BsActivityEvent) => ({ ...event, payEvent: { ...event.payEvent!, amountUsd: '250000000000000000' } })

  it('labels a priced ETH pay in ETH, not USD', () => {
    expect(feed(priced(pay('a', ETH, 18)))).toEqual({ raw: '100000000000000', symbol: 'ETH', decimals: 18 })
  })

  it('drops to USD for an unknown token', () => {
    expect(feed(priced(pay('a', '0x00000000000000000000000000000000000000aa', 18)))).toBeNull()
  })

  it('uses the project token for an amount with no token field only when it has no USD value', () => {
    const swap = { amountRaw: '5000000', amountAsset: undefined, amountUsd: undefined }
    expect(feedAmountToken(swap, project, 1)).toEqual({ raw: '5000000', symbol: 'USDC', decimals: 6 })
    expect(feedAmountToken({ ...swap, amountUsd: '5000000000000000000' }, project, 1)).toBeNull()
  })
})
