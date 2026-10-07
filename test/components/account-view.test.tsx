import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { Address } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectedAddress: undefined as string | undefined,
  push: vi.fn(),
  lookupEnsAddress: vi.fn(),
  getAccountActivity: vi.fn(),
  getProjectsOwnedBy: vi.fn(),
  fetchRelayrBundlesByAccount: vi.fn(),
  resumeRelayrSession: vi.fn(),
  discardRelayrSession: vi.fn(),
  safeService: vi.fn(),
  readAuthorityIdentity: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: Record<string, unknown>) =>
    createElement('a', { href, ...props }, children as never),
}))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) =>
    createElement('img', { ...props, src: 'img', priority: undefined }),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}))
vi.mock('wagmi', () => ({
  useReadContract: () => ({ data: undefined }),
  useAccount: () => ({ address: mocks.connectedAddress }),
}))
vi.mock('@/hooks/useEnsName', () => ({
  useEnsName: () => ({ data: null }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    isConnected: !!mocks.connectedAddress,
    address: mocks.connectedAddress,
  }),
}))
vi.mock('@/lib/ens', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/ens')>()
  return { ...original, lookupEnsAddress: mocks.lookupEnsAddress }
})
vi.mock('@/lib/bendystraw', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/bendystraw')>()
  return {
    ...original,
    getAccountActivity: mocks.getAccountActivity,
    getProjectsOwnedBy: mocks.getProjectsOwnedBy,
  }
})
vi.mock('@/lib/relayr', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/relayr')>()),
  fetchRelayrBundlesByAccount: mocks.fetchRelayrBundlesByAccount,
  resumeRelayrSession: mocks.resumeRelayrSession,
  discardRelayrSession: mocks.discardRelayrSession,
}))
vi.mock('@/lib/safe', () => ({
  SAFE_SERVICE: { fetch: mocks.safeService },
}))
vi.mock('@bananapus/nana-sdk-core/safe', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/safe')>()),
  readAuthorityIdentity: mocks.readAuthorityIdentity,
}))
vi.mock('@/lib/wallet-core', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/wallet-core')>()),
  publicClient: (chainId: number) => ({ chain: { id: chainId } }),
}))
vi.mock('@/providers/Providers', () => ({
  wagmiConfig: {},
  SUPPORTED_CHAINS: [
    { id: 1, name: 'Ethereum' },
    { id: 421614, name: 'Arbitrum Sepolia' },
  ],
}))

import { AccountActivity } from '@/components/account/AccountActivity'
import { AccountHeader } from '@/components/account/AccountHeader'
import {
  AccountShopHoldings,
  AccountTokenHoldings,
  groupNftHoldings,
  groupTokenHoldings,
} from '@/components/account/AccountHoldings'
import { AccountTabs } from '@/components/account/AccountTabs'
import {
  AccountOperatedProjects,
  groupOperatorGrants,
} from '@/components/account/AccountOperatedProjects'
import {
  AccountPendingRelayr,
  sessionLegs,
} from '@/components/account/AccountPendingRelayr'
import {
  AccountSafeProjects,
  dedupeSafeProjects,
} from '@/components/account/AccountSafeProjects'
import { RelayrDiscardError } from '@/lib/relayr'
import type {
  BsAccountActivityEvent,
  BsAccountNft,
  BsAccountTokenHolding,
  BsOperatorGrant,
  BsProject,
} from '@/lib/bendystraw'
import type { RelayrPendingSession } from '@/lib/relayr'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const SAFE = '0x4444444444444444444444444444444444444444' as Address

function renderedText(instance: ReactTestInstance): string {
  return instance.children
    .map(child =>
      typeof child === 'string'
        ? child
        : typeof child === 'number'
          ? String(child)
          : renderedText(child),
    )
    .join('')
}

function buttonWith(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return renderer.root
    .findAllByType('button')
    .find(button => renderedText(button).includes(text))!
}

function activityEvent(
  overrides: Partial<BsAccountActivityEvent>,
): BsAccountActivityEvent {
  return {
    id: 'event-1',
    chainId: 1,
    projectId: 2,
    timestamp: Math.floor(Date.now() / 1000) - 120,
    from: ALICE,
    txHash: `0x${'11'.repeat(32)}`,
    version: 6,
    project: { name: 'Juicebox', logoUri: null, tokenSymbol: 'ETH', decimals: 18 },
    payEvent: null,
    cashOutTokensEvent: null,
    ...overrides,
  }
}

function project(overrides: Partial<BsProject>): BsProject {
  return {
    projectId: 7,
    chainId: 1,
    version: 6,
    name: 'Safe project',
    logoUri: null,
    projectTagline: null,
    volume: '0',
    volumeUsd: '0',
    balance: '0',
    paymentsCount: 0,
    contributorsCount: 0,
    createdAt: 0,
    suckerGroupId: null,
    token: null,
    tokenSymbol: null,
    decimals: 18,
    currency: null,
    isRevnet: false,
    owner: SAFE.toLowerCase(),
    metadataUri: null,
    ...overrides,
  }
}

