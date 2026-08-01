import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) =>
    createElement('img', { ...props, src: 'img', priority: undefined }),
}))
vi.mock('wagmi', () => ({
  useReadContract: () => ({ data: undefined }),
}))
vi.mock('@/hooks/useEnsName', () => ({
  useEnsName: () => ({ data: null }),
}))
vi.mock('@/hooks/useProjectTokenUnit', () => ({
  useProjectTokenUnit: () => 'tokens',
}))

import { activityParts, mergeActivityEvents } from '@/components/ActivityList'
import { ActivityMeta } from '@/components/ActivityMeta'
import {
  suckerGroupAccountingToken,
  type BsActivityEvent,
  type BsProject,
} from '@/lib/bendystraw'

function projectRow(overrides: Partial<BsProject>): BsProject {
  return {
    projectId: 2,
    chainId: 1,
    version: 6,
    name: 'P',
    logoUri: null,
    projectTagline: null,
    volume: '0',
    volumeUsd: '0',
    balance: '0',
    paymentsCount: 0,
    contributorsCount: 0,
    createdAt: 0,
    suckerGroupId: 'group',
    token: '0x1111111111111111111111111111111111111111',
    tokenSymbol: 'USDC',
    decimals: 6,
    currency: 1,
    isRevnet: false,
    owner: null,
    metadataUri: null,
    ...overrides,
  }
}

describe('live activity merging', () => {
  it('prepends newly indexed events without duplicating refreshed rows', () => {
    const old = { id: 'old' } as BsActivityEvent
    const refreshed = { id: 'old', timestamp: 2 } as BsActivityEvent
    const newest = { id: 'new' } as BsActivityEvent

    expect(mergeActivityEvents([old], [newest, refreshed])).toEqual([
      newest,
      refreshed,
    ])
  })
})

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const children = (node as { children?: unknown }).children
  return textOf(children ?? [])
}

function renderMetaText(
  props: Partial<Parameters<typeof ActivityMeta>[0]>,
): string {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <ActivityMeta
        chainId={1}
        txHash="0xabc"
        amountUsd={null}
        {...props}
      />,
    )
  })
  const text = textOf(renderer.toJSON())
  act(() => renderer.unmount())
  return text
}

describe('single accounting-token determination', () => {
  it('resolves the shared kind when every verified row agrees (6-dec case)', () => {
    const rows = [
      projectRow({ chainId: 1 }),
      // Canonical stablecoin deployments differ by address per chain; the
      // display kind is still the same.
      projectRow({
        chainId: 8453,
        token: '0x2222222222222222222222222222222222222222',
      }),
    ]
    expect(suckerGroupAccountingToken(rows)).toEqual({
      symbol: 'USDC',
      decimals: 6,
    })
  })

  it('returns null when chains account in different tokens', () => {
    const rows = [
      projectRow({ chainId: 1, tokenSymbol: 'ETH', decimals: 18 }),
      projectRow({ chainId: 8453, tokenSymbol: 'USDC', decimals: 6 }),
    ]
    expect(suckerGroupAccountingToken(rows)).toBeNull()
  })

  it('returns null when decimals disagree even if symbols match', () => {
    const rows = [
      projectRow({ chainId: 1, decimals: 6 }),
      projectRow({ chainId: 8453, decimals: 18 }),
    ]
    expect(suckerGroupAccountingToken(rows)).toBeNull()
  })

  it('returns null for unknown kinds and empty sets', () => {
    expect(suckerGroupAccountingToken([])).toBeNull()
    expect(
      suckerGroupAccountingToken([
        projectRow({ tokenSymbol: null }),
      ]),
    ).toBeNull()
    expect(
      suckerGroupAccountingToken([projectRow({ decimals: null })]),
    ).toBeNull()
  })
})

describe('ActivityMeta amount denomination', () => {
  it('renders the accounting-token amount with the context decimals', () => {
    const text = renderMetaText({
      amountToken: { raw: '1500000', symbol: 'USDC', decimals: 6 },
      amountUsd: '99000000000000000000',
    })
    expect(text).toContain('1.5 USDC')
    expect(text).not.toContain('$')
  })

  it('keeps the USD rendering when no single accounting token exists', () => {
    const text = renderMetaText({
      amountToken: null,
      amountUsd: '12000000000000000000',
    })
    expect(text).toContain('$12.00')
  })

  it('shows no amount for zero or missing raw amounts in token mode', () => {
    expect(
      renderMetaText({
        amountToken: { raw: '0', symbol: 'USDC', decimals: 6 },
        amountUsd: '12000000000000000000',
      }),
    ).not.toContain('USDC')
    expect(
      renderMetaText({
        amountToken: { raw: null, symbol: 'USDC', decimals: 6 },
        amountUsd: '12000000000000000000',
      }),
    ).not.toContain('$')
  })
})

describe('activityParts raw amounts', () => {
  const base = {
    id: 'e',
    chainId: 1,
    projectId: 2,
    timestamp: 1700000000,
    txHash: '0xabc',
    from: '0xf00',
  }

  it('surfaces the raw pay amount alongside the USD amount', () => {
    const parts = activityParts(
      {
        ...base,
        payEvent: {
          amount: '2500000',
          amountUsd: '2500000000000000000',
          beneficiary: '0xb',
          memo: null,
          newlyIssuedTokenCount: '0',
        },
      } as BsActivityEvent,
      'tokens',
    )
    expect(parts.amountRaw).toBe('2500000')
    expect(parts.amountUsd).toBe('2500000000000000000')
  })

  it('surfaces cash-out reclaim and payout amounts', () => {
    const cashOut = activityParts(
      {
        ...base,
        cashOutTokensEvent: {
          cashOutCount: '1000000000000000000',
          reclaimAmount: '750000',
          reclaimAmountUsd: '750000000000000000',
          beneficiary: '0xb',
        },
      } as BsActivityEvent,
      'tokens',
    )
    expect(cashOut.amountRaw).toBe('750000')

    const payouts = activityParts(
      {
        ...base,
        sendPayoutsEvent: {
          amount: '9',
          amountPaidOut: '4200000',
          amountPaidOutUsd: '4200000000000000000',
          caller: '0xc',
          from: '0xf00',
        },
      } as BsActivityEvent,
      'tokens',
    )
    expect(payouts.amountRaw).toBe('4200000')
  })
})
