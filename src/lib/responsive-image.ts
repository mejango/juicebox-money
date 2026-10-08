import { getImageProps } from 'next/image'
import { appIpfsUrl } from '@/lib/image-source'

type ImageDelivery = {
  src: string
  srcSet?: string
  sizes?: string
  'data-original-src'?: string
  'data-original-fallback'?: 'true'
  'data-image-fit'?: string
  style?: { objectFit: 'contain' }
}

const CENTER_IMAGES = 'https://juicebox.center/ipfs/'

/** Priority controls loading time; all eligible images use the same sized delivery. */
export function responsiveImageProps(src: string, sizes: string, selected?: string, inlineFit?: string): ImageDelivery {
  const suffix = src.startsWith(CENTER_IMAGES) ? src.slice(CENTER_IMAGES.length) : null
  if (!suffix || appIpfsUrl(suffix) !== src) return { src }

  const { props } = getImageProps({ src, alt: '', fill: true, sizes, quality: 90 })
  if (!props.srcSet) return { src }
  return {
    src: selected || props.src,
    srcSet: selected ? undefined : props.srcSet,
    sizes: selected ? undefined : props.sizes,
    'data-original-src': src,
    'data-original-fallback': selected === src ? 'true' : undefined,
    'data-image-fit': inlineFit,
    // A width-qualified, contained image can paint before source geometry/JS.
    style: { objectFit: 'contain' },
  }
}

type ImageState = {
  original: string
  candidates: { src: string; width: number }[]
  selectedWidth: number
  pending?: string
  // Width is the loaded candidate's request descriptor, not density-corrected naturalWidth.
  decoded?: { width: number; ratio: number }
}
// Preserve the native candidates across imperative srcset removal and React
// effect restarts without duplicating a large srcset in every SSR image.
const imageStates = new WeakMap<HTMLImageElement, ImageState>()
const absolute = (src: string) => new URL(src, window.location.href).href

function stateFor(image: HTMLImageElement): ImageState {
  const original = image.dataset.originalSrc!
  let state = imageStates.get(image)
  if (!state || state.original !== original) {
    state = {
      original,
      candidates: image.srcset.split(',').flatMap(candidate => {
        const match = candidate.trim().match(/^(\S+)\s+(\d+)w$/)
        return match ? [{ src: match[1], width: Number(match[2]) }] : []
      }).sort((a, b) => a.width - b.width),
      selectedWidth: 0,
    }
    imageStates.set(image, state)
  }
  return state
}

function physicalScale() {
  return (window.devicePixelRatio || 1) * Math.max(1, window.visualViewport?.scale || 1)
}

function pendingFit(image: HTMLImageElement, state: ImageState) {
  image.style.objectFit = 'contain'
  const box = image.getBoundingClientRect()
  // Native img retains the prior decoded image during replacement. Keep it
  // visible when containing it is still sharp; zoom may instead require hiding.
  image.style.visibility = state.decoded && state.decoded.width < Math.min(box.width, box.height * state.decoded.ratio) * physicalScale()
    ? 'hidden' : ''
}

function selectSource(image: HTMLImageElement, state: ImageState, src: string) {
  state.pending = absolute(src)
  pendingFit(image, state)
  image.removeAttribute('srcset')
  image.removeAttribute('sizes')
  image.src = src
}

/** Retry only the accepted original; a second failure belongs to the UI. */
export function retryOriginalImage(image: HTMLImageElement): boolean {
  const original = image.dataset.originalSrc
  if (!original) return false
  if (image.dataset.originalFallback === 'true') {
    image.style.visibility = ''
    image.style.objectFit = image.dataset.imageFit || ''
    return false
  }
  const state = stateFor(image)
  image.dataset.originalFallback = 'true'
  selectSource(image, state, original)
  return true
}

/** One sizing/fit rule for React images and sanitized description images. */
export function observeResponsiveImage(image: HTMLImageElement, onSelect?: (src: string) => void): () => void {
  if (!image.dataset.originalSrc) return () => undefined
  const state = stateFor(image)
  let failureReported = false
  const chooseOriginal = () => {
    if (retryOriginalImage(image)) onSelect?.(state.original)
    else if (!failureReported) {
      failureReported = true
      image.dispatchEvent(new Event('error'))
    }
  }
  const check = () => {
    if (image.dataset.originalSrc !== state.original) return
    const current = absolute(image.currentSrc || image.src)
    if (!image.complete || (state.pending && current !== state.pending)) {
      pendingFit(image, state)
      return
    }
    if (!image.naturalWidth || !image.naturalHeight) {
      chooseOriginal()
      return
    }
    state.pending = undefined
    const ratio = image.naturalWidth / image.naturalHeight
    const original = image.dataset.originalFallback === 'true'
    const requestedWidth = original ? Infinity : Number(new URL(current).searchParams.get('w'))
    state.decoded = { width: requestedWidth, ratio }
    state.selectedWidth = Math.max(state.selectedWidth, requestedWidth)
    // Read intended class/inline fit without leaving the temporary fit removed
    // across any return or browser paint. Inline intent is separate from it.
    const temporaryFit = image.style.objectFit
    image.style.objectFit = image.dataset.imageFit || ''
    const fit = getComputedStyle(image).objectFit || 'fill'
    image.style.objectFit = temporaryFit
    const { width, height } = image.getBoundingClientRect()
    const sourceWidth = fit === 'contain' || fit === 'scale-down'
      ? Math.min(width, height * ratio)
      : Math.max(width, height * ratio)
    const required = sourceWidth * physicalScale()
    if (!original && requestedWidth < required) {
      const candidate = state.candidates.find(candidate => candidate.width >= required && candidate.width > state.selectedWidth)
      if (candidate) {
        state.selectedWidth = candidate.width
        selectSource(image, state, candidate.src)
        onSelect?.(candidate.src)
      } else chooseOriginal()
      return
    }
    image.style.objectFit = image.dataset.imageFit || ''
    image.style.visibility = ''
  }

  image.addEventListener('load', check)
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check)
  observer?.observe(image)
  window.addEventListener('resize', check)
  const viewport = window.visualViewport
  viewport?.addEventListener('resize', check)
  let density: MediaQueryList | undefined
  const watchDensity = () => {
    density?.removeEventListener('change', densityChanged)
    density = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`)
    density?.addEventListener('change', densityChanged)
  }
  const densityChanged = () => { check(); watchDensity() }
  watchDensity()
  check()
  return () => {
    image.removeEventListener('load', check)
    observer?.disconnect()
    window.removeEventListener('resize', check)
    viewport?.removeEventListener('resize', check)
    density?.removeEventListener('change', densityChanged)
  }
}
