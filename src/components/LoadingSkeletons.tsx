import { Skeleton, SkeletonLines, SkeletonTable } from './ui/Skeleton'
import { HomepageDiscoveryTabs } from './HomepageDiscoveryTabs'
import { ProjectLogoWithFallback } from './ProjectLogoWithFallback'
import { Revalidating } from './ui/Revalidating'
import type { ProjectNavigationHint } from '@/lib/project-navigation'

export function ProjectCardSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div className="card flex min-h-[190px] flex-col justify-between gap-4 p-4 sm:p-5">
      <div>
        <div className="flex items-center gap-3.5">
          <Skeleton className="h-14 w-14 shrink-0 rounded-lg" />
          <Skeleton
            className={`h-5 rounded ${index % 2 === 0 ? 'w-40' : 'w-28'}`}
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Skeleton className="h-3 w-7 rounded" />
          <Skeleton className="h-[18px] w-[18px] rounded-full" />
          <Skeleton className="h-[18px] w-[18px] rounded-full" />
        </div>
        <SkeletonLines lines={index % 3 === 0 ? 2 : 1} className="mt-3" />
      </div>
      <div className="flex items-end gap-5">
        <SkeletonLines lines={2} className="w-24" />
        <SkeletonLines lines={2} className="w-16" />
        <Skeleton className="ml-auto h-6 w-10 rounded-full" />
      </div>
    </div>
  )
}

export function ActivityRows({ rows = 7 }: { rows?: number }) {
  return (
    <div className="divide-y divide-smoke-100" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex min-h-[112px] items-start gap-3 px-4 py-4">
          <Skeleton className="h-[46px] w-[46px] shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex justify-between gap-3">
              <Skeleton className="h-2.5 w-12 rounded" />
              <Skeleton className="h-2.5 w-14 rounded" />
            </div>
            <Skeleton className={`h-3.5 rounded ${index % 2 ? 'w-28' : 'w-36'}`} />
            <Skeleton className="h-3 w-4/5 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function ActivityRailSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div className="card overflow-hidden" role="status" aria-label="Loading activity">
      <span className="sr-only">Loading activity</span>
      <ActivityRows rows={rows} />
    </div>
  )
}

export function HomepageDiscoverySkeleton() {
  return (
    <section
      id="trending"
      className="mx-auto max-w-6xl px-4 pb-0 pt-8 sm:px-6 sm:pt-16"
      role="status"
      aria-label="Loading projects and activity"
    >
      <span className="sr-only">Loading projects and activity</span>
      <HomepageDiscoveryTabs
        name="homepage-discovery-loading"
        trending={
          <>
            <h2 className="mb-5 hidden font-agrandir text-2xl font-medium sm:text-3xl lg:block">
              Trending projects
            </h2>
            <div className="space-y-3 sm:hidden">
              {Array.from({ length: 4 }, (_, index) => (
                <ProjectCardSkeleton key={index} index={index} />
              ))}
            </div>
            <div className="hidden items-start gap-3 sm:grid sm:grid-cols-2">
              {[0, 1].map(column => (
                <div key={column} className="flex flex-col gap-3">
                  {Array.from({ length: 3 }, (_, index) => (
                    <ProjectCardSkeleton
                      key={index}
                      index={index * 2 + column}
                    />
                  ))}
                </div>
              ))}
            </div>
          </>
        }
        activity={
          <>
            <h2 className="mb-5 hidden font-agrandir text-2xl font-medium sm:text-3xl lg:block">
              Fresh activity
            </h2>
            <ActivityRailSkeleton rows={6} />
          </>
        }
      />
    </section>
  )
}

