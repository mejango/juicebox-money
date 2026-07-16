import Image from 'next/image'
import { ipfsUrl } from '@/lib/format'

const TILES = [
  'bg-juice-400 text-ink',
  'bg-emerald-500 text-white',
  'bg-sky-500 text-white',
  'bg-rose-400 text-white',
  'bg-violet-500 text-white',
  'bg-teal-500 text-white',
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
        className={`shrink-0 rounded-xl border border-ink/10 bg-white object-cover ${className}`}
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
      className={`flex shrink-0 items-center justify-center rounded-xl font-bold ${tile} ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {label[0].toUpperCase()}
    </span>
  )
}
