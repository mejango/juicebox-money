import type { ReactNode } from 'react'

/** Cosmetic checkout media; callers retain the existing named/numbered placeholder. */
export function NftCheckoutImage({ image, name, className, loading, fallback }: {
  image?: string | null
  name: string
  className: string
  loading?: 'lazy' | 'eager'
  fallback: ReactNode
}) {
  return image ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt={name} loading={loading} decoding={loading ? 'async' : undefined} className={className} />
  ) : fallback
}