function pendingSession(
  overrides: Partial<RelayrPendingSession> = {},
): RelayrPendingSession {
  return {
    bundleUuid: 'bundle-1',
    paymentHash: null,
    paymentChainId: 1,
    paymentStatus: 'confirmed',
    chainIds: [1, 10],
    expectedCount: 2,
    records: [{ chain: 1, status: { state: 'success' } }],
    itemCount: 2,
    account: ALICE,
    // Use a live signature deadline unless the test explicitly exercises expiry.
    createdAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  mocks.connectedAddress = undefined
  mocks.fetchRelayrBundlesByAccount.mockResolvedValue([])
  mocks.safeService.mockImplementation(async () => new Response(JSON.stringify({ safes: [] })))
  mocks.getProjectsOwnedBy.mockResolvedValue([])
  mocks.readAuthorityIdentity.mockResolvedValue(null)
})

describe('AccountActivity', () => {
  it('stops a page it is loading when the list is left', async () => {
    let loading: AbortSignal | undefined
    mocks.getAccountActivity.mockImplementation((_address: string, { signal }: { signal: AbortSignal }) => {
      loading = signal
      return new Promise(() => {})
    })
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountActivity, { address: ALICE, initialEvents: [activityEvent({ id: 'pay' })], totalCount: 3 }),
      )
    })
    // The page never answers: the click's own promise is left pending.
    await act(async () => { void buttonWith(renderer, 'Load more').props.onClick() })
    expect(loading?.aborted).toBe(false)

    await act(async () => renderer.unmount())
    expect(loading?.aborted).toBe(true)
  })

  it('renders interpreted rows and loads the next page on demand', async () => {
    const first = activityEvent({
      id: 'pay',
      payEvent: {
        amount: '1',
        amountUsd: null,
        beneficiary: ALICE,
        memo: 'thanks',
        newlyIssuedTokenCount: (10n ** 18n).toString(),
      },
    })
    const second = activityEvent({
      id: 'create',
      version: 4,
      project: { name: 'Old project', logoUri: null, tokenSymbol: null, decimals: 18 },
      projectCreateEvent: { from: ALICE },
    })
    mocks.getAccountActivity.mockResolvedValue({
      items: [
        activityEvent({
          id: 'deploy',
          project: { name: 'Third', logoUri: null, tokenSymbol: null, decimals: 18 },
          deployErc20Event: { symbol: 'JBX', name: 'Juicebox', token: BOB, from: ALICE },
        }),
      ],
      totalCount: 3,
    })

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountActivity, {
          address: ALICE,
          initialEvents: [first, second],
          totalCount: 3,
        }),
      )
    })

    const text = renderedText(renderer.root)
    expect(text).toContain('Juicebox')
    expect(text).toContain('bought')
    expect(text).toContain('created the project')
    expect(text).toContain('thanks')
    // Non-V6 rows are labeled but not linked into this V6-only site.
    expect(text).toContain('Old project')
    expect(text).toContain('V4')

    await act(async () => buttonWith(renderer, 'Load more').props.onClick())

    expect(mocks.getAccountActivity).toHaveBeenCalledWith(ALICE, {
      limit: 25,
      offset: 2,
      signal: expect.any(AbortSignal),
    })
    expect(renderedText(renderer.root)).toContain('deployed token $JBX')
    // All three rows are present; the load-more affordance is gone.
    expect(
      renderer.root.findAllByType('button').filter(button =>
        renderedText(button).includes('Load more'),
      ),
    ).toHaveLength(0)
  })

  it('shows the empty state without rows', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountActivity, {
          address: ALICE,
          initialEvents: [],
          totalCount: 0,
        }),
      )
    })
    expect(renderedText(renderer.root)).toContain('No onchain activity')
  })

  it('continues loading beyond the former 1000-event window', async () => {
    const events = Array.from({ length: 1000 }, (_, index) =>
      activityEvent({ id: `event-${index}` }),
    )
    mocks.getAccountActivity.mockResolvedValue({
      items: Array.from({ length: 25 }, (_, index) =>
        activityEvent({ id: `event-${1000 + index}` }),
      ),
      totalCount: 1500,
    })
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountActivity, {
          address: ALICE,
          initialEvents: events,
          totalCount: 1500,
        }),
      )
    })
    const loadMore = buttonWith(renderer, 'Load more')
    await act(async () => loadMore.props.onClick())
    expect(mocks.getAccountActivity).toHaveBeenCalledWith(ALICE, {
      limit: 25,
      offset: 1000,
      signal: expect.any(AbortSignal),
    })
    expect(renderedText(renderer.root)).toContain('1025 of 1500')
  })
})

