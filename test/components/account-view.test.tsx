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
  safesForOwner: vi.fn(),
  fetchSafeInfo: vi.fn(),
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
vi.mock('@/lib/relayr', () => ({
  fetchRelayrBundlesByAccount: mocks.fetchRelayrBundlesByAccount,
  resumeRelayrSession: mocks.resumeRelayrSession,
  // Signed ForwardRequests expire after 47h; the card hides Resume past that.
  relayrSessionExpired: (session: { createdAt: number }, nowMs = Date.now()) =>
    nowMs >= session.createdAt + 47 * 60 * 60 * 1000,
  relayrSessionExpiresAt: (session: { createdAt: number }) =>
    session.createdAt + 47 * 60 * 60 * 1000,
  relayrDestinationHash: (record: {
    status?: { data?: { hash?: string } }
  }) => record.status?.data?.hash ?? null,
  relayrStateIsSuccess: (state?: string) =>
    ['success', 'completed'].includes((state ?? '').trim().toLowerCase()),
  relayrStateIsFailed: (state?: string) =>
    (state ?? '').trim().toLowerCase() === 'failed',
  relayrProgress: (
    records: { status?: { state?: string } }[],
    expected = records.length,
  ) => {
    const confirmed = records.filter(record =>
      ['success', 'completed'].includes(
        (record.status?.state ?? '').trim().toLowerCase(),
      ),
    ).length
    const failed = records.filter(
      record => (record.status?.state ?? '').trim().toLowerCase() === 'failed',
    ).length
    const total = Math.max(expected, records.length)
    return {
      confirmed,
      failed,
      pending: Math.max(total - confirmed - failed, 0),
      total,
    }
  },
}))
vi.mock('@/lib/safe', () => ({
  safesForOwner: mocks.safesForOwner,
  fetchSafeInfo: mocks.fetchSafeInfo,
  hasSafeService: (chainId: number) => chainId === 1,
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
    // A LIVE session by default: signed ForwardRequests expire 47h after creation, and an
    // expired one deliberately offers no Resume (see the expiry test below).
    createdAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  mocks.connectedAddress = undefined
  mocks.fetchRelayrBundlesByAccount.mockResolvedValue([])
  mocks.safesForOwner.mockResolvedValue([])
  mocks.getProjectsOwnedBy.mockResolvedValue([])
  mocks.fetchSafeInfo.mockResolvedValue(null)
})

describe('AccountActivity', () => {
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
    expect(text).toContain('got')
    expect(text).toContain('created the project')
    expect(text).toContain('thanks')
    // Non-V6 rows are labeled but not linked into this V6-only site.
    expect(text).toContain('Old project')
    expect(text).toContain('V4')

    await act(async () => buttonWith(renderer, 'Load more').props.onClick())

    expect(mocks.getAccountActivity).toHaveBeenCalledWith(ALICE, {
      limit: 25,
      offset: 2,
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
    })
    expect(renderedText(renderer.root)).toContain('1025 of 1500')
  })
})

describe('AccountHeader view-as lookup', () => {
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


  it('navigates straight to a pasted address', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountHeader, { address: ALICE, ensName: null }),
      )
    })
    await act(async () => {
      renderer.root
        .findByType('input')
        .props.onChange({ target: { value: ` ${BOB} ` } })
    })
    await act(async () =>
      renderer.root.findByType('form').props.onSubmit({
        preventDefault: () => {},
      }),
    )
    expect(mocks.push).toHaveBeenCalledWith(`/account/${BOB}`)
    expect(mocks.lookupEnsAddress).not.toHaveBeenCalled()
  })

  it('resolves ENS names before navigating, and reports failures', async () => {
    mocks.lookupEnsAddress.mockResolvedValueOnce(BOB)
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountHeader, { address: ALICE, ensName: 'alice.eth' }),
      )
    })
    expect(renderedText(renderer.root)).toContain('alice.eth')

    await act(async () => {
      renderer.root
        .findByType('input')
        .props.onChange({ target: { value: 'Bob.eth' } })
    })
    await act(async () =>
      renderer.root.findByType('form').props.onSubmit({
        preventDefault: () => {},
      }),
    )
    expect(mocks.push).toHaveBeenCalledWith('/account/bob.eth')

    mocks.push.mockClear()
    mocks.lookupEnsAddress.mockResolvedValueOnce(null)
    await act(async () => {
      renderer.root
        .findByType('input')
        .props.onChange({ target: { value: 'missing.eth' } })
    })
    await act(async () =>
      renderer.root.findByType('form').props.onSubmit({
        preventDefault: () => {},
      }),
    )
    expect(mocks.push).not.toHaveBeenCalled()
    expect(renderedText(renderer.root)).toContain('Could not resolve')
  })
})

describe('AccountPendingRelayr', () => {
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

  it('offers no resume once the signed requests have expired', async () => {
    // The ForwardRequest deadline is signed at creation + 47h; past it the forwarder rejects
    // the bundle, so a Resume button promised a retry that could never succeed — on a bundle
    // the user has already paid for.
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
    expect(text).toContain('Signatures expired')
    expect(buttonWith(renderer, 'Resume')).toBeUndefined()
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
    expect(text).toContain('1/2 chains done')
    expect(text).toContain('Ethereum — confirmed')
    expect(text).toContain('Optimism — pending')

    await act(async () => buttonWith(renderer, 'Resume').props.onClick())
    expect(mocks.resumeRelayrSession).toHaveBeenCalledWith({
      scope: 'authority:0xaaa',
      account: ALICE,
    })
    expect(renderedText(renderer.root)).toContain('Completed on every chain.')
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
    mocks.safesForOwner.mockResolvedValue([SAFE])
    mocks.getProjectsOwnedBy.mockResolvedValue([
      project({ projectId: 7, name: 'Safe project' }),
      project({ projectId: 8, name: 'Already owned' }),
    ])
    mocks.fetchSafeInfo.mockResolvedValue({
      threshold: 2,
      owners: [ALICE, BOB, SAFE],
    })

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountSafeProjects, {
          address: ALICE,
          ownedKeys: ['1:8'],
          ownedCount: 1,
        }),
      )
    })

    const text = renderedText(renderer.root)
    expect(text).toContain('Safe project')
    expect(text).toContain('via Safe')
    expect(text).toContain('(2/3)')
    expect(text).not.toContain('Already owned')
    // Only the chain with a hosted Safe service is queried.
    expect(mocks.safesForOwner).toHaveBeenCalledTimes(1)
    expect(mocks.safesForOwner).toHaveBeenCalledWith(ALICE, 1)
  })

  it('reports an empty account only after the Safe check settles', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AccountSafeProjects, {
          address: ALICE,
          ownedKeys: [],
          ownedCount: 0,
        }),
      )
    })
    expect(renderedText(renderer.root)).toContain(
      'does not own any projects yet',
    )
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
    expect(text).toContain('2 claimed · 1 credits')

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
    expect(creditsText).not.toContain('claimed ·')
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
