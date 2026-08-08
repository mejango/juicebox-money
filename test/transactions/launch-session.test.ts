import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_STORE_FLAGS,
  createSimpleProjectStage,
  type LaunchPlan,
} from '@/lib/launch'
import { DRAFT_KEY } from '@/lib/draft'
import {
  LAUNCH_SESSION_KEY,
  abandonLaunchSession,
  completeLaunchSession,
  loadLaunchSession,
  recordLaunchChainStatus,
  remainingLaunchChains,
  saveLaunchSession,
  type LaunchSession,
} from '@/lib/launch-session'

const SALT = `0x${'ab'.repeat(32)}` as const

function localStorageStub() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  }
}

/** A pinned store with a bigint-bearing item, to prove serialization
 *  round-trips the launch request payload exactly. */
function pinnedStore(): LaunchPlan['store'] {
  return {
    name: 'Test collection',
    symbol: 'TEST',
    currency: 'eth',
    ...DEFAULT_STORE_FLAGS,
    items: [
      {
        price: 5n * 10n ** 17n,
        supply: 10,
        encodedIpfsUri: `0x${'34'.repeat(32)}`,
        splitPercent: 0,
        splits: [],
        discountPercent: 0,
        reserveFrequency: 0,
        reserveBeneficiary: null,
        category: 0,
        votingUnits: 0,
        flags: {
          allowOwnerMint: false,
          transfersPausable: false,
          cantBeRemoved: false,
          allowCredits: true,
          ownerCanEditDiscount: true,
        },
        perChainSupply: {},
      },
    ],
  }
}

/** The exact per-chain plan the launch run was built with — resumes must
 *  reuse it verbatim (same deploy start, same resolved recipients). */
function planFor(store: LaunchPlan['store']): LaunchPlan {
  return {
    accounting: { tokens: ['eth'], custom: null },
    issuanceBase: null,
    flavor: 'project',
    projectName: 'Test project',
    operator: null,
    ticker: '',
    stages: [
      {
        ...createSimpleProjectStage(),
        mustStartAtOrAfter: 1_700_000_600,
        // A pinned-chain auto-issuance row: the bigint count and the row's
        // mint chain must both survive the persistence round trip.
        autoIssuances: [
          {
            count: 1_000n * 10n ** 18n,
            beneficiary: '0x1111111111111111111111111111111111111111',
            chainId: 8453,
          },
        ],
      },
    ],
    afterMode: 'wait',
    approvalDeadline: 'none',
    approvalCustomAddress: null,
    allowAnyToken: true,
    owner: '0x2222222222222222222222222222222222222222',
    chains: [1, 10, 8453],
    linkChains: true,
    bridge: 'ccip',
    store,
  }
}