describe('AccountHeader view-as', () => {
  it('toggles site-wide view-as mode for this account', async () => {
    const { clearViewAs, getViewAs } = await import('@/lib/viewAs')
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountHeader, { address: ALICE, ensName: null }),
      )
    })
    const findToggle = () =>
      renderer.root.findAll(
        node =>
          node.type === 'button' &&
          ['View site as this account', 'Exit View as'].includes(
            node.children.join(''),
          ),
      )[0]

    expect(findToggle().children.join('')).toBe('View site as this account')
    await act(async () => findToggle().props.onClick())
    expect(getViewAs()).toBe(ALICE)
    expect(findToggle().children.join('')).toBe('Exit View as')

    await act(async () => findToggle().props.onClick())
    expect(getViewAs()).toBeNull()
    clearViewAs()
  })


})

describe('AccountPendingRelayr', () => {
  it('renders an older recovery error without changing its diagnostics or saved payment evidence', async () => {
    mocks.connectedAddress = ALICE
    const session = pendingSession()
    const original = JSON.stringify(session)
    const cause = { bundleUuid: session.bundleUuid, paymentHash: session.paymentHash }
    const failure = new Error('Your wallet may have sent the Relayr payment without returning its hash. Check the saved bundle; do not pay again.', { cause })
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([{ scope: 'authority:0xaaa', session }])
    mocks.resumeRelayrSession.mockRejectedValueOnce(failure)
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = TestRenderer.create(createElement(AccountPendingRelayr, { address: ALICE })) })
    await act(async () => buttonWith(renderer, 'Check original bundle').props.onClick())
    const text = renderedText(renderer.root)
    expect(text).toContain('Your wallet may have sent the payment without returning its hash. Check the saved bundle; do not pay again.')
    expect(text).not.toMatch(/Relayr|Nothing was paid/i)
    expect(failure.message).toContain('Relayr payment')
    expect(failure.cause).toBe(cause)
    expect(JSON.stringify(session)).toBe(original)
    expect(mocks.resumeRelayrSession).toHaveBeenCalledExactlyOnceWith({ scope: 'authority:0xaaa', account: ALICE })
    await act(async () => renderer.unmount())
  })

  it('stays hidden for viewers who are not the account', async () => {
    mocks.connectedAddress = BOB
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([
      { scope: 'authority:0xaaa', session: pendingSession() },
    ])
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountPendingRelayr, { address: ALICE }),
      )
    })
    expect(renderer.toJSON()).toBeNull()
    expect(mocks.fetchRelayrBundlesByAccount).not.toHaveBeenCalled()
  })

  it('still reconciles the original receipts after signature expiry', async () => {
    // Wall-clock expiry is not proof of non-execution; the original receipt path remains available.
    mocks.connectedAddress = ALICE
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([
      {
        scope: 'authority:0xaaa',
        session: pendingSession({ createdAt: Date.now() - 48 * 60 * 60 * 1000 }),
      },
    ])

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountPendingRelayr, { address: ALICE }),
      )
    })

    const text = renderedText(renderer.root)
    expect(text).toContain('Authorization deadline passed')
    await act(async () => buttonWith(renderer, 'Check original bundle').props.onClick())
    expect(mocks.resumeRelayrSession).toHaveBeenCalledWith({ scope: 'authority:0xaaa', account: ALICE })
  })

  it('reads an unpaid quote nothing can fund any more as expired, and offers the check that can discard it', async () => {
    mocks.connectedAddress = ALICE
    const bundleUuid = '01234567-89ab-cdef-0123-456789abcdef'
    const deadline = Math.floor(Date.now() / 1_000) - 60
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([{ scope: 'authority:0xaaa', session: pendingSession({
      bundleUuid, paymentStatus: 'unpaid', paymentChainId: null, records: [],
      paymentOptions: [{ chain: 1, amount: '100', target: '0x1c05f7841379d4393574c0ffa17908ec40ffd97d',
        token: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', payment_deadline: deadline,
        calldata: `0x103903a7${bundleUuid.replaceAll('-', '').padEnd(64, '0')}${deadline.toString(16).padStart(64, '0')}` }],
    }) }])

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(AccountPendingRelayr, { address: ALICE }))
    })

    const text = renderedText(renderer.root)
    expect(text).toContain('This unpaid quote expired. Nothing was paid; review the action again for a new quote.')
    expect(text).not.toContain('in flight')
    // Its old request may still run, so only a check classifies it (ruling R114 (e)).
    expect(buttonWith(renderer, 'Check original bundle')).toBeDefined()
  })

  it.each<[string, number, string]>([
    ['still open', 3_600, 'The payment reverted onchain. Pay again from the original action.'],
    ['expired', -60, 'The payment reverted and its quote expired. Check the original bundle to release it.'],
  ])('points a reverted payment whose quote is %s to the place that can continue it', async (_, offset, line) => {
    mocks.connectedAddress = ALICE
    const bundleUuid = '01234567-89ab-cdef-0123-456789abcdef'
    const deadline = Math.floor(Date.now() / 1_000) + offset
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([{ scope: 'authority:0xaaa', session: pendingSession({
      bundleUuid, paymentStatus: 'reverted', records: [],
      payments: [{ chainId: 1, target: '0x1c05f7841379d4393574c0ffa17908ec40ffd97d', amount: '100', deadline: String(deadline),
        calldata: `0x103903a7${bundleUuid.replaceAll('-', '').padEnd(64, '0')}${deadline.toString(16).padStart(64, '0')}`,
        bundleUuid, hash: `0x${'ab'.repeat(32)}` }],
    }) }])

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(AccountPendingRelayr, { address: ALICE }))
    })

    expect(renderedText(renderer.root)).toContain(line)
    expect(buttonWith(renderer, 'Check original bundle')).toBeDefined()
  })

  it('points a reverted project batch whose quote expired to its original project action', async () => {
    mocks.connectedAddress = ALICE
    const bundleUuid = '01234567-89ab-cdef-0123-456789abcdef'
    const deadline = Math.floor(Date.now() / 1_000) - 60
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([{ scope: 'project-batch:batch-1:0', session: pendingSession({
      bundleUuid, paymentStatus: 'reverted', records: [],
      payments: [{ chainId: 1, target: '0x1c05f7841379d4393574c0ffa17908ec40ffd97d', amount: '100', deadline: String(deadline),
        calldata: `0x103903a7${bundleUuid.replaceAll('-', '').padEnd(64, '0')}${deadline.toString(16).padStart(64, '0')}`,
        bundleUuid, hash: `0x${'ab'.repeat(32)}` }],
    }) }])

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(AccountPendingRelayr, { address: ALICE }))
    })

    const text = renderedText(renderer.root)
    expect(text).toContain('The payment reverted and its quote expired. Resume it from the original project action to release it.')
    expect(text).not.toContain('Check the original bundle')
    expect(buttonWith(renderer, 'Check original bundle')).toBeUndefined()
  })

  it('ends a session whose earlier signature may already have run with one line and Discard', async () => {
    mocks.connectedAddress = ALICE
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([{ scope: 'authority:0xaaa', session: pendingSession({
      paymentStatus: 'unpaid', discardable: 'ran', records: [],
    }) }])
    mocks.discardRelayrSession.mockResolvedValue(undefined)

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(AccountPendingRelayr, { address: ALICE }))
    })

    expect(renderedText(renderer.root)).toContain(
      'This action\'s earlier signature may already have run. Check the project, then discard it to review it again.')
    // A paid bundle that ran completes when checked again, so the check stays beside Discard.
    expect(buttonWith(renderer, 'Check original bundle')).toBeDefined()
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([])
    await act(async () => buttonWith(renderer, 'Discard').props.onClick())
    expect(mocks.discardRelayrSession).toHaveBeenCalledWith('authority:0xaaa')
    expect(renderedText(renderer.root)).not.toContain('earlier signature')
  })

  it('says the saved payment could not be matched, with Discard, once every request expired unused', async () => {
    mocks.connectedAddress = ALICE
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([{ scope: 'authority:0xaaa', session: pendingSession({
      paymentStatus: 'submitted', discardable: 'expired', paymentUnmatched: true, records: [],
    }) }])
    mocks.discardRelayrSession.mockResolvedValue(undefined)

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(AccountPendingRelayr, { address: ALICE }))
    })

    const text = renderedText(renderer.root)
    expect(text).toContain('The saved payment couldn\'t be matched to this action and isn\'t refunded. Discard it to review it again.')
    expect(text).not.toContain('expired without running')
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([])
    await act(async () => buttonWith(renderer, 'Discard').props.onClick())
    expect(mocks.discardRelayrSession).toHaveBeenCalledWith('authority:0xaaa')
  })

  it('shows a discardable session\'s line once after its check, not again as the check\'s message', async () => {
    mocks.connectedAddress = ALICE
    const session = pendingSession({ paymentStatus: 'unpaid', records: [] })
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([{ scope: 'authority:0xaaa', session }])
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(AccountPendingRelayr, { address: ALICE }))
    })
    // The check ends the session: its requests are dead, so it is marked for Discard, and the card reads the mark.
    mocks.resumeRelayrSession.mockRejectedValue(new RelayrDiscardError('authority:0xaaa', 'ran'))
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([{ scope: 'authority:0xaaa', session: { ...session, discardable: 'ran' } }])
    await act(async () => buttonWith(renderer, 'Check original bundle').props.onClick())

    const line = 'This action\'s earlier signature may already have run. Check the project, then discard it to review it again.'
    expect(renderedText(renderer.root).split(line)).toHaveLength(2)
    expect(buttonWith(renderer, 'Discard')).toBeDefined()
  })

  it('shows the changed line with Discard when the project changed since the review', async () => {
    mocks.connectedAddress = ALICE
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([{ scope: 'authority:0xaaa', session: pendingSession({
      paymentStatus: 'unpaid', discardable: 'changed', records: [],
    }) }])
    mocks.discardRelayrSession.mockResolvedValue(undefined)

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(AccountPendingRelayr, { address: ALICE }))
    })

    const text = renderedText(renderer.root)
    expect(text).toContain('The project changed since this review.')
    expect(text).not.toContain('may already have run')
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([])
    await act(async () => buttonWith(renderer, 'Discard').props.onClick())
    expect(mocks.discardRelayrSession).toHaveBeenCalledWith('authority:0xaaa')
  })

  it.each<[string, Partial<RelayrPendingSession>]>([
    ['an in-flight paid bundle', {}],
    ['an unpaid quote that expired', { paymentStatus: 'unpaid', paymentOptions: [] }],
    ['a reverted payment', { paymentStatus: 'reverted' }],
    ['a released reverted quote', { paymentStatus: 'reverted', released: true }],
  ])('never offers Discard for %s', async (_, overrides) => {
    mocks.connectedAddress = ALICE
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([{ scope: 'authority:0xaaa', session: pendingSession(overrides) }])

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(AccountPendingRelayr, { address: ALICE }))
    })

    expect(buttonWith(renderer, 'Discard')).toBeUndefined()
  })

  it('reads a released quote whose payment reverted as expired, and offers the check that can discard it', async () => {
    mocks.connectedAddress = ALICE
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([{ scope: 'authority:0xaaa', session: pendingSession({
      paymentStatus: 'reverted', released: true, records: [],
    }) }])

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(AccountPendingRelayr, { address: ALICE }))
    })

    const text = renderedText(renderer.root)
    expect(text).toContain('This unpaid quote expired. Nothing was paid; review the action again for a new quote.')
    // Its old request may still run, so only a check classifies it and offers Discard once every request is dead (ruling R114 (e)).
    expect(buttonWith(renderer, 'Check original bundle')).toBeDefined()
  })

  it('offers Discard after the expired line once every request expired unused, beside the check', async () => {
    mocks.connectedAddress = ALICE
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([{ scope: 'authority:0xaaa', session: pendingSession({
      paymentStatus: 'confirmed', discardable: 'expired',
    }) }])
    mocks.discardRelayrSession.mockResolvedValue(undefined)

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(AccountPendingRelayr, { address: ALICE }))
    })

    expect(renderedText(renderer.root)).toContain('This action\'s earlier signatures expired without running.')
    expect(buttonWith(renderer, 'Check original bundle')).toBeDefined()
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([])
    await act(async () => buttonWith(renderer, 'Discard').props.onClick())
    expect(mocks.discardRelayrSession).toHaveBeenCalledWith('authority:0xaaa')
  })

  it('shows the account its in-flight legs and resumes by session', async () => {
    mocks.connectedAddress = ALICE
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([
      { scope: 'authority:0xaaa', session: pendingSession() },
    ])
    mocks.resumeRelayrSession.mockResolvedValue({
      quote: { bundle_uuid: 'bundle-1', payment_info: [] },
      paymentHash: null,
      records: [],
    })

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountPendingRelayr, { address: ALICE }),
      )
    })

    const text = renderedText(renderer.root)
    expect(text).toContain('Cross-chain action in flight')
    expect(text).toContain('1/2 reported; onchain proof pending')
    expect(text).toContain('Ethereum: Reported; verification pending')
    expect(text).toContain('Optimism: pending')

    await act(async () => buttonWith(renderer, 'Check original bundle').props.onClick())
    expect(mocks.resumeRelayrSession).toHaveBeenCalledWith({
      scope: 'authority:0xaaa',
      account: ALICE,
    })
    expect(renderedText(renderer.root)).toContain('Completed on every chain.')
  })

  it('never labels an API-only SafeQueue success as confirmed', async () => {
    mocks.connectedAddress = ALICE
    mocks.fetchRelayrBundlesByAccount.mockResolvedValue([
      {
        scope: `safe-queue:${SAFE.toLowerCase()}`,
        session: pendingSession({
          chainIds: [1],
          expectedCount: 1,
          itemCount: 1,
          expectedEntries: [
            { chain: 1, target: SAFE, data: '0x1234', value: '0' },
          ],
        }),
      },
    ])

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountPendingRelayr, { address: ALICE }),
      )
    })

    const text = renderedText(renderer.root)
    expect(text).toContain('reported; onchain proof pending')
    expect(text).toContain('Owner/Operator tab')
    expect(text).not.toContain('Ethereum: confirmed')
    expect(buttonWith(renderer, 'Check original bundle')).toBeUndefined()
  })

  it('pairs chain legs with bundle records in order', () => {
    const legs = sessionLegs(
      pendingSession({
        chainIds: [1, 1, 10],
        records: [
          { chain: 1, status: { state: 'success' } },
          { chain: 1, status: { state: 'failed' } },
        ],
      }),
    )
    expect(legs.map(leg => leg.record?.status?.state)).toEqual([
      'success',
      'failed',
      undefined,
    ])
  })
})

