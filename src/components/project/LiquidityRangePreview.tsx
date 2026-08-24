'use client'

import { useRef } from 'react'

type Marker = {
  label: string
  value: number
  color: string
}

const WIDTH = 320
const PAD = 8

function labelAnchor(x: number) {
  if (x < 48) return { anchor: 'start' as const, x: PAD }
  if (x > WIDTH - 48) return { anchor: 'end' as const, x: WIDTH - PAD }
  return { anchor: 'middle' as const, x }
}

export function LiquidityRangePreview({
  floor,
  ceiling,
  current,
  minimum,
  maximum,
  pairSymbol,
  tokenSymbol,
  onRangeChange,
}: {
  floor: number | null
  ceiling: number | null
  current: number | null
  minimum: number
  maximum: number
  pairSymbol: string
  tokenSymbol: string
  /** Supplied only when the range is editable; enables the drag handles. */
  onRangeChange?: (edge: 'min' | 'max', value: number) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  // The axis is scaled to the widest value, so an un-frozen scale would slide
  // out from under a handle being dragged outward.
  const frozenScale = useRef<number | null>(null)
  const dragging = useRef<'min' | 'max' | null>(null)

  const values = [floor, ceiling, current, minimum, maximum].filter(
    (value): value is number => value != null && Number.isFinite(value) && value > 0,
  )
  if (values.length === 0) return null

  const maxValue = frozenScale.current ?? Math.max(...values) * 1.12
  const xFor = (value: number) =>
    PAD + ((WIDTH - PAD * 2) * value) / maxValue
  const valueFor = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return null
    const x = ((clientX - rect.left) / rect.width) * WIDTH
    return (maxValue * (x - PAD)) / (WIDTH - PAD * 2)
  }
  const topMarkers: Marker[] = [
    { label: 'Floor', value: floor ?? 0, color: '#2c2018' },
    { label: 'Ceiling', value: ceiling ?? 0, color: '#1a8a8a' },
  ].filter(marker => marker.value > 0)
  const stagger =
    topMarkers.length === 2 &&
    Math.abs(xFor(topMarkers[0].value) - xFor(topMarkers[1].value)) < 92
  const rows = stagger ? 2 : 1
  const baseline = rows * 20 + 18
  const height = baseline + 32

  const drag = (edge: 'min' | 'max') => (event: React.PointerEvent<SVGRectElement>) => {
    if (!onRangeChange) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    frozenScale.current = maxValue
    dragging.current = edge
  }
  const move = (edge: 'min' | 'max') => (event: React.PointerEvent<SVGRectElement>) => {
    if (!onRangeChange || dragging.current !== edge) return
    const raw = valueFor(event.clientX)
    if (raw == null) return
    // Keep the edges ordered with a sliver of daylight between them.
    const gap = maxValue / 400
    const next = edge === 'min' ? Math.min(raw, maximum - gap) : Math.max(raw, minimum + gap)
    if (!(next > 0)) return
    onRangeChange(edge, Number(next.toPrecision(6)))
  }
  // Pointer capture releases itself on pointerup/pointercancel.
  const end = () => {
    frozenScale.current = null
    dragging.current = null
  }

  const handle = (edge: 'min' | 'max', value: number) => (
    <g key={edge}>
      <line
        x1={xFor(value)}
        y1={baseline - 13}
        x2={xFor(value)}
        y2={baseline + 13}
        stroke="#1a8a8a"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <rect
        x={xFor(value) - 7}
        y={baseline - 15}
        width="14"
        height="30"
        fill="transparent"
        className="cursor-ew-resize touch-none"
        onPointerDown={drag(edge)}
        onPointerMove={move(edge)}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </g>
  )

  return (
    <div className="mt-3" data-liquidity-range-preview>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label={`Liquidity range in ${pairSymbol} per ${tokenSymbol}`}
      >
        <line
          x1={PAD}
          y1={baseline}
          x2={WIDTH - PAD}
          y2={baseline}
          stroke="currentColor"
          strokeOpacity="0.2"
        />
        {minimum > 0 && maximum > minimum ? (
          <rect
            x={xFor(minimum)}
            y={baseline - 9}
            width={Math.max(1, xFor(maximum) - xFor(minimum))}
            height="18"
            fill="rgba(110, 196, 196, 0.28)"
            stroke="#1a8a8a"
          />
        ) : null}
        {topMarkers.map((marker, index) => {
          const markerX = xFor(marker.value)
          const label = labelAnchor(markerX)
          const row = stagger ? index : 0
          return (
            <g key={marker.label}>
              <line
                x1={markerX}
                y1={baseline - 13}
                x2={markerX}
                y2={baseline + 13}
                stroke={marker.color}
                strokeWidth="1.5"
              />
              <text
                x={label.x}
                y={9 + row * 20}
                fill={marker.color}
                fontSize="8"
                textAnchor={label.anchor}
              >
                {marker.label}
              </text>
              <text
                x={label.x}
                y={19 + row * 20}
                fill={marker.color}
                fontSize="8"
                fontWeight="600"
                textAnchor={label.anchor}
              >
                {formatRangePrice(marker.value)}
              </text>
            </g>
          )
        })}
        {current != null && current > 0 ? (
          <g>
            <line
              x1={xFor(current)}
              y1={baseline - 13}
              x2={xFor(current)}
              y2={baseline + 13}
              stroke="#b8602e"
              strokeWidth="1.5"
            />
            <text
              x={labelAnchor(xFor(current)).x}
              y={height - 13}
              fill="#b8602e"
              fontSize="8"
              textAnchor={labelAnchor(xFor(current)).anchor}
            >
              Current pool price
            </text>
            <text
              x={labelAnchor(xFor(current)).x}
              y={height - 3}
              fill="#b8602e"
              fontSize="8"
              fontWeight="600"
              textAnchor={labelAnchor(xFor(current)).anchor}
            >
              {formatRangePrice(current)}
            </text>
          </g>
        ) : null}
        {/* The Min/Max number inputs stay the keyboard path; these are a
            pointer-only shortcut to the same values. */}
        {onRangeChange && minimum > 0 && maximum > minimum
          ? [handle('min', minimum), handle('max', maximum)]
          : null}
      </svg>
    </div>
  )
}

function formatRangePrice(value: number) {
  if (value >= 1) return new Intl.NumberFormat('en', { maximumFractionDigits: 4 }).format(value)
  return String(Number(value.toPrecision(6)))
}