function SteppedChartSkeleton({
  summaryTiles = 0,
  rangeButtons = 4,
}: {
  summaryTiles?: number
  rangeButtons?: number
} = {}) {
  return (
    <div className="mt-3 rounded-xl border border-smoke-200 bg-white p-4" aria-hidden="true">
      {summaryTiles > 0 ? (
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          {Array.from({ length: summaryTiles }, (_, index) => (
            <div key={index} className="space-y-2 rounded-lg bg-smoke-75 px-3 py-2">
              <Skeleton className="h-3 w-24 rounded" />
              <Skeleton className="h-3 w-20 rounded" />
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-3 w-32 rounded" />
        <div className="flex gap-1">
          {Array.from({ length: rangeButtons }, (_, index) => (
            <Skeleton key={index} className="h-8 w-10 rounded-lg" />
          ))}
        </div>
      </div>
      <svg viewBox="0 0 320 180" className="mt-2 h-auto w-full" preserveAspectRatio="none">
        <line x1="12" y1="158" x2="308" y2="158" stroke="#D4D1C7" strokeWidth="1" />
        <line x1="12" y1="158" x2="12" y2="16" stroke="#D4D1C7" strokeWidth="1" />
        <line x1="132" y1="16" x2="132" y2="158" stroke="#E4E1D9" strokeWidth="1" strokeDasharray="3 3" />
        <line x1="184" y1="16" x2="184" y2="158" stroke="#E4E1D9" strokeWidth="1" strokeDasharray="4 3" />
        <path
          d="M12 158 H52 V155 H76 V151 H96 V144 H118 V136 H132 V124 H148 V118 H164 V109 H181 V99 H196 V89 H211 V78 H226 V67 H241 V55 H256 V42 H272 V29 H287 V17 H300"
          fill="none"
          stroke="#E9E6DE"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <Skeleton className="mt-2 h-3 w-52 rounded" />
    </div>
  )
}

export function PriceChartSkeleton() {
  return (
    <div role="status" aria-label="Loading price chart">
      <span className="sr-only">Loading price chart</span>
      <SteppedChartSkeleton summaryTiles={3} rangeButtons={6} />
    </div>
  )
}

export function TermsTabSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading terms">
      <span className="sr-only">Loading terms</span>
      <div className="card p-6">
        <span className="field-label">Token issuance</span>
        <div className="mt-3 flex items-end gap-2" aria-hidden="true">
          <Skeleton className="h-7 w-40 rounded" />
          <Skeleton className="h-4 w-20 rounded" />
        </div>
        <div className="mt-3 space-y-2" aria-hidden="true">
          <Skeleton className="h-3 w-72 max-w-full rounded" />
          <Skeleton className="h-3 w-60 max-w-[85%] rounded" />
        </div>
        <SteppedChartSkeleton />
      </div>
      <div className="card p-5">
        <span className="field-label">Stages</span>
        <SkeletonTable rows={4} columns={5} className="mt-4" />
      </div>
    </div>
  )
}

function ShopItemSkeleton({ index }: { index: number }) {
  return (
    <div className="card overflow-hidden" aria-hidden="true">
      <Skeleton className="aspect-square w-full" />
      <div className="space-y-2.5 p-4">
        <Skeleton className={`h-4 rounded ${index % 2 ? 'w-20' : 'w-28'}`} />
        <Skeleton className="h-3 w-4/5 rounded" />
        <Skeleton className="h-4 w-16 rounded" />
        <div className="flex items-center justify-between pt-2">
          <Skeleton className="h-3 w-14 rounded" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-3 w-3 rounded" />
            <Skeleton className="h-8 w-8 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  )
}

export function ShopTabSkeleton() {
  const chipWidths = ['w-14', 'w-24', 'w-20', 'w-24', 'w-20', 'w-16', 'w-20', 'w-24']

  return (
    <div role="status" aria-label="Loading shop">
      <span className="sr-only">Loading shop</span>
      <div className="flex min-h-[40px] gap-6 border-b border-smoke-200">
        <span className="border-b-2 border-ink px-1 pb-2 font-agrandir text-sm font-medium">Inventory</span>
        <span className="px-1 pb-2 font-agrandir text-sm font-medium text-smoke-500">Customers</span>
      </div>
      <div className="space-y-5 pt-4">
        <div className="flex justify-end" aria-hidden="true">
          <Skeleton className="h-4 w-24 rounded" />
        </div>
        <div className="flex flex-wrap gap-1.5" aria-hidden="true">
          {chipWidths.map((width, index) => (
            <Skeleton key={index} className={`h-10 ${width} rounded-lg`} />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <ShopItemSkeleton key={index} index={index} />
          ))}
        </div>
        <div className="card p-5" aria-hidden="true">
          <Skeleton className="h-3 w-20 rounded" />
          <div className="mt-3 space-y-3">
            <div className="flex justify-between gap-4"><Skeleton className="h-3 w-16 rounded" /><Skeleton className="h-3 w-32 rounded" /></div>
            <div className="flex justify-between gap-4"><Skeleton className="h-3 w-20 rounded" /><Skeleton className="h-3 w-28 rounded" /></div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function FundsTabSkeleton() {
  return (
    <div className="card p-6" role="status" aria-label="Loading funds">
      <span className="sr-only">Loading funds</span>
      <span className="field-label">Funds</span>
      <Skeleton className="mt-3 h-3 w-24 rounded" />
      <Skeleton className="mt-2 h-7 w-32 rounded" />
      <div className="mt-5 flex gap-6 border-b border-smoke-200 pb-2" aria-hidden="true">
        <Skeleton className="h-4 w-24 rounded" />
        <Skeleton className="h-4 w-20 rounded" />
      </div>
      <Skeleton className="mt-5 h-3 w-16 rounded" />
      <Skeleton className="mt-2 h-7 w-28 rounded" />
      <SkeletonTable rows={4} columns={4} className="mt-6" />
      <div className="mt-6 grid gap-6 border-t border-smoke-200 pt-6 lg:grid-cols-2" aria-hidden="true">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="space-y-3 lg:first:border-r lg:first:border-smoke-200 lg:first:pr-6">
            <Skeleton className="h-3 w-4/5 rounded" />
            <Skeleton className="h-5 w-32 rounded" />
            <Skeleton className="h-10 w-40 rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function RulesetsTabSkeleton() {
  return (
    <div className="card p-6" role="status" aria-label="Loading rulesets">
      <span className="sr-only">Loading rulesets</span>
      <div className="flex items-center justify-center gap-4" aria-hidden="true">
        <Skeleton className="h-9 w-9 rounded-full" />
        <Skeleton className="h-6 w-36 rounded" />
        <Skeleton className="h-9 w-9 rounded-full" />
      </div>
      <Skeleton className="mx-auto mt-3 h-3 w-52 rounded" />
      {['Cycle', 'Token rules', 'Funds access'].map((label, section) => (
        <section key={label} className="mt-7 border-t border-smoke-200 pt-6">
          <span className="field-label">{label}</span>
          <div className={`mt-4 grid gap-5 ${section === 0 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`} aria-hidden="true">
            {Array.from({ length: section === 0 ? 6 : 4 }, (_, index) => (
              <div key={index} className="space-y-2">
                <Skeleton className="h-3 w-24 rounded" />
                <Skeleton className="h-4 w-32 max-w-full rounded" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export function TokenPanelSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className="card p-5" role="status" aria-label="Loading token details">
      <span className="sr-only">Loading token details</span>
      <span className="field-label">Token</span>
      <div className={compact ? 'mt-3 flex flex-wrap gap-x-6 gap-y-3' : 'mt-3 space-y-3'} aria-hidden="true">
        {Array.from({ length: compact ? 3 : 5 }, (_, index) => (
          <div key={index} className="flex min-w-28 items-center justify-between gap-4">
            <Skeleton className="h-3 w-14 rounded" />
            <Skeleton className="h-3 w-20 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Ghost of the standalone market price chart: headline, range pills, plot. */
function MarketPriceChartSkeleton() {
  return (
    <div className="card p-5" aria-hidden="true">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Skeleton className="h-3 w-24 rounded" />
          <Skeleton className="mt-3 h-7 w-44 rounded" />
          <Skeleton className="mt-2 h-3 w-32 rounded" />
        </div>
        <div className="flex gap-1">
          {['1H', '6H', '1D', '7D', '30D', '3M', '1Y', 'All'].map(range => (
            <Skeleton key={range} className="h-11 w-11 rounded-lg" />
          ))}
        </div>
      </div>
      <Skeleton className="mt-4 h-40 w-full rounded-lg" />
      <Skeleton className="mt-4 h-3 w-3/4 rounded" />
    </div>
  )
}

export function MarketSectionSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading market">
      <span className="sr-only">Loading market</span>
      <MarketPriceChartSkeleton />
      <div className="card p-5">
        <div className="flex items-center gap-2" aria-hidden="true">
          <Skeleton className="h-3 w-24 rounded" />
          <Skeleton className="h-5 w-12 rounded-full" />
        </div>
        <Skeleton className="mt-4 h-5 w-48 rounded" />
        <Skeleton className="mt-2 h-3 w-36 rounded" />
        <div className="mt-5 space-y-3 border-t border-smoke-100 pt-4" aria-hidden="true">
          <div className="flex justify-between"><Skeleton className="h-3 w-36 rounded" /><Skeleton className="h-3 w-24 rounded" /></div>
          <div className="flex justify-between"><Skeleton className="h-3 w-32 rounded" /><Skeleton className="h-3 w-20 rounded" /></div>
        </div>
      </div>
      <div className="card p-5">
        <div className="flex items-center gap-2" aria-hidden="true">
          <Skeleton className="h-3 w-20 rounded" />
          <Skeleton className="h-5 w-8 rounded-full" />
        </div>
        <LiquidityBodySkeleton />
      </div>
    </div>
  )
}

export function FormCardSkeleton({
  label = 'Loading form',
  framed = true,
}: {
  label?: string
  framed?: boolean
}) {
  return (
    <div
      className={framed ? 'card p-5' : ''}
      role="status"
      aria-label={label}
    >
      <span className="sr-only">{label}</span>
      <Skeleton className="h-3 w-28 rounded" />
      <div className="mt-5 grid gap-4 sm:grid-cols-2" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-5 h-10 w-36 rounded-lg" />
    </div>
  )
}

export function CustomerCardSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="card p-5" role="status" aria-label="Loading customers">
      <span className="sr-only">Loading customers</span>
      <Skeleton className="h-3 w-16 rounded" />
      <div className="mt-4 divide-y divide-smoke-100" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-3 py-3">
            <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3 w-36 max-w-[70%] rounded" />
              <Skeleton className="h-3 w-24 rounded" />
            </div>
            <Skeleton className="h-3 w-16 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function HolderDistributionSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      className="mt-4 grid items-start gap-6 md:grid-cols-[minmax(200px,280px)_minmax(0,1fr)]"
      role="status"
      aria-label="Loading token holders"
    >
      <span className="sr-only">Loading token holders</span>
      <div className="flex flex-col items-center gap-3" aria-hidden="true">
        <Skeleton className="aspect-square w-44 max-w-full rounded-full" />
        <Skeleton className="h-3 w-28 rounded" />
      </div>
      <div className="rounded-xl border border-smoke-200 p-4" aria-hidden="true">
        <SkeletonTable rows={rows} columns={4} />
      </div>
    </div>
  )
}

export function SplitsCardSkeleton({ isRevnet = false }: { isRevnet?: boolean }) {
  return (
    <div className="card p-5" role="status" aria-label="Loading token splits">
      <span className="sr-only">Loading token splits</span>
      <span className="field-label">{isRevnet ? 'Splits' : 'Reserved tokens'}</span>
      <Skeleton className="mt-3 h-3 w-4/5 rounded" />
      {isRevnet ? (
        <div className="mt-5 flex gap-5" aria-hidden="true">
          <Skeleton className="h-7 w-16 rounded" />
          <Skeleton className="h-7 w-16 rounded" />
          <Skeleton className="h-7 w-16 rounded" />
        </div>
      ) : null}
      <Skeleton className="mt-4 h-3 w-64 max-w-full rounded" />
      <SkeletonTable rows={4} columns={3} className="mt-5" />
    </div>
  )
}

export function AccountGroupsSkeleton() {
  return (
    <div className="mt-4 space-y-4" role="status" aria-label="Loading project control">
      <span className="sr-only">Loading project control</span>
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="rounded-xl border border-smoke-200 p-4" aria-hidden="true">
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
          <div className="mt-3 flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-36 rounded" />
            <Skeleton className="h-9 w-24 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function ActionRowsSkeleton({
  rows = 3,
  label = 'Loading actions',
}: {
  rows?: number
  label?: string
}) {
  return (
    <div className="mt-4 divide-y divide-smoke-100" role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-start gap-4 py-4 first:pt-0 last:pb-0" aria-hidden="true">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-40 max-w-[70%] rounded" />
            <Skeleton className="h-3 w-4/5 rounded" />
            <div className="flex gap-2">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          </div>
          <Skeleton className="h-9 w-20 shrink-0 rounded-lg" />
        </div>
      ))}
    </div>
  )
}

export function FormFieldsSkeleton({
  rows = 3,
  label = 'Loading form fields',
}: {
  rows?: number
  label?: string
}) {
  return (
    <div className="mt-4 space-y-4" role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="space-y-2" aria-hidden="true">
          <Skeleton className="h-3 w-24 rounded" />
          <Skeleton className="h-11 w-full rounded-lg" />
        </div>
      ))}
      <div className="flex justify-end" aria-hidden="true">
        <Skeleton className="h-10 w-32 rounded-lg" />
      </div>
    </div>
  )
}

export function LiquidityBodySkeleton() {
  const heights = [28, 42, 56, 72, 88, 106, 92, 76, 62, 48, 35, 24]
  return (
    <div className="mt-4 space-y-5" role="status" aria-label="Loading liquidity depth">
      <span className="sr-only">Loading liquidity depth</span>
      <div aria-hidden="true">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-3 w-28 rounded" />
          <Skeleton className="h-3 w-32 rounded" />
        </div>
        <Skeleton className="mt-3 h-3 w-full rounded-full" />
      </div>
      <div aria-hidden="true">
        <Skeleton className="h-3 w-16 rounded" />
        <div className="mt-3 flex h-36 items-end gap-1 border-b border-smoke-200 px-1">
          {heights.map((height, index) => (
            <Skeleton
              key={index}
              className="min-w-0 flex-1 rounded-t-sm"
              style={{ height }}
            />
          ))}
        </div>
        <Skeleton className="mt-3 h-3 w-52 rounded" />
      </div>
    </div>
  )
}

export function MovementGroupsSkeleton({ groups = 2 }: { groups?: number }) {
  return (
    <div className="mt-4 space-y-4" role="status" aria-label="Loading queued movements">
      <span className="sr-only">Loading queued movements</span>
      {Array.from({ length: groups }, (_, group) => (
        <div key={group} className="rounded-xl border border-smoke-200 p-4" aria-hidden="true">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded-full" />
            <Skeleton className="h-3 w-16 rounded" />
            <Skeleton className="h-3 w-3 rounded" />
            <Skeleton className="h-4 w-4 rounded-full" />
            <Skeleton className="h-3 w-20 rounded" />
          </div>
          <SkeletonTable rows={2} columns={5} className="mt-3" />
          {group === 0 ? <Skeleton className="mt-3 h-10 w-48 rounded-lg" /> : null}
        </div>
      ))}
    </div>
  )
}

export function GossipTablesSkeleton({ groups = 2 }: { groups?: number }) {
  return (
    <div className="mt-5 space-y-6" role="status" aria-label="Loading cross-chain accounting">
      <span className="sr-only">Loading cross-chain accounting</span>
      {Array.from({ length: groups }, (_, index) => (
        <div key={index} aria-hidden="true">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded-full" />
            <Skeleton className="h-4 w-32 rounded" />
          </div>
          <SkeletonTable rows={Math.max(groups - 1, 2)} columns={6} className="mt-3" />
        </div>
      ))}
    </div>
  )
}

export function SafeQueueSkeleton({ groups = 2 }: { groups?: number }) {
  return (
    <div className="mt-4 space-y-5" role="status" aria-label="Loading multisig transactions">
      <span className="sr-only">Loading multisig transactions</span>
      {Array.from({ length: groups }, (_, group) => (
        <div key={group} className="overflow-hidden rounded-xl border border-smoke-200" aria-hidden="true">
          <div className="flex items-center justify-between gap-3 border-b border-smoke-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded-full" />
              <Skeleton className="h-4 w-24 rounded" />
              <Skeleton className="h-3 w-16 rounded" />
            </div>
            <Skeleton className="h-3 w-20 rounded" />
          </div>
          <div className="divide-y divide-smoke-100">
            {Array.from({ length: group === 0 ? 2 : 1 }, (_, row) => (
              <div key={row} className="flex items-start gap-4 px-4 py-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-3 w-4/5 rounded" />
                  <div className="flex gap-2">
                    <Skeleton className="h-5 w-16 rounded-full" />
                    <Skeleton className="h-5 w-20 rounded-full" />
                  </div>
                </div>
                <Skeleton className="h-9 w-20 shrink-0 rounded-lg" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function ProjectPayPanelSkeleton() {
  return (
    <div className="rounded-xl border-2 border-bluebs-500 bg-white p-6 shadow-[0_4px_20px_-4px_rgba(87,119,235,0.25)] ring-4 ring-bluebs-500/10" aria-hidden="true">
      <div className="flex items-center gap-2"><Skeleton className="h-5 w-10 rounded" /><Skeleton className="h-4 w-28 rounded" /></div>
      <div className="mt-4 flex h-12 overflow-hidden rounded-lg border border-smoke-200">
        <Skeleton className="h-full flex-1" />
        <Skeleton className="h-full w-24" />
      </div>
      <Skeleton className="mt-3 h-12 w-full rounded-lg" />
    </div>
  )
}

function OverviewTabSkeleton() {
  return (
    <div className="space-y-5" aria-hidden="true">
      <div className="card p-5">
        <Skeleton className="h-3 w-20 rounded" />
        <SkeletonLines lines={4} className="mt-4" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TokenPanelSkeleton />
        <div className="card p-5">
          <Skeleton className="h-3 w-20 rounded" />
          <SkeletonTable rows={4} columns={2} className="mt-4" />
        </div>
      </div>
    </div>
  )
}

export function ProjectPageSkeleton({
  hint = null,
}: {
  hint?: ProjectNavigationHint | null
} = {}) {
  return (
    <div
      className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12"
      role="status"
      aria-label="Loading project"
    >
      <span className="sr-only">Loading project</span>
      <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
        {hint ? (
          <>
            <Revalidating as="div" pending className="w-fit shrink-0 rounded-xl">
              <ProjectLogoWithFallback
                name={hint.name}
                logoUri={hint.logoUri}
                size={112}
                className="rounded-xl"
              />
            </Revalidating>
            <div className="min-w-0 flex-1 py-1">
              <Revalidating as="div" pending className="w-fit max-w-full">
                <h1 className="break-words font-agrandir text-3xl font-medium sm:text-4xl">
                  {hint.name}
                </h1>
              </Revalidating>
              {hint.tagline ? (
                <Revalidating as="div" pending className="mt-1.5 w-fit max-w-full">
                  <p className="text-base text-smoke-700 sm:text-lg">
                    {hint.tagline}
                  </p>
                </Revalidating>
              ) : (
                <Skeleton className="mt-3 h-4 w-[28rem] max-w-[85%] rounded" />
              )}
              <Skeleton className="mt-3 h-3.5 w-[34rem] max-w-full rounded" />
            </div>
          </>
        ) : (
          <>
            <Skeleton className="h-28 w-28 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-3 py-1">
              <Skeleton className="h-9 w-64 max-w-[70%] rounded" />
              <Skeleton className="h-4 w-[28rem] max-w-[85%] rounded" />
              <Skeleton className="h-3.5 w-[34rem] max-w-full rounded" />
            </div>
          </>
        )}
      </header>

      <div className="scrollbar-none -mx-4 mt-8 flex gap-3 overflow-x-auto overflow-y-hidden px-4 sm:mx-0 sm:px-0">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="card min-w-[160px] flex-1 px-4 py-3.5">
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="mt-2 h-7 w-24 rounded" />
          </div>
        ))}
      </div>

      <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-3 lg:gap-10">
        <aside className="order-1 lg:col-span-1">
          <ProjectPayPanelSkeleton />
          <Skeleton className="mb-3 mt-8 h-6 w-24 rounded" />
          <div className="card overflow-hidden">
            <ActivityRows rows={5} />
          </div>
        </aside>
        <main className="order-2 min-w-0 lg:col-span-2">
          <div className="flex gap-6 overflow-hidden border-b border-smoke-200 pb-3">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-4 w-20 shrink-0 rounded" />
            ))}
          </div>
          <div className="mt-6">
            <OverviewTabSkeleton />
          </div>
        </main>
      </div>
    </div>
  )
}