describe('AccountSafeProjects', () => {
  it('adds deduped Safe-owned cards with threshold badges', async () => {
    mocks.safeService.mockImplementation(async () => new Response(JSON.stringify({ safes: [SAFE] })))
    mocks.getProjectsOwnedBy.mockResolvedValue([
      project({ projectId: 7, name: 'Safe project' }),
      project({ projectId: 8, name: 'Already owned' }),
      project({ projectId: 9, name: 'Another Safe project' }),
      project({ projectId: 7, name: 'Duplicate Safe project' }),
    ])
    mocks.readAuthorityIdentity.mockResolvedValue({
      kind: 'safe',
      threshold: 2,
      owners: [ALICE, BOB, SAFE],
    })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(QueryClientProvider, { client }, createElement(AccountSafeProjects, {
          address: ALICE,
          ownedKeys: ['1:8'],
          ownedCount: 1,
        })),
      )
    })

    const text = renderedText(renderer.root)
    expect(text).toContain('Safe project')
    expect(text).toContain('via Safe')
    expect(text).toContain('(2/3)')
    expect(text).toContain('Another Safe project')
    expect(text).not.toContain('Already owned')
    expect(text).not.toContain('Duplicate Safe project')
    // Distinct projects with the same chain/account share one identity request.
    expect(mocks.readAuthorityIdentity).toHaveBeenCalledExactlyOnceWith({ chain: { id: 1 } }, SAFE)
    // Only the chain with a hosted Safe service is queried.
    expect(mocks.safeService).toHaveBeenCalledExactlyOnceWith(
      `https://api.safe.global/tx-service/eth/api/v1/owners/${ALICE}/safes/`,
      expect.anything(),
    )
    await act(async () => renderer.unmount())
    client.clear()
  })

  it('reports an empty account only after the Safe check settles', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(QueryClientProvider, { client }, createElement(AccountSafeProjects, {
          address: ALICE,
          ownedKeys: [],
          ownedCount: 0,
        })),
      )
    })
    expect(renderedText(renderer.root)).toContain(
      'does not own any projects yet',
    )
    await act(async () => renderer.unmount())
    client.clear()
  })

  it('drops projects whose owner is not one of the Safes', () => {
    const rows = dedupeSafeProjects(
      [
        project({ projectId: 7 }),
        project({ projectId: 9, owner: BOB.toLowerCase() }),
        project({ projectId: 7 }),
      ],
      [SAFE],
      [],
    )
    expect(rows.map(row => row.project.projectId)).toEqual([7])
  })
})

