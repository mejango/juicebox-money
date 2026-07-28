import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/providers/Providers', () => ({
  wagmiConfig: {},
  SUPPORTED_CHAINS: [
    { id: 1, name: 'Ethereum' },
    { id: 10, name: 'Optimism' },
  ],
}))

import {
  fetchRelayrBundlesByAccount,
  listRelayrPendingScopes,
  resumeRelayrSession,
  type RelayrPendingSession,
} from '@/lib/relayr'

const PREFIX = 'jb-relayr-pending-v1:'
const ALICE = '0x1111111111111111111111111111111111111111'
const BOB = '0x2222222222222222222222222222222222222222'

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

function session(
  overrides: Partial<RelayrPendingSession> = {},
): RelayrPendingSession {
  return {
    bundleUuid: 'bundle-1',
    paymentHash: null,
    paymentChainId: 1,
    paymentStatus: 'confirmed',
    chainIds: [1, 10],
    expectedCount: 2,
    records: [],
    itemCount: 2,
    account: ALICE,
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

let storage: ReturnType<typeof localStorageStub>

beforeEach(() => {
  storage = localStorageStub()
  vi.stubGlobal('window', { localStorage: storage })
})

function seed(scope: string, value: RelayrPendingSession) {
  storage.setItem(`${PREFIX}${scope}`, JSON.stringify(value))
}

describe('pending-session enumeration', () => {
  it('lists only prefixed scopes', () => {
    seed('authority:0xaaa', session())
    seed('authority:0xbbb', session())
    storage.setItem('jb-safe-api-key', 'not-a-session')

    expect(listRelayrPendingScopes().sort()).toEqual([
      'authority:0xaaa',
      'authority:0xbbb',
    ])
  })

  it('returns an empty list without a window (server render)', async () => {
    vi.stubGlobal('window', undefined)
    expect(listRelayrPendingScopes()).toEqual([])
    await expect(fetchRelayrBundlesByAccount(ALICE)).resolves.toEqual([])
  })

  it('filters bundles to the account, case-insensitively, newest first', async () => {
    seed('authority:old', session({ createdAt: 1_000, bundleUuid: 'old' }))
    seed(
      'authority:new',
      session({
        createdAt: 2_000,
        bundleUuid: 'new',
        account: ALICE.toUpperCase().replace('0X', '0x'),
      }),
    )
    seed('authority:other', session({ account: BOB }))
    storage.setItem(`${PREFIX}authority:junk`, '{not json')

    const bundles = await fetchRelayrBundlesByAccount(ALICE)

    expect(bundles.map(bundle => bundle.session.bundleUuid)).toEqual([
      'new',
      'old',
    ])
    expect(bundles.map(bundle => bundle.scope)).toEqual([
      'authority:new',
      'authority:old',
    ])
  })
})

describe('resume-by-session entry point', () => {
  it('rejects a missing session', async () => {
    await expect(
      resumeRelayrSession({ scope: 'authority:none', account: ALICE }),
    ).rejects.toThrow('No pending Relayr bundle')
  })

  it('rejects the wrong wallet before doing anything', async () => {
    seed('authority:0xaaa', session())
    await expect(
      resumeRelayrSession({ scope: 'authority:0xaaa', account: BOB }),
    ).rejects.toThrow('Switch back to')
  })

  it('completes a finished session locally and clears its storage', async () => {
    const records = [
      {
        chain: 1,
        status: {
          state: 'success',
          data: { hash: `0x${'ab'.repeat(32)}` as const },
        },
      },
      { chain: 10, status: { state: 'completed' } },
    ]
    seed('authority:0xaaa', session({ records }))
    const progress: number[] = []

    const result = await resumeRelayrSession({
      scope: 'authority:0xaaa',
      account: ALICE,
      onProgress: update => {
        if (update.phase === 'executing') progress.push(update.done)
      },
    })

    expect(result.records).toHaveLength(2)
    expect(result.quote.bundle_uuid).toBe('bundle-1')
    expect(progress).toEqual([2])
    expect(storage.getItem(`${PREFIX}authority:0xaaa`)).toBeNull()
  })

  it('surfaces an all-failed saved session as a hard failure and clears it', async () => {
    seed(
      'authority:0xaaa',
      session({
        records: [
          { chain: 1, status: { state: 'failed' } },
          { chain: 10, status: { state: 'Failed' } },
        ],
      }),
    )

    await expect(
      resumeRelayrSession({ scope: 'authority:0xaaa', account: ALICE }),
    ).rejects.toThrow('could not execute this action on any selected chain')
    expect(storage.getItem(`${PREFIX}authority:0xaaa`)).toBeNull()
  })
})