function session(overrides: Partial<LaunchSession> = {}): LaunchSession {
  const store = pinnedStore()
  return {
    salt: SALT,
    projectUri: 'ipfs://QmProjectMetadata',
    store,
    plans: Object.fromEntries(
      [1, 10, 8453].map(chainId => [chainId, planFor(store)]),
    ),
    chains: [1, 10, 8453],
    statuses: {
      1: { phase: 'pending' },
      10: { phase: 'pending' },
      8453: { phase: 'pending' },
    },
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

let storage: ReturnType<typeof localStorageStub>

beforeEach(() => {
  storage = localStorageStub()
  vi.stubGlobal('window', { localStorage: storage })
})

describe('multichain launch session persistence', () => {
  it('persists the session when the launch starts and round-trips it exactly', () => {
    saveLaunchSession(session())

    expect(storage.getItem(LAUNCH_SESSION_KEY)).not.toBeNull()
    const restored = loadLaunchSession()
    expect(restored).toEqual(session())
    // bigint fields survive the round trip as bigints.
    expect(restored?.store.items[0].price).toBe(5n * 10n ** 17n)
    expect(restored?.plans[1].stages[0].weight).toBe(10n ** 22n)
    // auto-issuance rows keep their bigint count and chosen mint chain.
    expect(restored?.plans[1].stages[0].autoIssuances).toEqual([
      {
        count: 1_000n * 10n ** 18n,
        beneficiary: '0x1111111111111111111111111111111111111111',
        chainId: 8453,
      },
    ])
  })

  it('resumes from the first un-launched chain with the SAME salt', () => {
    saveLaunchSession(session())
    recordLaunchChainStatus(1, {
      phase: 'done',
      txHash: `0x${'11'.repeat(32)}`,
      projectId: 7,
    })

    const restored = loadLaunchSession()
    expect(restored?.salt).toBe(SALT)
    expect(restored?.statuses[1]).toEqual({
      phase: 'done',
      txHash: `0x${'11'.repeat(32)}`,
      projectId: 7,
    })
    expect(remainingLaunchChains(restored!)).toEqual([10, 8453])
  })

  it('re-sends interrupted signatures but keeps submitted transactions waiting', () => {
    saveLaunchSession(session())
    // Refresh mid-signature: nothing provably submitted — resume re-sends.
    recordLaunchChainStatus(1, { phase: 'signing' })
    // Refresh mid-confirmation: the hash exists — resume must NOT re-send.
    recordLaunchChainStatus(10, {
      phase: 'confirming',
      txHash: `0x${'22'.repeat(32)}`,
    })

    const restored = loadLaunchSession()
    expect(restored?.statuses[1]).toEqual({ phase: 'pending' })
    expect(restored?.statuses[10]).toEqual({
      phase: 'confirming',
      txHash: `0x${'22'.repeat(32)}`,
    })
  })

  it('supports single-chain sessions with the same resume semantics (refresh mid-confirm must not duplicate the project)', () => {
    const store = pinnedStore()
    saveLaunchSession(
      session({
        chains: [1],
        plans: { 1: planFor(store) },
        statuses: { 1: { phase: 'pending' } },
        store,
      }),
    )
    recordLaunchChainStatus(1, {
      phase: 'confirming',
      txHash: `0x${'33'.repeat(32)}`,
    })

    const restored = loadLaunchSession()
    expect(restored?.salt).toBe(SALT)
    expect(restored?.chains).toEqual([1])
    // The submitted hash is kept: a resume waits on it instead of re-sending.
    expect(restored?.statuses[1]).toEqual({
      phase: 'confirming',
      txHash: `0x${'33'.repeat(32)}`,
    })
    expect(remainingLaunchChains(restored!)).toEqual([1])
  })

  it('clears the session and the persisted draft on full completion', () => {
    storage.setItem(DRAFT_KEY, '{"v":1}')
    saveLaunchSession(session())
    for (const chainId of [1, 10, 8453]) {
      recordLaunchChainStatus(chainId, { phase: 'done', projectId: chainId })
    }
    expect(remainingLaunchChains(loadLaunchSession()!)).toEqual([])

    completeLaunchSession()

    expect(loadLaunchSession()).toBeNull()
    expect(storage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('abandons a failed run by dropping the session while KEEPING the form draft', () => {
    // A deterministically-reverting config loops on Retry forever; abandoning
    // must free the pinned session (the exit) without losing the draft the
    // user needs in order to fix the configuration and relaunch.
    storage.setItem(DRAFT_KEY, '{"v":1}')
    saveLaunchSession(session())
    recordLaunchChainStatus(1, { phase: 'failed' })

    abandonLaunchSession()

    expect(loadLaunchSession()).toBeNull()
    expect(storage.getItem(DRAFT_KEY)).toBe('{"v":1}')
  })

  it('backfills projectName from the store name for plans pinned without it', () => {
    saveLaunchSession(session())
    const parsed = JSON.parse(storage.getItem(LAUNCH_SESSION_KEY)!) as {
      plans: Record<number, Record<string, unknown>>
    }
    for (const plan of Object.values(parsed.plans)) {
      delete plan.projectName
    }
    storage.setItem(LAUNCH_SESSION_KEY, JSON.stringify(parsed))

    const restored = loadLaunchSession()
    // Those runs encoded the store name as the description name — a resume
    // must reuse it verbatim to stay byte-compatible with launched chains.
    expect(restored?.plans[1].projectName).toBe('Test collection')
  })

  it('carries the owner frozen at pin time through to a resume', () => {
    // The empty owner field means "the launching wallet". Resolving that per
    // chain at SEND time let a run resumed from a DIFFERENT wallet hand the
    // remaining chains another owner — split-brain ownership inside one
    // sucker-linked group. The concrete address is frozen into every plan when
    // the run is pinned, and the resume reuses it verbatim.
    saveLaunchSession(session())
    recordLaunchChainStatus(1, { phase: 'done', projectId: 7 })

    const restored = loadLaunchSession()!
    for (const chainId of remainingLaunchChains(restored)) {
      expect(restored.plans[chainId].owner).toBe(
        '0x2222222222222222222222222222222222222222',
      )
    }
  })

  it('rejects corrupt or foreign records', () => {
    storage.setItem(LAUNCH_SESSION_KEY, 'not json')
    expect(loadLaunchSession()).toBeNull()

    storage.setItem(
      LAUNCH_SESSION_KEY,
      JSON.stringify({ salt: 'nope', chains: 'x' }),
    )
    expect(loadLaunchSession()).toBeNull()
  })

  it('is inert without a window (server render)', () => {
    vi.stubGlobal('window', undefined)
    expect(() => saveLaunchSession(session())).not.toThrow()
    expect(loadLaunchSession()).toBeNull()
    expect(() => recordLaunchChainStatus(1, { phase: 'done' })).not.toThrow()
    expect(() => completeLaunchSession()).not.toThrow()
    expect(() => abandonLaunchSession()).not.toThrow()
  })

  it('ignores status updates when no launch session is active', () => {
    recordLaunchChainStatus(1, { phase: 'done' })
    expect(storage.getItem(LAUNCH_SESSION_KEY)).toBeNull()
  })
})
