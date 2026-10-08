import { getImageProps } from 'next/image'
import { appIpfsUrl } from '@/lib/image-source'

type ImageDelivery = {
  src: string
  srcSet?: string
  sizes?: string
  'data-original-src'?: string
  'data-original-fallback'?: 'true'
  style?: { visibility: 'hidden' }
}

const CENTER_IMAGES = 'https://juicebox.center/ipfs/'

/** Display-only derivatives: callers retain their canonical metadata/source URI. */
export function responsiveImageProps(src: string, sizes: string, original = false): ImageDelivery {
  // Reuse the app's path validator, and never proxy arbitrary URLs or previews.
  const suffix = src.startsWith(CENTER_IMAGES) ? src.slice(CENTER_IMAGES.length) : null
  if (!suffix || appIpfsUrl(suffix) !== src) return { src }

  const pending = { 'data-original-src': src, style: { visibility: 'hidden' as const } }
  if (original) return { src, ...pending, 'data-original-fallback': 'true' }

  const { props } = getImageProps({ src, alt: '', fill: true, sizes, quality: 90 })
  if (!props.srcSet) return { src }
  return {
    src: props.src,
    srcSet: props.srcSet,
    sizes: props.sizes,
    // Do not paint a cropped/undersampled candidate before its adequacy check.
    ...pending,
  }
}

/** Retry only the already accepted original; a second failure belongs to the UI. */
export function retryOriginalImage(image: HTMLImageElement): boolean {
  const original = image.dataset.originalSrc
  if (!original || image.dataset.originalFallback === 'true') {
    image.style.visibility = ''
    return false
  }
  image.dataset.originalFallback = 'true'
  image.style.visibility = 'hidden'
  image.removeAttribute('srcset')
  image.removeAttribute('sizes')
  image.src = original
  return true
}

/** One fidelity rule for React images and images inside sanitized descriptions. */
export function observeResponsiveImage(image: HTMLImageElement, onOriginal?: () => void): () => void {
  if (!image.dataset.originalSrc) return () => undefined

  let failureReported = false
  const chooseOriginal = () => {
    if (retryOriginalImage(image)) onOriginal?.()
    else if (!failureReported) {
      failureReported = true
      image.dispatchEvent(new Event('error'))
    }
  }
  const check = () => {
    if (!image.dataset.originalSrc) return
    if (!image.complete) {
      image.style.visibility = 'hidden'
      return
    }
    if (!image.naturalWidth || !image.naturalHeight) {
      chooseOriginal() // A failed request may also complete before hydration.
      return
    }
    if (image.dataset.originalFallback !== 'true') {
      const { width, height } = image.getBoundingClientRect()
      const ratio = image.naturalWidth / image.naturalHeight
      const fit = getComputedStyle(image).objectFit
      const sourceWidth = fit === 'cover'
        ? Math.max(width, height * ratio)
        : fit === 'contain' ? Math.min(width, height * ratio) : width
      const selected = new URL(image.currentSrc || image.src, window.location.href)
      const requestedWidth = Number(selected.searchParams.get('w'))
      // Browser srcset selection may economize pixels. Respect the user's
      // quality requirement, including cover crops, zoom and large displays.
      if (requestedWidth < sourceWidth * (window.devicePixelRatio || 1)) {
        chooseOriginal()
        return
      }
    }
    image.style.visibility = ''
  }

  image.addEventListener('load', check)
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check)
  observer?.observe(image)
  window.addEventListener('resize', check)
  // Moving between displays can change DPR without changing CSS geometry.
  let density: MediaQueryList | undefined
  const watchDensity = () => {
    density?.removeEventListener('change', densityChanged)
    density = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`)
    density?.addEventListener('change', densityChanged)
  }
  const densityChanged = () => { check(); watchDensity() }
  watchDensity()
  check() // A server-rendered/cached image can finish before hydration.
  return () => {
    image.removeEventListener('load', check)
    observer?.disconnect()
    window.removeEventListener('resize', check)
    density?.removeEventListener('change', densityChanged)
  }
}
