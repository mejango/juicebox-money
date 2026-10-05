import type { Address, Hex } from 'viem'
import type { RelayrEntry, RelayrTransactionRecord } from '@bananapus/nana-sdk-core/review/relayr'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {}, SUPPORTED_CHAINS: [] }))

import { relayrPoll, relayrPostBundle } from '@/lib/relayr'

const TARGET = '0x3333333333333333333333333333333333333333' as Address
const BUNDLE = '01234567-89ab-cdef-0123-456789abcdef'
const OTHER_BUNDLE = 'fedcba98-7654-3210-fedc-ba9876543210'
const IDS = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
  'aaaaaaaa-0000-4000-8000-000000000003',
]
const UNBOUND = 'Relayr did not bind every quoted transaction to a unique ID. Nothing was paid.'
const UNRETURNED = 'Relayr did not return the quoted transactions. Nothing was paid.'
const ENTRIES: RelayrEntry[] = [
  { chain: 1, target: TARGET, data: '0x01', value: '0' },
  { chain: 10, target: TARGET, data: '0x02', value: '5' },
]

type Echoed = RelayrTransactionRecord & { request: RelayrEntry & { virtual_nonce: number } }

type Api = {
  /** Fields that replace or join the POST response's. */
  quote?: (ids: string[], echoed: Echoed[]) => Record<string, unknown>
  /** The records Relayr reports for the posted transactions, in its own order. */
  records?: (echoed: Echoed[]) => unknown[]
  /** Fields that replace or join the bundle read's. */
  bundle?: Record<string, unknown>
  /** Status of the bundle read. */
  bundleStatus?: number
}

function json(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

/** Relayr's API: each posted transaction gets IDS[index], and its record echoes its exact request. */
function relayr(api: Api = {}) {
  let echoed: Echoed[] = []
  return vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/bundle/prepaid') && init?.method === 'POST') {
      const posted = (JSON.parse(String(init.body)) as { transactions: Echoed['request'][] }).transactions
      echoed = posted.map((request, index) => ({ tx_uuid: IDS[index], request, status: { state: 'Pending' } }))
      const ids = echoed.map(record => record.tx_uuid!)
      return json({ bundle_uuid: BUNDLE, payment_info: [], tx_uuids: ids,
        transactions: (api.records ?? (records => records))(echoed), ...api.quote?.(ids, echoed) })
    }
    if (url.endsWith(`/v1/bundle/${BUNDLE}`)) {
      return json({ bundle_uuid: BUNDLE, transactions: (api.records ?? (records => records))(echoed), ...api.bundle },
        api.bundleStatus ?? 200)
    }
    throw new Error(`Unexpected Relayr request: ${url}`)
  })
}

