import type { HomepageReserves } from '@/lib/homepage-reserves'
import { SecuredReserveChart } from './SecuredReserveChart'

function amount(value: number, maximumFractionDigits: number) {
  return value.toLocaleString('en-US', { maximumFractionDigits })
}

function usd(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function SecuredReserves({ data }: { data: HomepageReserves }) {
  return (
    <section className="flex flex-col gap-3 border-b border-smoke-200 pb-4 sm:gap-4">
      <div className="flex flex-col items-start gap-1">
        <span className="group relative inline-flex font-agrandir text-3xl font-medium leading-none sm:text-4xl">
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
        <span className="font-agrandir text-xs text-smoke-500 sm:text-sm">
          Secured by Juicebox
        </span>
      </div>
      <SecuredReserveChart points={data.points} />
    </section>
  )
}
