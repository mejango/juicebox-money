'use client'

import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react'
import { observeResponsiveImage, responsiveImageProps, retryOriginalImage } from '@/lib/responsive-image'

type ResponsiveImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'sizes' | 'alt'> & {
  src: string
  sizes: string
  alt: string
}

/** Native layout, responsive delivery, and a single original-source retry. */
export function ResponsiveImage({ src, sizes, alt, onError, style, ...props }: ResponsiveImageProps) {
  const ref = useRef<HTMLImageElement>(null)
  const [originalSrc, setOriginalSrc] = useState<string | null>(null)
  const delivery = responsiveImageProps(src, sizes, originalSrc === src)
  useEffect(() => ref.current ? observeResponsiveImage(ref.current, () => setOriginalSrc(src)) : undefined, [src])
  return (
    // Delivery uses Next's supported getImageProps API; layout stays with callers.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...props}
      {...delivery}
      alt={alt}
      key={src}
      ref={ref}
      style={{ ...style, ...delivery.style }}
      onError={event => {
        if (retryOriginalImage(event.currentTarget)) setOriginalSrc(src)
        else onError?.(event)
      }}
    />
  )
}
