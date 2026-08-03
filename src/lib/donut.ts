/**
 * Donut-slice geometry shared by the owner and liquidity-provider breakdowns,
 * so the two charts stay the same size and shape.
 */

function polarPoint(cx: number, cy: number, radius: number, angle: number) {
  return {
    x: (cx + Math.cos(angle) * radius).toFixed(3),
    y: (cy + Math.sin(angle) * radius).toFixed(3),
  }
}

/** One slice of the 240×218 donut, in radians from the 3 o'clock position. */
export function donutSlicePath(start: number, end: number): string {
  const cx = 120
  const cy = 112
  const outer = 92
  const inner = 54
  const largeArc = end - start > Math.PI ? 1 : 0
  const p1 = polarPoint(cx, cy, outer, start)
  const p2 = polarPoint(cx, cy, outer, end)
  const p3 = polarPoint(cx, cy, inner, end)
  const p4 = polarPoint(cx, cy, inner, start)
  return [
    `M ${p1.x} ${p1.y}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${p2.x} ${p2.y}`,
    `L ${p3.x} ${p3.y}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${p4.x} ${p4.y}`,
    'Z',
  ].join(' ')
}
