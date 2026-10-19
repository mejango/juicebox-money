import { describe, expect, it } from 'vitest'
import { activityAmountToken, combinedActivityParts } from '@/components/ActivityList'
import type { BsActivityEvent } from '@/lib/bendystraw'

const ETH = '0x000000000000000000000000000000000000eeee'
const USDC = { symbol: 'USDC', decimals: 6 }

function pay(id: string, token: string | null, decimals: number | null, amount = '100000000000000'): BsActivityEvent {
  return {
    id,
    chainId: 1,
    projectId: 12,
    timestamp: 1,
    from: '0xpayer',
    txHash: '0xtx',
    payEvent: { amount, amountUsd: '0', beneficiary: '0xpayer', memo: null, newlyIssuedTokenCount: '0', token, decimals },
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
  })

  it('sums a fan-out only when every pay shares a token', () => {
    expect(label([pay('a', ETH, 18, '1'), pay('b', ETH, 18, '2')])).toEqual({ raw: '3', symbol: 'ETH', decimals: 18 })
    expect(label([pay('a', ETH, 18, '1'), pay('b', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, '2')])).toBeNull()
  })
})