describe('Relayr quote binding', () => {
  it('binds each posted call to the quoted ID whose record carries its exact request, whatever order Relayr lists them in', async () => {
    relayr({
      quote: ids => ({ tx_uuids: [...ids].reverse() }),
      records: echoed => [...echoed].reverse(),
    })
    const quote = await relayrPostBundle(ENTRIES)
    expect(quote.expectedTransactions.map(binding => [binding.chain, binding.txUuid])).toEqual([[1, IDS[0]], [10, IDS[1]]])
    expect(quote.transactions.map(record => record.tx_uuid)).toEqual([IDS[0], IDS[1]])
    expect(quote.expectedTransactions.map(binding => binding.entry.virtual_nonce)).toEqual([0, 0])
  })

  it('reads the legacy txn_uuids list the same way', async () => {
    relayr({ quote: ids => ({ tx_uuids: undefined, txn_uuids: [...ids].reverse() }) })
    const quote = await relayrPostBundle(ENTRIES)
    expect(quote.expectedTransactions.map(binding => binding.txUuid)).toEqual([IDS[0], IDS[1]])
  })

  it('reads the bundle, never from a cache, when the quote leaves its records out', async () => {
    const api = relayr({ quote: () => ({ transactions: undefined }) })
    const quote = await relayrPostBundle(ENTRIES)
    expect(quote.expectedTransactions.map(binding => binding.txUuid)).toEqual([IDS[0], IDS[1]])
    expect(api).toHaveBeenLastCalledWith(
      `https://api.relayr.ba5ed.com/v1/bundle/${BUNDLE}`,
      expect.objectContaining({ cache: 'no-store' }),
    )
  })

  it('accepts the bundle ID the read echoes in another case', async () => {
    relayr({ quote: () => ({ transactions: undefined }), bundle: { bundle_uuid: BUNDLE.toUpperCase() } })
    await expect(relayrPostBundle(ENTRIES)).resolves.toMatchObject({ bundle_uuid: BUNDLE })
  })

  it('compares an echoed value as a number, so a hex echo binds', async () => {
    relayr({ records: echoed => echoed.map(record => ({ ...record, request: { ...record.request, value: `0x${BigInt(record.request.value).toString(16)}` } })) })
    await expect(relayrPostBundle(ENTRIES)).resolves.toMatchObject({ bundle_uuid: BUNDLE })
  })

  it('tells identical calls on one chain apart by their virtual nonce', async () => {
    relayr({ records: echoed => [...echoed].reverse() })
    const quote = await relayrPostBundle([ENTRIES[0], ENTRIES[0]])
    expect(quote.expectedTransactions.map(binding => [binding.entry.virtual_nonce, binding.txUuid])).toEqual([[0, IDS[0]], [1, IDS[1]]])
  })

  it.each<[string, Api, string]>([
    ['an extra record under an unquoted ID', { records: echoed => [...echoed, { ...echoed[0], tx_uuid: IDS[2] }] }, UNBOUND],
    ['an extra record under a quoted ID', { records: echoed => [...echoed, echoed[0]] }, UNBOUND],
    ['one record ID used for both calls', { records: echoed => echoed.map(record => ({ ...record, tx_uuid: IDS[0] })) }, UNBOUND],
    ['a quoted ID listed twice', { quote: ids => ({ tx_uuids: [ids[0], ids[0]] }) }, UNBOUND],
    ['IDs that are not UUIDs', { quote: () => ({ tx_uuids: ['tx-0', 'tx-1'] }) }, UNBOUND],
    ['too few IDs', { quote: ids => ({ tx_uuids: ids.slice(0, 1) }) }, UNBOUND],
    ['a missing signed call', { records: echoed => echoed.slice(0, 1) }, UNBOUND],
    ['a changed calldata', { records: echoed => echoed.map((record, index) => index ? { ...record, request: { ...record.request, data: '0x5678' } } : record) }, UNBOUND],
    ['a changed target', { records: echoed => echoed.map((record, index) => index ? { ...record, request: { ...record.request, target: '0x4444444444444444444444444444444444444444' } } : record) }, UNBOUND],
    ['a changed value', { records: echoed => echoed.map((record, index) => index ? { ...record, request: { ...record.request, value: '6' } } : record) }, UNBOUND],
    ['a changed virtual nonce', { records: echoed => echoed.map((record, index) => index ? { ...record, request: { ...record.request, virtual_nonce: 1 } } : record) }, UNBOUND],
    ['records without a request', { records: echoed => echoed.map(({ request: _request, ...record }) => record) }, UNBOUND],
    ['ID lists that disagree', { quote: ids => ({ txn_uuids: [...ids].reverse() }) }, 'Relayr returned conflicting transaction IDs. Nothing was paid.'],
    ['no payment options list', { quote: () => ({ payment_info: null }) }, UNBOUND],
    ['a bundle read that echoes no bundle ID', { quote: () => ({ transactions: undefined }), bundle: { bundle_uuid: undefined } }, UNRETURNED],
    ['a bundle read that names another bundle', { quote: () => ({ transactions: undefined }), bundle: { bundle_uuid: OTHER_BUNDLE } }, UNRETURNED],
    ['a bundle read that fails', { quote: () => ({ transactions: undefined }), bundleStatus: 500 }, UNRETURNED],
    ['a bundle read with no records list', { quote: () => ({ transactions: undefined }), bundle: { transactions: null } }, UNRETURNED],
  ])('refuses a quote with %s before any payment exists', async (_, api, message) => {
    relayr(api)
    await expect(relayrPostBundle(ENTRIES)).rejects.toThrow(message)
  })

  it('refuses an unreadable quote', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json('{not json'))
    await expect(relayrPostBundle(ENTRIES)).rejects.toThrow('Relayr returned an unreadable quote. Nothing was paid.')
  })

  it('refuses a malformed call before posting it', async () => {
    await expect(relayrPostBundle([{ ...ENTRIES[0], data: '0x123' as Hex }])).rejects.toThrow('A Relayr bundle transaction is malformed.')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('Relayr status polling', () => {
  const pending = { tx_uuid: IDS[0], status: { state: 'Pending' } }
  const done = { tx_uuid: IDS[0], status: { state: 'Success', data: { hash: `0x${'ab'.repeat(32)}` } } }

  it('reads the bundle uncached and takes records only from a response that echoes its bundle ID', async () => {
    const reads = vi.mocked(fetch)
      .mockResolvedValueOnce(json({ transactions: [done] }))
      .mockResolvedValueOnce(json({ bundle_uuid: OTHER_BUNDLE, transactions: [done] }))
      .mockResolvedValueOnce(json({ bundle_uuid: BUNDLE, transactions: [pending] }))
      .mockResolvedValueOnce(json({ bundle_uuid: BUNDLE.toUpperCase(), transactions: [done] }))
    const updates = vi.fn()
    await expect(relayrPoll(BUNDLE, 1, updates, 0, 1_000)).resolves.toEqual([done])
    expect(updates.mock.calls.map(([records]) => records)).toEqual([[pending], [done]])
    expect(reads).toHaveBeenCalledTimes(4)
    for (const [, init] of reads.mock.calls) expect(init).toMatchObject({ cache: 'no-store' })
  })

  it('stays uncertain when no response names the bundle', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ bundle_uuid: OTHER_BUNDLE, transactions: [done] }))
    await expect(relayrPoll(BUNDLE, 1, undefined, 0, 20)).rejects.toMatchObject({
      name: 'RelayrExecutionError', code: 'RELAYR_TIMEOUT', retryable: true, records: [],
    })
  })
})
