'use client'

export type MarketPriceView = 'smooth' | 'trades'

/** A naked select with a chevron, the same control as ChartRangeSelect beside it. */
export function MarketPriceViewToggle({
  value,
  onChange,
}: {
  value: MarketPriceView
  onChange: (value: MarketPriceView) => void
}) {
  return (
    <div className="relative inline-flex shrink-0 items-center text-bluebs-700">
      <select
        value={value}
        onChange={event => onChange(event.target.value as MarketPriceView)}
        aria-label="Pool price detail"
        title={
          value === 'smooth'
            ? 'Show time-weighted averages of the pool price'
            : 'Show every exact post-trade pool price'
        }
        className="cursor-pointer appearance-none border-0 bg-none bg-transparent p-0 pr-4 text-xs font-medium text-current [field-sizing:content] hover:underline focus:border-0 focus:ring-0 focus-visible:!outline-none focus-visible:underline"
      >
        <option value="smooth">Smooth</option>
        <option value="trades">Every trade</option>
      </select>
      <svg
        viewBox="0 0 12 12"
        aria-hidden="true"
        className="pointer-events-none absolute right-0 h-3 w-3"
      >
        <path
          d="m2.5 4.25 3.5 3.5 3.5-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}
