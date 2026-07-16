import Image from 'next/image'
import { ipfsUrl } from '@/lib/format'

// Palette tiles with checked contrast: dark bg text on the bright ones,
// white on navy (8.9:1).
const TILES = [
  'bg-juice text-bg',
  'bg-lime text-bg',
  'bg-jcyan text-bg',
  'bg-magenta text-bg',
  'bg-navy text-white',
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
        className={`shrink-0 rounded border-2 border-frame bg-panel2 object-cover ${className}`}
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
      className={`flex shrink-0 items-center justify-center rounded font-pixel font-bold ${tile} ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {label[0].toUpperCase()}
    </span>
  )
}
