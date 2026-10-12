'use client'

import { useRef, useState, type ReactNode } from 'react'

/** Cosmetic checkout media; callers retain the existing named/numbered placeholder. */
export function NftCheckoutImage({ image, name, imageAlt = name, className, loading, fallback }: {
  image?: string | null
  name: string
  imageAlt?: string
  className: string
  loading?: 'lazy' | 'eager'
  fallback: ReactNode
}) {
  const currentImage = useRef(image)
  currentImage.current = image
  const [failedImage, setFailedImage] = useState<string | null>(null)
  return image && image !== failedImage ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt={imageAlt} loading={loading} decoding={loading ? 'async' : undefined} className={className} onError={() => { if (currentImage.current === image) setFailedImage(image) }} />
  ) : fallback
}
