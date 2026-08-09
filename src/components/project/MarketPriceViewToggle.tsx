'use client'

export type MarketPriceView = 'smooth' | 'trades'

export function MarketPriceViewToggle({
  value,
  onChange,
}: {
  value: MarketPriceView
  onChange: (value: MarketPriceView) => void
}) {
  return (
    <div className="relative inline-flex shrink-0 items-center border-b border-bluebs-300 text-bluebs-700">
      <select
        value={value}
        onChange={event => onChange(event.target.value as MarketPriceView)}
        aria-label="Pool price detail"
        title={
          value === 'smooth'
            ? 'Show time-weighted averages of the pool price'
            : 'Show every exact post-trade pool price'
        }
        className="cursor-pointer appearance-none bg-transparent py-1 pl-0 pr-4 text-xs font-medium text-current focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bluebs-400"
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
