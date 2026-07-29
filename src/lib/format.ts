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
  return `https://gateway.pinata.cloud/ipfs/${uri.replace('ipfs://', '')}`
}

/** Block-explorer transaction URL, or null when the chain has no explorer. */
export function etherscanTxUrl(chainId: number, hash: string): string | null {
  const host = explorerHostname(chainId)
  return host ? `https://${host}/tx/${hash}` : null
}

/** Block-explorer address URL, or null when the chain has no explorer. */
export function etherscanAddressUrl(
  chainId: number,
  address: string,
): string | null {
  const host = explorerHostname(chainId)
  return host ? `https://${host}/address/${address}` : null
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

/** 18-decimal fixed-point USD → "$1,234.56" (half-up to the cent). */
export function formatUsd18(raw: bigint | string): string {
  try {
    const value = typeof raw === 'bigint' ? raw : BigInt(raw)
    if (value > 0n && value < USD_SCALE / 100n) return '<$0.01'

    const cents = (value * 100n + USD_SCALE / 2n) / USD_SCALE
    const dollars = cents / 100n
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
