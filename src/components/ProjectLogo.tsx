'use client'

import Image from 'next/image'
import { useState } from 'react'
import { projectLogoUrl } from '@/lib/format'

// Fruit-scale placeholder tiles (DESIGN.md §Icons) with checked contrast:
// ink on split-400 = 10.3, melon-400 = 10.0, crush-400 = 10.5,
// grape-300 = 9.1, bluebs-300 = 8.1.
const TILES = [
  'bg-split-400 text-ink',
  'bg-melon-400 text-ink',
  'bg-crush-400 text-ink',
  'bg-grape-300 text-ink',
  'bg-bluebs-300 text-ink',
]

/** Project logo image, or a colored initial tile when there's no usable logo. */
export type ProjectLogoProps = {
  name: string | null
  logoUri: string | null
  size: number
  className?: string
  onError?: () => void
  eager?: boolean
}

export function ProjectLogo({
  name,
  logoUri,
  size,
  className = '',
  onError,
  eager = false,
}: ProjectLogoProps) {
  const src = projectLogoUrl(logoUri)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const label = name?.trim() || '?'
  const visibleSrc = src && failedSrc !== src ? src : null

  // Deterministic color from the name so placeholders are stable.
  let hash = 0
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0
  const tile = TILES[Math.abs(hash) % TILES.length]

  return (
    <span
      aria-hidden
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-smoke-200 font-agrandir font-medium ${tile} ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {label[0].toUpperCase()}
      {visibleSrc ? (
        <Image
          src={visibleSrc}
          alt=""
          width={size}
          height={size}
          className="absolute inset-0 size-full object-cover"
          unoptimized={
            visibleSrc.startsWith('data:') ||
            visibleSrc.startsWith('https://juicebox.center/ipfs/')
          }
          loading={eager ? 'eager' : 'lazy'}
          fetchPriority={eager ? 'high' : 'auto'}
          decoding={eager ? 'sync' : 'async'}
          onError={() => {
            setFailedSrc(visibleSrc)
            onError?.()
          }}
        />
      ) : null}
    </span>
  )
}
