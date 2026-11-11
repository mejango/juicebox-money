'use client'

export type MarketPriceView = 'smooth' | 'trades'

const OPTIONS: [MarketPriceView, string, string][] = [
  ['smooth', 'Smooth', 'Show time-weighted averages of the pool price'],
  ['trades', 'Every trade', 'Show every exact post-trade pool price'],
]

/** Two compact chips: small enough to sit on a chart's legend line. */
export function MarketPriceViewToggle({
  value,
  onChange,
}: {
  value: MarketPriceView
  onChange: (value: MarketPriceView) => void
}) {
  return (
    <div role="group" aria-label="Pool price detail" className="inline-flex shrink-0 gap-1.5">
      {OPTIONS.map(([view, label, title]) => (
        <button
          key={view}
          type="button"
          onClick={() => onChange(view)}
          aria-pressed={value === view}
          title={title}
          className={`whitespace-nowrap rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none ${
            value === view
              ? 'border-bluebs-500 bg-bluebs-25 text-bluebs-700'
              : 'border-grey-300 bg-white text-grey-700 hover:border-bluebs-300 hover:text-bluebs-600'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
