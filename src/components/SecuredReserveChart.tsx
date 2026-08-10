'use client'

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { ReservePoint } from '@/lib/homepage-reserves'

const HEIGHT = 48
const TOP = 4
const BOTTOM = 4

function usd(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function compactUsd(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  })
}

function date(timestamp: number, short = false) {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(short ? {} : { year: 'numeric' }),
  })
}

export function SecuredReserveChart({ points }: { points: ReservePoint[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const chart = useMemo(() => {
    if (!points.length) return null
    const values = points.map(point => point.valueUsd)
    const minValue = Math.min(...values, 0)
    const maxValue = Math.max(...values, 1)
    const valueSpan = Math.max(maxValue - minValue, 1)
    const minTime = Math.min(...points.map(point => point.timestamp))
    const maxTime = Math.max(...points.map(point => point.timestamp))
    const timeSpan = Math.max(maxTime - minTime, 1)
    const plotted = points.map(point => ({
      ...point,
      x: ((point.timestamp - minTime) / timeSpan) * 100,
      y: HEIGHT - BOTTOM - ((point.valueUsd - minValue) / valueSpan) * (HEIGHT - TOP - BOTTOM),
    }))
    return { plotted, minValue, maxValue, minTime, maxTime }
  }, [points])

  if (!chart) return null

  const hovered = hoveredIndex === null ? null : chart.plotted[hoveredIndex]
  const path = chart.plotted.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')

  function selectNearest(event: PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - box.left) / box.width) * 100
    let nearest = 0
    for (let index = 1; index < chart!.plotted.length; index += 1) {
      if (Math.abs(chart!.plotted[index].x - x) < Math.abs(chart!.plotted[nearest].x - x)) {
        nearest = index
      }
    }
    setHoveredIndex(nearest)
  }

  function moveSelection(event: KeyboardEvent<SVGSVGElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const current = hoveredIndex ?? chart!.plotted.length - 1
    const step = event.key === 'ArrowLeft' ? -1 : 1
    setHoveredIndex(Math.max(0, Math.min(chart!.plotted.length - 1, current + step)))
  }

  return (
    <div>
      <div className="mb-1 flex min-h-5 items-center justify-end gap-4 font-agrandir text-[11px] text-smoke-600">
        {hovered ? (
          <>
            <span>Date: <span className="tabular-nums text-ink">{date(hovered.timestamp)}</span></span>
            <span>Value: <span className="tabular-nums text-ink">{usd(hovered.valueUsd)}</span></span>
          </>
        ) : (
          <span>Hover the chart for date and value</span>
        )}
      </div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <div className="flex h-14 flex-col justify-between font-agrandir text-[10px] tabular-nums text-smoke-500 sm:h-16">
          <span>{compactUsd(chart.maxValue)}</span>
          <span>{compactUsd(chart.minValue)}</span>
        </div>
        <div className="min-w-0">
          <svg
            viewBox={`0 0 100 ${HEIGHT}`}
            preserveAspectRatio="none"
            className="h-14 w-full overflow-visible text-bluebs-500 outline-none focus-visible:ring-2 focus-visible:ring-bluebs-500 sm:h-16"
            role="img"
            tabIndex={0}
            onFocus={() => setHoveredIndex(chart.plotted.length - 1)}
            onBlur={() => setHoveredIndex(null)}
            onKeyDown={moveSelection}
            aria-label="Secured reserve value over time. Focus and use arrow keys to inspect values."
          >
            <line x1="0" y1={TOP} x2="100" y2={TOP} stroke="currentColor" className="text-smoke-200" vectorEffect="non-scaling-stroke" />
            <line x1="0" y1={HEIGHT - BOTTOM} x2="100" y2={HEIGHT - BOTTOM} stroke="currentColor" className="text-smoke-200" vectorEffect="non-scaling-stroke" />
            <polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
            {hovered ? (
              <>
                <line x1={hovered.x} y1={TOP} x2={hovered.x} y2={HEIGHT - BOTTOM} stroke="currentColor" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
                <circle cx={hovered.x} cy={hovered.y} r="2.25" fill="currentColor" vectorEffect="non-scaling-stroke" />
              </>
            ) : null}
            <rect x="0" y="0" width="100" height={HEIGHT} fill="transparent" onPointerMove={selectNearest} onPointerLeave={() => setHoveredIndex(null)} />
          </svg>
          <div className="mt-1 flex justify-between font-agrandir text-[10px] tabular-nums text-smoke-500">
            <span>{date(chart.minTime, true)}</span>
            <span>{date(chart.maxTime, true)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
