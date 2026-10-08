'use client'

import { useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from 'react'
import { observeResponsiveImage, responsiveImageProps, retryOriginalImage } from '@/lib/responsive-image'

type ResponsiveImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'sizes' | 'alt'> & {
  src: string
  sizes: string
  alt: string
}

/** Native priority/layout, sized delivery, and terminal original-source recovery. */
export function ResponsiveImage({ src, sizes, alt, onError, style, ...props }: ResponsiveImageProps) {
  const ref = useRef<HTMLImageElement>(null)
  const [selection, setSelection] = useState<{ source: string; selected: string } | null>(null)
  const delivery = responsiveImageProps(src, sizes, selection?.source === src ? selection.selected : undefined, style?.objectFit)
  // Requalify a changed CSS/inline fit before paint, even when its box is unchanged.
  useLayoutEffect(() => ref.current ? observeResponsiveImage(ref.current, selected => setSelection({ source: src, selected })) : undefined,
    [src, sizes, style?.objectFit, props.className])
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
        if (retryOriginalImage(event.currentTarget)) setSelection({ source: src, selected: src })
        else onError?.(event)
      }}
    />
  )
}
