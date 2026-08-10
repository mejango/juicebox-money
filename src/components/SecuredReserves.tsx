import type { HomepageReserves } from '@/lib/homepage-reserves'

function amount(value: number, maximumFractionDigits: number) {
  return value.toLocaleString('en-US', { maximumFractionDigits })
}

export function SecuredReserves({ data }: { data: HomepageReserves }) {
  const values = data.points.map(point => point.valueUsd)
  const min = Math.min(...values, 0)
  const max = Math.max(...values, 1)
  const span = Math.max(max - min, 1)
  const path = data.points
    .map((point, index) => {
      const x = data.points.length < 2 ? 100 : (index / (data.points.length - 1)) * 100
      const y = 30 - ((point.valueUsd - min) / span) * 26
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')

  return (
    <section className="mb-6 flex min-h-20 flex-col items-stretch gap-3 border-y border-smoke-200 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <p className="font-agrandir text-base font-medium leading-snug sm:text-lg">
        Juicebox currently secures{' '}
        <span className="tabular-nums">{amount(data.eth, 3)} ETH</span>,{' '}
        <span className="tabular-nums">{amount(data.usdc, 0)} USDC</span>, and other reserve assets.
      </p>
      {path ? (
        <svg
          viewBox="0 0 100 34"
          className="h-10 w-full shrink-0 overflow-visible sm:h-12 sm:w-48"
          role="img"
          aria-label="Change in secured reserve value over time, valued at current prices"
        >
          <polyline
            points={path}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            className="text-bluebs-500"
          />
        </svg>
      ) : null}
    </section>
  )
}