describe('AccountOperatedProjects', () => {
  const grants: BsOperatorGrant[] = [
    {
      chainId: 1,
      projectId: 5,
      permissions: [1],
      account: BOB,
      operator: ALICE,
      isRevnetOperator: true,
      version: 6,
    },
    {
      chainId: 10,
      projectId: 5,
      permissions: [17],
      account: BOB,
      operator: ALICE,
      isRevnetOperator: false,
      version: 4,
    },
  ]

  it('groups grants by deployment and pairs indexed names', () => {
    const groups = groupOperatorGrants(grants, [
      project({ chainId: 1, projectId: 5, name: 'Rev' }),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].project?.name).toBe('Rev')
    expect(groups[0].isRevnetOperator).toBe(true)
    expect(groups[1].project).toBeNull()
  })

  it('renders V6 permission labels, bare ids elsewhere, and the revnet badge', async () => {
    const groups = groupOperatorGrants(grants, [
      project({ chainId: 1, projectId: 5, name: 'Rev' }),
    ])
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountOperatedProjects, { groups }),
      )
    })
    const text = renderedText(renderer.root)
    expect(text).toContain('Rev')
    expect(text).toContain('Revnet operator')
    expect(text).toContain('Full control (root)')
    expect(text).toContain('Permission #17')
    expect(text).toContain('Granted by')
  })

  it('shows the no-grants empty state', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountOperatedProjects, { groups: [] }),
      )
    })
    expect(renderedText(renderer.root)).toContain(
      'No projects have granted this account permissions',
    )
  })
})

