import type { MetalogEntriesPage } from '@/lib/metalog-entries'
const entryHook = '0x1111111111111111111111111111111111111111'
export const entryContext = { protocol: 'defifa' as const, chainId: 1, projectId: 1, hook: entryHook }
export function entryPage(): MetalogEntriesPage {
  const ranges = ['Rekt', 'FUD', 'Copium', 'Crab', 'Hopium', 'FOMO', 'Moon'].map((label, i) => ({ tierId: i + 1, label, lower: i === 0 ? null : i - 3.5, upper: i === 6 ? null : i - 2.5 }))
  const quantities = [0, 0, 0, 4, 0, 0, 0]
  return {
    schema: 'metalog.entries.v1', chainId: 1, projectId: '1', blockNumber: '100', snapshotBlockHash: `0x${'a'.repeat(64)}`, hook: entryHook, ranges,
    scannedFromBlock: '90', scannedToBlock: '100', complete: false, nextCursor: '89:2147483647',
    entries: [{ status: 'verified-curve', transactionHash: `0x${'b'.repeat(64)}`, blockNumber: '95', timestamp: 1700000000, account: entryHook, beneficiary: entryHook, stakeWei: '4000000', tokenIds: ['1', '2', '3', '4'], quantities, coefficients: [0, 1],
      chart: { low: -2.5, high: 2.5, peak: .4,
        buckets: Array.from({ length: 5 }, (_, i) => ({ lower: i - 2.5, upper: i - 1.5, density: [.1, .2, .4, .2, .1][i], mass: [.1, .2, .4, .2, .1][i] })),
        positions: ranges.map((range, i) => ({ range, quantity: quantities[i], share: quantities[i] / 4, density: i === 0 || i === 6 ? null : quantities[i] / 4 })),
      },
    }],
  }
}
