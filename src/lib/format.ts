import { formatUnits } from 'viem'
import { explorerHostname } from './chainDisplay'

export function formatTokenAmount(
  wei: bigint | string,
  decimals = 18,
  maxDigits = 4,
): string {
  const value = Number(formatUnits(BigInt(wei), decimals))
  if (value === 0) return '0'
  if (value < 0.0001) return '<0.0001'
  return value.toLocaleString('en-US', { maximumFractionDigits: maxDigits })
}

/** Compact 18-decimal project-token counts for activity feeds. */
export function formatCompactTokenAmount(raw: bigint | string): string {
  try {
    const value = Number(formatUnits(BigInt(raw), 18))
    if (!Number.isFinite(value)) return '—'
    if (value >= 1_000_000_000) {
      return `${(value / 1_000_000_000)
        .toFixed(value >= 10_000_000_000 ? 0 : 1)
        .replace(/\.0$/, '')}b`
    }
    if (value >= 1_000_000) {
      return `${(value / 1_000_000)
        .toFixed(value >= 10_000_000 ? 0 : 1)
        .replace(/\.0$/, '')}m`
    }
    if (value >= 1_000) {
      return `${(value / 1_000)
        .toFixed(value >= 10_000 ? 0 : 1)
        .replace(/\.0$/, '')}k`
    }
    if (value >= 1) {
      if (value === Math.round(value)) {
        return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
      }
      return value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    }
    if (value >= 0.0001) {
      return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
    }
    if (value > 0) return value.toPrecision(2)
    return '0'
  } catch {
    return '—'
  }
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/**
 * A unix timestamp → the `YYYY-MM-DDTHH:mm` string a `datetime-local` input
 * expects. Those inputs are LOCAL wall clock in both directions — the browser
 * renders the value as-is and `new Date(value)` parses it as local — so the
 * offset has to be folded in here. Emitting `toISOString()` (UTC) instead
 * shifts every round-trip by the viewer's UTC offset.
 */
export function toLocalDateTimeInput(seconds: number): string {
  const date = new Date(seconds * 1000)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

/** Compact relative time for activity rows: "7m", "3h", "2d". */
export function timeAgo(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function ipfsUrl(uri: string | null | undefined): string | null {
  if (!uri) return null
  return appIpfsUrl(uri)
}

export function appIpfsUrl(uri: string): string | null {
  const suffix = uri.replace(/^ipfs:\/\//i, '')
  const segments = suffix.split('/')
  if (
    segments.length < 1 ||
    segments.length > 8 ||
    segments.some(
      segment =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z\d._~-]{1,128}$/.test(segment),
    )
  ) {
    return null
  }
  return `https://juicebox.center/ipfs/${segments
    .map(encodeURIComponent)
    .join('/')}`
}

const MAX_INLINE_LOGO_LENGTH = 1_000_000
const SAFE_RASTER_DATA_IMAGE =
  /^data:image\/(?:avif|bmp|gif|jpe?g|png|webp);base64,[A-Za-z\d+/]+={0,2}$/i
const SVG_DATA_IMAGE_PREFIX = 'data:image/svg+xml,'
const ACTIVE_SVG_CONTENT =
  /<(?:script|foreignObject|iframe|object|embed|image|use|style)\b|(?:on[a-z]+|href|src)\s*=|url\s*\(|@import|<!doctype|<\?xml-stylesheet/iu

/**
 * Resolve an untrusted project logo without turning arbitrary URI schemes into
 * bogus IPFS gateway paths. Project metadata in the wild also uses inline
 * data-image URIs (notably generated SVG logos), which are valid image sources
 * and should be passed through unchanged.
 */
export function projectLogoUrl(uri: string | null | undefined): string | null {
  const value = uri?.trim()
  if (!value || value.length > MAX_INLINE_LOGO_LENGTH) return null
  if (SAFE_RASTER_DATA_IMAGE.test(value)) return value
  if (value.startsWith(SVG_DATA_IMAGE_PREFIX)) {
    try {
      const svg = decodeURIComponent(value.slice(SVG_DATA_IMAGE_PREFIX.length))
      if (
        svg.length > 0 &&
        svg.length <= 256_000 &&
        /^\s*<svg(?:\s|>)/iu.test(svg) &&
        !ACTIVE_SVG_CONTENT.test(svg)
      ) {
        return value
      }
    } catch {
      return null
    }
    return null
  }
  if (/^ipfs:\/\//i.test(value)) {
    return appIpfsUrl(value)
  }

  // Keep supporting the bare CIDs accepted historically, but reject another
  // explicit scheme (javascript:, data:text/html, blob:, and so on).
  if (!/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('//')) {
    return appIpfsUrl(value)
  }
  return null
}

/** Block-explorer transaction URL, or null when the chain has no explorer. */
export function etherscanTxUrl(chainId: number, hash: string): string | null {
  const host = explorerHostname(chainId)
  return host ? `https://${host}/tx/${hash}` : null
}

/** A 0-100 percent → trimmed display percent: 38 → "38%", 2.5 → "2.5%". */
export function fmtPct(pct: number): string {
  if (!Number.isFinite(pct) || pct === 0) return '0%'
  const magnitude = Math.abs(pct)
  const decimals =
    magnitude >= 0.01
      ? 2
      : Math.min(8, Math.max(2, Math.ceil(-Math.log10(magnitude)) + 3))
  return `${pct.toFixed(decimals).replace(/\.?0+$/, '')}%`
}

/**
 * 1e9-scaled fraction (split/weight-cut percents) → a percent string.
 * Without `decimals`: display form, "%" included: 5e8 → "50%".
 * With `decimals`: a bare trimmed 0-100 number string for input prefills:
 * 5e8 → "50" (editors use 4 or 6 decimals of precision).
 */
export function billionthsToPct(
  value: number | bigint,
  decimals?: number,
): string {
  const pct = (Number(value) / 1e9) * 100
  if (decimals === undefined) return fmtPct(pct)
  return String(Number(pct.toFixed(decimals)))
}

/**
 * Coarse single-unit duration: "7 days", "3 hours", "90 seconds".
 * `exact` only breaks into a bigger unit when it divides evenly (ruleset
 * editors: 90000 secs stays "90000 seconds", never "1.0 days"); `zeroLabel`
 * short-circuits non-positive durations ("No expiry").
 */
export function formatDuration(
  seconds: number,
  opts: { exact?: boolean; zeroLabel?: string } = {},
): string {
  if (opts.zeroLabel !== undefined && seconds <= 0) return opts.zeroLabel
  if (opts.exact) {
    if (seconds % 86_400 === 0) {
      const d = seconds / 86_400
      return `${d} day${d === 1 ? '' : 's'}`
    }
    if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`
    return `${seconds} seconds`
  }
  if (seconds >= 86400) {
    const d = seconds / 86400
    const v = d % 1 === 0 ? String(d) : d.toFixed(1)
    return `${v} day${d === 1 ? '' : 's'}`
  }
  if (seconds >= 3600) {
    const h = seconds / 3600
    const v = h % 1 === 0 ? String(h) : h.toFixed(1)
    return `${v} hour${h === 1 ? '' : 's'}`
  }
  return `${seconds} seconds`
}

/**
 * Compact countdown: "2d 4h", "3h 12m", "45m". Zero-value secondary units
 * are dropped ("2d") unless `twoUnits` forces them ("2d 0h" — the pay
 * panel's start countdown).
 */
export function formatCountdown(
  seconds: number,
  opts: { zeroLabel?: string; twoUnits?: boolean } = {},
): string {
  const { zeroLabel = 'now', twoUnits = false } = opts
  if (seconds <= 0) return zeroLabel
  const d = Math.floor(seconds / 86400)
  if (d >= 1) {
    const h = Math.floor((seconds % 86400) / 3600)
    return twoUnits ? `${d}d ${h}h` : `${d}d${h ? ` ${h}h` : ''}`
  }
  const h = Math.floor(seconds / 3600)
  if (h >= 1) {
    const m = Math.floor((seconds % 3600) / 60)
    return twoUnits ? `${h}h ${m}m` : `${h}h${m ? ` ${m}m` : ''}`
  }
  return `${Math.max(1, Math.floor(seconds / 60))}m`
}

/** One whole unit of 18-decimal fixed-point USD. */
export const USD_SCALE = 10n ** 18n

/**
 * USD value of a treasury balance, in 18-decimal fixed point. `null` = not
 * priceable; never a fabricated zero.
 *
 * ONE definition for every surface that shows a project's treasury in dollars.
 * The Funds tab and the stats header used to disagree — same failed feed, one
 * card showed a dollar value and the other "unavailable", on the same page.
 *
 * `usdPrice` is `JBPrices.pricePerUnitOf(USD, contextCurrency, 18)`, or null
 * when that read failed. A ZERO response is not a real $0 quote, so it falls
 * through to the same treatment as a failure — except for USDC, whose
 * accounting unit IS a dollar and needs no oracle.
 */
export function treasuryUsdValue({
  balance,
  usdPrice,
  symbol,
  decimals,
}: {
  balance: bigint
  usdPrice: bigint | null | undefined
  symbol: string
  decimals: number
}): bigint | null {
  if (balance === 0n) return 0n
  const resolved =
    usdPrice != null && usdPrice > 0n
      ? usdPrice
      : symbol.toUpperCase() === 'USDC' && decimals === 6
        ? USD_SCALE
        : null
  return resolved == null
    ? null
    : (balance * resolved) / 10n ** BigInt(decimals)
}

/** 18-decimal fixed-point USD → "$1,234.56" (half-up to the cent). */
export function formatUsd18(
  raw: bigint | string,
  { compact = false }: { compact?: boolean } = {},
): string {
  try {
    const value = typeof raw === 'bigint' ? raw : BigInt(raw)
    if (value > 0n && value < USD_SCALE / 100n) return '<$0.01'

    const cents = (value * 100n + USD_SCALE / 2n) / USD_SCALE
    const dollars = cents / 100n
    // Cents matter up to $1,000 — at $340.50 they still carry meaning. Above that a dense
    // list reads better without them, and the exact value stays one hover away.
    if (compact && (dollars >= 1_000n || dollars <= -1_000n)) {
      // Round to the nearest dollar rather than truncating the cents off — dropping
      // precision must not also bias the number downward.
      const wholeDollars = (value + USD_SCALE / 2n) / USD_SCALE
      return `$${wholeDollars.toLocaleString('en-US')}`
    }
    const remainder = (cents % 100n).toString().padStart(2, '0')
    return `$${dollars.toLocaleString('en-US')}.${remainder}`
  } catch {
    return '—'
  }
}

/**
 * Compact 18-decimal totals for table headlines: the b/m/k ladder above
 * 1,000, full `formatTokenAmount` precision below it.
 */
export function compactTokenTotal(raw: bigint): string {
  const value = Number(formatUnits(raw, 18))
  if (!Number.isFinite(value)) return '—'
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, '')}b`
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`
  }
  return formatTokenAmount(raw)
}