/** A minimal window for the hash-linked tab row (node test environment). */
function fakeTabWindow(hash = '') {
  const listeners = new Set<() => void>()
  const historyState = { __NA: true, shell: 'preserved' }
  const location = { hash }
  const nativeReplaceState = vi.fn(
    (_state: unknown, _title: string, url: string) => {
      location.hash = url
    },
  )
  const patchedReplaceState = vi.fn()
  const history = Object.assign(
    Object.create({ replaceState: nativeReplaceState }),
    {
      state: historyState,
      // Mirrors Next's instance-level patch. Hash-only tab state must bypass
      // this function so it cannot dispatch an app-router restore.
      replaceState: patchedReplaceState,
    },
  )
  const win = {
    location,
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'hashchange') listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener)
    },
    history,
    nativeReplaceState,
    patchedReplaceState,
  }
  return win
}

describe('AccountTabs', () => {
  const tabs = [
    { label: 'Activity', content: 'activity-body' },
    { label: 'Holdings', content: 'holdings-body' },
    { label: 'Projects', content: 'projects-body' },
    { label: 'Roles', content: 'roles-body' },
  ]

  function panelFor(
    renderer: TestRenderer.ReactTestRenderer,
    body: string,
  ): ReactTestInstance | undefined {
    return renderer.root.findAll(
      node =>
        node.type === 'div' &&
        'hidden' in node.props &&
        renderedText(node).includes(body),
    )[0]
  }

  it('renders all four tabs and switches panels, deep-linking via the hash', async () => {
    const win = fakeTabWindow()
    vi.stubGlobal('window', win)

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(AccountTabs, { tabs }))
    })

    const buttons = renderer.root.findAll(
      node => node.type === 'button' && node.props.role === 'tab',
    )
    expect(buttons.map(button => renderedText(button))).toEqual([
      'Activity',
      'Holdings',
      'Projects',
      'Roles',
    ])
    expect(buttons[0].props['aria-selected']).toBe(true)
    // Tabs are lazy: only the active panel has mounted.
    expect(panelFor(renderer, 'activity-body')?.props.hidden).toBe(false)
    expect(panelFor(renderer, 'holdings-body')).toBeUndefined()

    await act(async () => buttonWith(renderer, 'Holdings').props.onClick())

    expect(panelFor(renderer, 'holdings-body')?.props.hidden).toBe(false)
    // The previous panel stays mounted but hidden.
    expect(panelFor(renderer, 'activity-body')?.props.hidden).toBe(true)
    expect(win.nativeReplaceState).toHaveBeenCalledWith(
      win.history.state,
      '',
      '#holdings',
    )
    expect(win.patchedReplaceState).not.toHaveBeenCalled()

    await act(async () => buttonWith(renderer, 'Roles').props.onClick())
    expect(panelFor(renderer, 'roles-body')?.props.hidden).toBe(false)
    expect(win.location.hash).toBe('#roles')
  })

  it('opens on the tab named by the URL hash', async () => {
    vi.stubGlobal('window', fakeTabWindow('#projects'))

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(AccountTabs, { tabs }))
    })

    expect(panelFor(renderer, 'projects-body')?.props.hidden).toBe(false)
    expect(buttonWith(renderer, 'Projects').props['aria-selected']).toBe(true)
  })
})

