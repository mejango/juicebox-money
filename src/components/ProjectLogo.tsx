import Image from 'next/image'
import { ipfsUrl } from '@/lib/format'

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
export function ProjectLogo({
  name,
  logoUri,
  size,
  className = '',
}: {
  name: string | null
  logoUri: string | null
  size: number
  className?: string
}) {
  // Only ipfs:// (or bare-CID) URIs resolve through our allowed gateway.
  const src =
    logoUri && !logoUri.startsWith('http') ? ipfsUrl(logoUri) : null
  const label = name?.trim() || '?'

  if (src) {
    return (
      <Image
        src={src}
        alt=""
        width={size}
        height={size}
        className={`shrink-0 rounded-lg border border-smoke-200 bg-smoke-75 object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    )
  }

  // Deterministic color from the name so placeholders are stable.
  let hash = 0
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0
  const tile = TILES[Math.abs(hash) % TILES.length]

  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-lg font-agrandir font-medium ${tile} ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {label[0].toUpperCase()}
    </span>
  )
}
