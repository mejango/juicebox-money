'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatEther } from 'viem'
import { explorerHostname } from '@/lib/chainDisplay'
import { readMetalogEntries, type EntryContext, type EntryContinuation, type EntryChart, type MetalogEntry, type MetalogEntriesPage } from '@/lib/metalog-entries'

function download(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url)
}
const utc = (seconds: number) => new Date(seconds * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

export function DefifaEntries({ context }: { context: EntryContext }) {
  const queryClient = useQueryClient()
  const [continuation, setContinuation] = useState<EntryContinuation>({})
  const query = useQuery({
    queryKey: ['defifa-entries', context.chainId, context.projectId, context.hook, continuation.blockNumber, continuation.cursor],
    queryFn: ({ signal }) => readMetalogEntries(context, continuation, signal),
    staleTime: Infinity, retry: false, refetchOnWindowFocus: false,
  })
  function refresh() {
    if (!continuation.cursor) { void query.refetch(); return }
    void queryClient.invalidateQueries({ queryKey: ['defifa-entries', context.chainId, context.projectId, context.hook, undefined, undefined], exact: true, refetchType: 'none' })
    setContinuation({})
  }
  const page = query.data
  return <section aria-label="Original entries" className="space-y-4 text-sm">
    <p className="text-smoke-600">Original submissions and minted positions. Transfers do not change an entry.</p>
    <button type="button" className="btn-secondary px-3 py-2" disabled={query.isFetching} onClick={refresh}>Refresh entries</button>
    {query.isFetching && <p role="status">Checking entry receipts…</p>}
    {query.error && <div role="alert" className="space-y-2"><p>{query.error.message}</p><button className="underline" type="button" onClick={() => void query.refetch()}>Retry entries</button></div>}
    {page && <>
      <p className="text-smoke-600">Snapshot block {page.blockNumber}. {page.scannedFromBlock !== null && <>Checked blocks {page.scannedFromBlock}–{page.scannedToBlock}.</>}</p>
      {!page.entries.length && <p>{page.scannedFromBlock === null ? 'The entry period has not started at this snapshot.' : page.complete ? 'No entries in this part of the entry period.' : 'No entries in these blocks. Older blocks remain unchecked.'}</p>}
      {page.entries.map(entry => <Entry key={entry.transactionHash} entry={entry} context={context} page={page} />)}
      <div className="flex flex-wrap gap-3">
        {page.nextCursor && <button className="btn-secondary px-3 py-2" type="button" disabled={query.isFetching} onClick={() => setContinuation({ blockNumber: page.blockNumber, snapshotBlockHash: page.snapshotBlockHash, cursor: page.nextCursor! })}>Load older entries</button>}
        <button className="underline" type="button" onClick={() => download(page, `metalog-${context.chainId}-${context.projectId}-entries.json`)}>Download page JSON</button>
      </div>
      <p className="text-smoke-600">{page.scannedFromBlock === null ? 'The entry period has not started at this snapshot.' : page.complete ? 'Reached the start of the entry period.' : 'History is incomplete. Load older entries to continue.'}</p>
    </>}
  </section>
}

function Entry({ entry, context, page }: { entry: MetalogEntry; context: EntryContext; page: MetalogEntriesPage }) {
  const ranges = page.ranges
  const explorer = `https://${explorerHostname(context.chainId)}`
  const recognized = entry.status === 'verified-curve' || entry.status === 'verified-manual'
  return <details className="border-t border-smoke-200 py-3">
    <summary className="cursor-pointer font-medium">{utc(entry.timestamp)} | {short(entry.account)} | {entry.stakeWei === null ? 'Stake unavailable' : `${formatEther(BigInt(entry.stakeWei))} ETH`} | {entry.status === 'verified-curve' ? 'Curve entry' : entry.status === 'verified-manual' ? 'By range entry' : 'Curve unavailable'}</summary>
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap gap-3"><a className="underline" href={`${explorer}/tx/${entry.transactionHash}`} target="_blank" rel="noreferrer">View mint receipt</a><button className="underline" type="button" onClick={() => download({ ...page, exportScope: 'single-entry', entries: [entry] }, `metalog-entry-${entry.transactionHash}.json`)}>Download entry JSON</button></div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt>Account</dt><dd className="break-all"><a className="underline" href={`${explorer}/address/${entry.account}`}>{entry.account}</a></dd>
        <dt>Recipient</dt><dd className="break-all">{entry.beneficiary ?? 'Multiple recipients; see receipt.'}</dd>
        <dt>Block</dt><dd>{entry.blockNumber}</dd><dt>Minted NFTs</dt><dd>{entry.tokenIds.length}</dd>
      </dl>
      {recognized && entry.chart && <EntryChartView chart={entry.chart} reference={entry.status === 'verified-manual'} />}
      {recognized && entry.coefficients && <p className="break-all">a-coefficients: <code>{JSON.stringify(entry.coefficients)}</code></p>}
      {entry.status === 'verified-manual' && entry.chart && <p className="text-smoke-600">Counts were set by range; the curve is reference evidence.</p>}
      {(!recognized || !entry.chart) && <p className="text-smoke-600">{entry.chartError || entry.reason || 'A supported curve display is unavailable; minted counts remain receipt evidence.'}</p>}
      <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr><th className="py-2 font-medium">Range</th><th className="py-2 text-right font-medium">Minted NFTs</th></tr></thead><tbody>{ranges.map((range, i) => <tr className="border-t border-smoke-100" key={range.tierId}><td className="py-2 pr-3">{range.label}</td><td className="py-2 text-right tabular-nums">{entry.quantities[i]}</td></tr>)}</tbody></table></div>
      <details><summary className="cursor-pointer">Minted token IDs</summary><p className="mt-2 break-all">{entry.tokenIds.join(', ')}</p></details>
    </div>
  </details>
}

/** Rendering coordinates only; Metalog supplies every curve and position density. */
function EntryChartView({ chart, reference }: { chart: EntryChart; reference: boolean }) {
  const peak = Math.max(chart.peak, ...chart.positions.map(p => p.density ?? 0)) || 1
  const x = (value: number) => 40 + (value - chart.low) / (chart.high - chart.low) * 620
  const y = (density: number) => 190 - density / peak * 170
  const points = chart.buckets.map(bucket => `${x(bucket.lower + (bucket.upper - bucket.lower) / 2)},${y(bucket.density)}`).join(' ')
  return <figure className="space-y-2"><svg viewBox="0 0 700 230" role="img" aria-label={`${reference ? 'Reference curve' : 'Submitted curve'} and actual minted position density`} className="w-full">
    {chart.positions.map(p => p.density !== null && p.range.lower !== null && p.range.upper !== null ? <rect key={p.range.tierId} x={x(p.range.lower)} y={y(p.density)} width={x(p.range.upper) - x(p.range.lower)} height={190 - y(p.density)} fill="currentColor" className="text-bluebs-600 opacity-25"><title>{p.range.label}: {p.quantity} NFTs</title></rect> : null)}
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" className="text-bluebs-600" />
    <path d="M40 190H660" stroke="currentColor" className="text-smoke-300" />
    {[chart.low, chart.low + (chart.high - chart.low) / 2, chart.high].map((value, i) => <text key={i} x={x(value)} y="215" textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} fontSize="12" fill="currentColor">{Number(value.toPrecision(5))}%</text>)}
  </svg><figcaption className="text-smoke-600">{reference ? 'Reference curve' : 'Submitted curve'}. Bars show actual minted position density. Outer ranges are listed below.</figcaption></figure>
}
