/**
 * Largest-Triangle-Three-Buckets time-series downsampling. The first and
 * latest observations are always retained; intermediate points preserve the
 * visible shape instead of merely keeping the oldest rows.
 */
export function downsampleTimeSeries<T>(
  rows: readonly T[],
  maxPoints: number,
  xOf: (row: T) => number,
  yOf: (row: T) => number,
): T[] {
  if (rows.length <= maxPoints) return rows.slice()
  if (maxPoints < 3) return [rows[0], rows[rows.length - 1]].slice(0, maxPoints)

  const sampled: T[] = [rows[0]]
  const bucket = (rows.length - 2) / (maxPoints - 2)
  let anchorIndex = 0

  for (let index = 0; index < maxPoints - 2; index += 1) {
    const averageStart = Math.floor((index + 1) * bucket) + 1
    const averageEnd = Math.min(Math.floor((index + 2) * bucket) + 1, rows.length)
    let averageX = 0
    let averageY = 0
    const averageLength = Math.max(averageEnd - averageStart, 1)
    for (let cursor = averageStart; cursor < averageEnd; cursor += 1) {
      averageX += xOf(rows[cursor])
      averageY += finite(yOf(rows[cursor]))
    }
    averageX /= averageLength
    averageY /= averageLength

    const rangeStart = Math.floor(index * bucket) + 1
    const rangeEnd = Math.min(Math.floor((index + 1) * bucket) + 1, rows.length - 1)
    const anchorX = xOf(rows[anchorIndex])
    const anchorY = finite(yOf(rows[anchorIndex]))
    let largestArea = -1
    let selected = rangeStart
    for (let cursor = rangeStart; cursor < rangeEnd; cursor += 1) {
      const area = Math.abs(
        (anchorX - averageX) * (finite(yOf(rows[cursor])) - anchorY) -
          (anchorX - xOf(rows[cursor])) * (averageY - anchorY),
      )
      if (area > largestArea) {
        largestArea = area
        selected = cursor
      }
    }
    sampled.push(rows[selected])
    anchorIndex = selected
  }

  sampled.push(rows[rows.length - 1])
  return sampled
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}
