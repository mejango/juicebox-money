'use client'

import { useState } from 'react'

/**
 * The cash-out bonding curve: cashing out fraction x of the token supply
 * with tax rate r (out of 10000) reclaims y = x·((1−r) + r·x) of surplus.
 * Pure SVG — no libraries. Hover (or drag on touch) to inspect any point;
 * the marker rests at the 10% example otherwise.
 */

function reclaimFraction(x: number, rate: number): number {
  const r = rate / 10_000
  return x * (1 - r + r * x)
}

// Plot area: left/bottom gutters inside a 220×150 viewBox.
const X0 = 26
const Y0 = 128
const W = 184
const H = 112
const px = (x: number) => X0 + x * W
const py = (y: number) => Y0 - y * H

export function CashOutCurve({ rate }: { rate: number }) {
  const [hoverX, setHoverX] = useState<number | null>(null)

  const points = Array.from({ length: 21 }, (_, i) => {
    const x = i / 20
    return `${px(x).toFixed(1)},${py(reclaimFraction(x, rate)).toFixed(1)}`
  })

  const x = hoverX ?? 0.1
  const y = reclaimFraction(x, rate)
  const xPct = Math.round(x * 1000) / 10
  const yPct = Math.round(y * 1000) / 10

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const viewX = ((e.clientX - rect.left) / rect.width) * 220
    const fraction = Math.min(1, Math.max(0, (viewX - X0) / W))
    setHoverX(fraction)
  }

  return (
    <div className="mt-3 rounded-xl border border-smoke-200 bg-white p-4">
      <svg
        viewBox="0 0 220 150"
        className="h-auto w-full max-w-[300px] cursor-crosshair touch-none"
        role="img"
        aria-label={`Cash-out curve at ${rate / 100}% tax`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverX(null)}
      >
        {/* Axes */}
        <line x1={X0} y1={Y0} x2={X0 + W} y2={Y0} stroke="#D4D1C7" strokeWidth="1" />
        <line x1={X0} y1={Y0} x2={X0} y2={Y0 - H} stroke="#D4D1C7" strokeWidth="1" />
        {/* No-tax reference diagonal */}
        {rate > 0 ? (
          <line
            x1={X0}
            y1={Y0}
            x2={X0 + W}
            y2={Y0 - H}
            stroke="#D4D1C7"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        ) : null}
        {/* The curve */}
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke="#5777EB"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {/* Crosshair guides while hovering */}
        {hoverX !== null ? (
          <>
            <line
              x1={px(x)}
              y1={Y0}
              x2={px(x)}
              y2={py(y)}
              stroke="#9C9580"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
            <line
              x1={X0}
              y1={py(y)}
              x2={px(x)}
              y2={py(y)}
              stroke="#9C9580"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
          </>
        ) : null}
        {/* The inspected point */}
        <circle cx={px(x)} cy={py(y)} r="3.5" fill="#F5A312" stroke="#1A1A1A" strokeWidth="1" />
        {/* Labels */}
        <text x={X0 + W / 2} y={148} textAnchor="middle" fontSize="8.5" fill="#575344">
          Tokens cashed out
        </text>
        <text
          x={8}
          y={Y0 - H / 2}
          textAnchor="middle"
          fontSize="8.5"
          fill="#575344"
          transform={`rotate(-90 8 ${Y0 - H / 2})`}
        >
          Surplus received
        </text>
      </svg>
      <p className="mt-2 text-xs leading-relaxed text-smoke-700" aria-live="polite">
        Cashing out <span className="font-medium text-ink">{xPct}%</span> of
        the tokens gets <span className="font-medium text-ink">{yPct}%</span>{' '}
        of the surplus
        {rate > 0 ? ' — the rest stays for holders who stay.' : '.'}
      </p>
    </div>
  )
}
