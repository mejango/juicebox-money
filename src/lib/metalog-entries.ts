/** Metalog owns receipt verification and distribution math; this is a bounded wire validator. */
type EntryRange = { tierId: number; label: string; lower: number | null; upper: number | null }
export type EntryChart = { low: number; high: number; peak: number; buckets: { lower: number; upper: number; density: number; mass: number }[]; positions: { range: EntryRange; quantity: number; share: number; density: number | null }[] }
export type MetalogEntry = {
  status: 'verified-curve' | 'verified-manual' | 'unrecognized' | 'unsupported' | 'invalid'
  transactionHash: string; blockNumber: string; timestamp: number; account: string; beneficiary: string | null
  stakeWei: string | null; tokenIds: string[]; quantities: number[]; coefficients: number[] | null; reason?: string; chartError?: string; chart: EntryChart | null
}
export type MetalogEntriesPage = {
  schema: 'metalog.entries.v1'; chainId: number; projectId: string; blockNumber: string; snapshotBlockHash: string; hook: string
  ranges: EntryRange[]; entries: MetalogEntry[]; scannedFromBlock: string | null; scannedToBlock: string | null; complete: boolean; nextCursor: string | null
}
export type EntryContext = { protocol: 'defifa'; chainId: number; projectId: number; hook: string }
export type EntryContinuation = { blockNumber?: string; snapshotBlockHash?: string; cursor?: string }
const fail = () => { throw new Error('Metalog returned invalid or mismatched entry evidence.') }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail()
const array = (value: unknown, max: number, min = 0): unknown[] => Array.isArray(value) && value.length >= min && value.length <= max ? value : fail()
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => number(value) && Number.isSafeInteger(value) && value >= 0 && value <= max
const uint = (value: unknown): value is string => typeof value === 'string' && /^\d{1,78}$/.test(value) && BigInt(value) < 2n ** 256n
const hex = (value: unknown, digits: number): value is string => typeof value === 'string' && new RegExp(`^0x[\\da-fA-F]{${digits}}$`).test(value)
function range(value: unknown): EntryRange {
  const row = object(value)
  if (!integer(row.tierId, 65535) || row.tierId < 1 || !text(row.label, 1000) || (row.lower !== null && !number(row.lower)) || (row.upper !== null && !number(row.upper))) fail()
  return row as EntryRange
}
function sameRange(a: EntryRange, b: EntryRange) { return a.tierId === b.tierId && a.label === b.label && a.lower === b.lower && a.upper === b.upper }
function cursor(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{1,78}:\d{1,10}$/.test(value)) return false
  const [block, index] = value.split(':')
  return uint(block) && integer(Number(index), 2147483647)
}
export function validateMetalogEntries(value: unknown, context: EntryContext, continuation: EntryContinuation = {}): MetalogEntriesPage {
  if (context.protocol !== 'defifa') fail()
  const page = object(value)
  if (page.schema !== 'metalog.entries.v1' || page.chainId !== context.chainId || page.projectId !== String(context.projectId) || !hex(page.hook, 40) || page.hook.toLowerCase() !== context.hook.toLowerCase() || !uint(page.blockNumber) || !hex(page.snapshotBlockHash, 64)) fail()
  if (continuation.blockNumber && page.blockNumber !== continuation.blockNumber || continuation.snapshotBlockHash && page.snapshotBlockHash !== continuation.snapshotBlockHash) fail()
  const ranges = array(page.ranges, 61, 3).map(range)
  if (ranges[0].lower !== null || ranges.at(-1)!.upper !== null || new Set(ranges.map(r => r.tierId)).size !== ranges.length) fail()
  ranges.forEach((row, index) => {
    if (index > 0 && row.lower !== ranges[index - 1].upper || index < ranges.length - 1 && row.upper === null || index > 0 && row.lower === null || row.lower !== null && row.upper !== null && row.lower >= row.upper) fail()
  })
  if (typeof page.complete !== 'boolean' || (page.nextCursor !== null && !cursor(page.nextCursor)) || page.complete !== (page.nextCursor === null)) fail()
  if (page.nextCursor !== null && BigInt((page.nextCursor as string).split(':')[0]) > BigInt(page.blockNumber as string)) fail()
  if (continuation.cursor && page.nextCursor) {
    const [a, ai] = (page.nextCursor as string).split(':').map(BigInt), [b, bi] = continuation.cursor.split(':').map(BigInt)
    if (a > b || a === b && ai >= bi) fail()
  }
  if (page.scannedFromBlock === null || page.scannedToBlock === null) {
    if (page.scannedFromBlock !== null || page.scannedToBlock !== null || !page.complete) fail()
  } else if (!uint(page.scannedFromBlock) || !uint(page.scannedToBlock) || BigInt(page.scannedFromBlock) > BigInt(page.scannedToBlock) || BigInt(page.scannedToBlock) > BigInt(page.blockNumber as string) || BigInt(page.scannedToBlock) - BigInt(page.scannedFromBlock) >= 2000n) fail()
  const entries = array(page.entries, 8)
  const seen = new Set<string>()
  for (const item of entries) {
    const entry = object(item)
    if (!['verified-curve', 'verified-manual', 'unrecognized', 'unsupported', 'invalid'].includes(String(entry.status)) || !hex(entry.transactionHash, 64) || seen.has(entry.transactionHash) || !uint(entry.blockNumber) || BigInt(entry.blockNumber) > BigInt(page.blockNumber as string) || page.scannedFromBlock !== null && BigInt(entry.blockNumber) < BigInt(page.scannedFromBlock as string) || page.scannedToBlock !== null && BigInt(entry.blockNumber) > BigInt(page.scannedToBlock as string) || !integer(entry.timestamp, 8640000000000) || !hex(entry.account, 40) || entry.beneficiary !== null && !hex(entry.beneficiary, 40) || entry.stakeWei !== null && !uint(entry.stakeWei) || entry.reason !== undefined && !text(entry.reason, 4000) || entry.chartError !== undefined && !text(entry.chartError, 4000)) fail()
    seen.add(entry.transactionHash as string)
    const tokens = array(entry.tokenIds, 10000)
    if (tokens.some(t => !uint(t)) || new Set(tokens).size !== tokens.length) fail()
    const quantities = array(entry.quantities, 61)
    if (quantities.length !== ranges.length || quantities.some(q => !integer(q, 10000)) || quantities.reduce<number>((n, q) => n + (q as number), 0) !== tokens.length) fail()
    if (entry.coefficients !== null && array(entry.coefficients, 6, 2).some(v => !number(v))) fail()
    const recognized = entry.status === 'verified-curve' || entry.status === 'verified-manual'
    // Canonical Metalog entries are bounded by the API's original allocation contract.
    if (recognized && (entry.coefficients === null || entry.stakeWei === null || entry.beneficiary === null || tokens.length < 1 || tokens.length > 200)) fail()
    if (!recognized && entry.chart !== null || entry.chart !== null && entry.coefficients === null) fail()
    if (entry.chart !== null) {
      const chart = object(entry.chart)
      if (!number(chart.low) || !number(chart.high) || chart.low >= chart.high || !number(chart.high - chart.low) || !number(chart.peak) || chart.peak < 0) fail()
      let end = chart.low as number
      for (const value of array(chart.buckets, 600, 1)) {
        const b = object(value)
        if (!number(b.lower) || !number(b.upper) || b.lower !== end || b.upper <= b.lower || b.upper > (chart.high as number) || !number(b.density) || b.density < 0 || !number(b.mass) || b.mass < 0 || b.mass > 1) fail()
        end = b.upper as number
      }
      if (end !== chart.high) fail()
      const positions = array(chart.positions, 61)
      if (positions.length !== ranges.length) fail()
      positions.forEach((v, i) => {
        const p = object(v)
        if (!sameRange(range(p.range), ranges[i]) || p.quantity !== quantities[i] || !number(p.share) || p.share < 0 || p.share > 1 || p.density !== null && (!number(p.density) || p.density < 0)) fail()
      })
    }
  }
  if (page.scannedFromBlock === null && entries.length) fail()
  return page as MetalogEntriesPage
}
export async function readMetalogEntries(context: EntryContext, continuation: EntryContinuation, signal?: AbortSignal): Promise<MetalogEntriesPage> {
  const params = new URLSearchParams()
  if (continuation.blockNumber) params.set('blockNumber', continuation.blockNumber)
  if (continuation.cursor) params.set('cursor', continuation.cursor)
  const response = await fetch(`https://metalog.money/api/markets/${context.chainId}/${context.projectId}/entries?${params}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error('Entry receipts could not be verified. Try again.')
  const body = await response.text()
  if (body.length > 5_000_000) fail()
  return validateMetalogEntries(JSON.parse(body), context, continuation)
}
