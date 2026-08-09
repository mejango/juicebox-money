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
    <div
      role="group"
      aria-label="Pool price detail"
      className="flex shrink-0 gap-1 rounded-lg bg-smoke-75 p-1"
    >
      {([
        ['smooth', 'Smooth', 'Show time-weighted averages of the pool price'],
        ['trades', 'Every trade', 'Show every exact post-trade pool price'],
      ] as const).map(([option, label, title]) => (
        <button
          key={option}
          type="button"
          title={title}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`min-h-11 rounded-md px-3 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bluebs-400 ${
            value === option
              ? 'bg-white text-bluebs-700 shadow-sm'
              : 'text-smoke-700 hover:bg-white/70 hover:text-ink'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