describe('account holdings grouping', () => {
  const holding = (
    overrides: Partial<BsAccountTokenHolding>,
  ): BsAccountTokenHolding => ({
    chainId: 1,
    projectId: 4,
    balance: '1000000000000000000',
    creditBalance: '0',
    erc20Balance: '1000000000000000000',
    ...overrides,
  })

  // A project row's tokenSymbol is the ACCOUNTING context's symbol — what the project is paid IN
  // (bendystraw ponder.schema.ts groups token/tokenSymbol/decimals/currency under accountingContext).
  // Balances are denominated in the project's OWN ERC-20, so fixtures deliberately differ: an
  // ETH-funded project whose token is REV. Reverting to tokenSymbol renders "4,000 ETH" and fails here.
  const TICKERS = new Map([
    ['1:4', 'REV'],
    ['8453:4', 'REV'],
  ])

  it('merges linked chains by sucker group and falls back per deployment', () => {
    const groups = groupTokenHoldings(
      [
        holding({ balance: '3000000000000000000' }),
        holding({ chainId: 8453, balance: '1000000000000000000' }),
        // Unlinked project without an indexed row: falls back gracefully.
        holding({ chainId: 10, projectId: 77, balance: '5' }),
      ],
      [
        project({
          chainId: 1,
          projectId: 4,
          name: 'Rev',
          tokenSymbol: 'ETH',
          suckerGroupId: 'sg-1',
        }),
        project({
          chainId: 8453,
          projectId: 4,
          name: 'Rev',
          tokenSymbol: 'ETH',
          suckerGroupId: 'sg-1',
        }),
      ],
      TICKERS,
    )

    expect(groups).toHaveLength(2)
    const [rev, solo] = groups
    expect(rev.front.chainId).toBe(1)
    expect(rev.front.project?.name).toBe('Rev')
    expect(rev.symbol).toBe('REV')
    expect(rev.total).toBe(4000000000000000000n)
    expect(rev.rows.map(row => row.chainId)).toEqual([1, 8453])
    expect(solo.front.projectId).toBe(77)
    expect(solo.front.project).toBeNull()
  })

  it('never labels balances with the accounting context symbol', () => {
    const [group] = groupTokenHoldings(
      [holding({ balance: '4000000000000000000' })],
      [project({ chainId: 1, projectId: 4, name: 'Rev', tokenSymbol: 'ETH' })],
      TICKERS,
    )
    expect(group.symbol).toBe('REV')
    expect(group.symbol).not.toBe('ETH')
  })

  it('shows no symbol rather than the accounting one when the ticker is unknown', () => {
    const [group] = groupTokenHoldings(
      [holding({ balance: '4000000000000000000' })],
      [project({ chainId: 1, projectId: 4, name: 'Rev', tokenSymbol: 'USDC' })],
    )
    // An un-tokenized project has no ticker. Blank is honest; "USDC" would be a lie.
    expect(group.symbol).toBeNull()
  })

  const nft = (overrides: Partial<BsAccountNft>): BsAccountNft => ({
    chainId: 1,
    projectId: 4,
    tokenId: '49000000145',
    tierId: 49,
    createdAt: 100,
    hook: { address: '0xHOOK' },
    tier: { resolvedUri: null, metadata: { name: 'Dagger' } },
    ...overrides,
  })

  it('tallies nfts per project by tier', () => {
    const groups = groupNftHoldings(
      [
        nft({}),
        nft({ tokenId: '49000000146' }),
        nft({
          tokenId: '7000000001',
          tierId: 7,
          tier: { resolvedUri: null, metadata: null },
        }),
      ],
      [project({ chainId: 1, projectId: 4, name: 'Banny Retail' })],
    )

    expect(groups).toHaveLength(1)
    expect(groups[0].project?.name).toBe('Banny Retail')
    expect(groups[0].count).toBe(3)
    expect(groups[0].tiers).toEqual([
      { tierId: 49, count: 2, name: 'Dagger', image: null },
      { tierId: 7, count: 1, name: 'Item #7', image: null },
    ])
  })

  it('renders token holding cards with totals and chain rows', async () => {
    const groups = groupTokenHoldings(
      [
        holding({ balance: '3000000000000000000' }),
        holding({ chainId: 8453, balance: '1000000000000000000' }),
      ],
      [
        project({
          chainId: 1,
          projectId: 4,
          name: 'Rev',
          tokenSymbol: 'ETH',
          suckerGroupId: 'sg-1',
        }),
        project({
          chainId: 8453,
          projectId: 4,
          name: 'Rev',
          tokenSymbol: 'ETH',
          suckerGroupId: 'sg-1',
        }),
      ],
      TICKERS,
    )
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountTokenHoldings, { groups }),
      )
    })
    const text = renderedText(renderer.root)
    expect(text).toContain('Rev')
    expect(text).toContain('4 REV')
    expect(text).toContain('Ethereum')
    expect(text).toContain('Base')
  })

  it('shows the credits breakdown whenever credits exist, and keeps the combined headline', async () => {
    const groups = groupTokenHoldings(
      [
        holding({
          balance: '3000000000000000000',
          creditBalance: '1000000000000000000',
          erc20Balance: '2000000000000000000',
        }),
      ],
      [project({ chainId: 1, projectId: 4, name: 'Rev', tokenSymbol: 'ETH' })],
      TICKERS,
    )
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountTokenHoldings, { groups }),
      )
    })
    const text = renderedText(renderer.root)
    expect(text).toContain('3 REV')
    expect(text).toContain('2 claimed | 1 credits')

    // Credits-only balances say so. A bare headline left a holder unable to tell the balance
    // was unclaimed, and therefore unable to tell why moving it cross-chain (which needs the
    // ERC-20) was unavailable.
    const creditsOnly = groupTokenHoldings(
      [
        holding({
          creditBalance: '1000000000000000000',
          erc20Balance: '0',
        }),
      ],
      [project({ chainId: 1, projectId: 4, name: 'Rev', tokenSymbol: 'ETH' })],
      TICKERS,
    )
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountTokenHoldings, { groups: creditsOnly }),
      )
    })
    const creditsText = renderedText(renderer.root)
    expect(creditsText).toContain('1 credits (unclaimed)')
    expect(creditsText).not.toContain('claimed |')
  })

  it('surfaces truncation when more balances exist than were fetched', async () => {
    const groups = groupTokenHoldings(
      [holding({})],
      [project({ chainId: 1, projectId: 4, name: 'Rev', tokenSymbol: 'ETH' })],
      TICKERS,
    )
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountTokenHoldings, {
          groups,
          fetchedCount: 400,
          totalCount: 900,
        }),
      )
    })
    expect(renderedText(renderer.root)).toContain(
      'Showing the 400 largest of 900 balances',
    )

    // Complete fetches render no truncation note.
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountTokenHoldings, {
          groups,
          fetchedCount: 1,
          totalCount: 1,
        }),
      )
    })
    expect(renderedText(renderer.root)).not.toContain('Showing the')
  })

  it('surfaces truncation on the store-item section too', async () => {
    const groups = groupNftHoldings(
      [nft({})],
      [project({ chainId: 1, projectId: 4, name: 'Banny Retail' })],
    )
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountShopHoldings, {
          groups,
          fetchedCount: 600,
          totalCount: 750,
        }),
      )
    })
    expect(renderedText(renderer.root)).toContain(
      'Showing the 600 newest of 750 items',
    )
  })

  it('shows the tokens empty state', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountTokenHoldings, { groups: [] }),
      )
    })
    expect(renderedText(renderer.root)).toContain(
      "doesn't hold any project tokens",
    )
  })
})
