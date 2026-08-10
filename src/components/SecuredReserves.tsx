import type { HomepageReserves } from '@/lib/homepage-reserves'

function amount(value: number, maximumFractionDigits: number) {
  return value.toLocaleString('en-US', { maximumFractionDigits })
}

function usd(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

export function SecuredReserves({ data }: { data: HomepageReserves }) {
  const values = data.points.map(point => point.valueUsd)
  const min = Math.min(...values, 0)
  const max = Math.max(...values, 1)
  const span = Math.max(max - min, 1)
  const path = data.points
    .map((point, index) => {
      const x = data.points.length < 2 ? 100 : (index / (data.points.length - 1)) * 100
      const y = 50 - ((point.valueUsd - min) / span) * 44
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')

  return (
    <section className="flex flex-col gap-3 border-y border-smoke-200 py-4 sm:gap-4">
      <p className="font-agrandir text-base font-medium leading-snug sm:text-lg">
        Juicebox currently secures{' '}
        <span className="group relative inline-flex">
          <span
            tabIndex={0}
            aria-describedby="secured-reserves-breakdown"
            className="cursor-help tabular-nums underline decoration-dotted decoration-smoke-400 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-bluebs-500"
          >
            {usd(data.totalUsd)}
          </span>
          <span
            id="secured-reserves-breakdown"
            role="tooltip"
            className="pointer-events-none absolute left-0 top-full z-20 mt-2 hidden min-w-max rounded border border-smoke-200 bg-white px-3 py-2 text-left text-xs font-normal leading-relaxed text-smoke-700 shadow-lg group-hover:block group-focus-within:block"
          >
            <span className="block tabular-nums">ETH: {amount(data.eth, 3)}</span>
            <span className="block tabular-nums">USDC: {amount(data.usdc, 0)}</span>
            {data.otherAssets > 0 ? (
              <span className="block tabular-nums">
                Other reserve asset types: {data.otherAssets}
              </span>
            ) : null}
          </span>
        </span>
        .
      </p>
      {path ? (
        <svg
          viewBox="0 0 100 54"
          preserveAspectRatio="none"
          className="h-14 w-full overflow-visible sm:h-16"
          role="img"
          aria-label="Change in secured reserve value over time, valued at current prices"
        >
          <polyline
            points={path}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            vectorEffect="non-scaling-stroke"
            className="text-bluebs-500"
          />
        </svg>
      ) : null}
    </section>
  )
}
