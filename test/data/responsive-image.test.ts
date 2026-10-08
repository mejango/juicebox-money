// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { observeResponsiveImage, responsiveImageProps, retryOriginalImage } from '@/lib/responsive-image'

const original = 'https://juicebox.center/ipfs/QmPhoto'

function loadedImage({ width = 112, height = 112, sourceWidth = 400, sourceHeight = 400, requestedWidth = 384 } = {}) {
  const image = document.createElement('img')
  image.dataset.originalSrc = original
  image.src = `/_next/image?url=${encodeURIComponent(original)}&w=${requestedWidth}&q=90`
  image.srcset = `${image.src} ${requestedWidth}w`
  image.sizes = `${width}px`
  image.style.visibility = 'hidden'
  Object.defineProperties(image, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: sourceWidth },
    naturalHeight: { configurable: true, value: sourceHeight },
  })
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({ width, height } as DOMRect)
  return image
}

describe('responsive project image delivery', () => {
  it('uses actual Next width descriptors, including 3x, and the configured quality', () => {
    const props = responsiveImageProps(original, '112px')
    expect(props.sizes).toBe('112px')
    expect(props.srcSet).toContain('w=384&q=90 384w')
    expect(props.srcSet).toContain('w=3840&q=90 3840w')
    expect(props.srcSet).not.toMatch(/ [123]x(?:,|$)/)
    expect(props['data-original-src']).toBe(original)
    expect(props.style?.visibility).toBe('hidden')
  })

  it.each([
    'https://example.com/image.png', 'https://juicebox.center.evil/ipfs/QmPhoto',
    'https://juicebox.center:444/ipfs/QmPhoto', 'https://juicebox.center/ipfs/QmPhoto?extra=1',
    'https://juicebox.center/ipfs/../private', 'https://juicebox.center/ipfs/QmPhoto%2f..',
    'data:image/png;base64,AAAA', 'blob:https://juicebox.money/preview', '/assets/logo.svg',
  ])('keeps an unsupported/preview source outside the optimizer: %s', src => {
    expect(responsiveImageProps(src, '112px')).toEqual({ src })
  })

  it('reveals an adequate image that completed before hydration, without enlarging its aspect ratio', () => {
    vi.stubGlobal('devicePixelRatio', 3)
    const image = loadedImage()
    const cleanup = observeResponsiveImage(image)
    expect(image.style.visibility).toBe('')
    expect(image.dataset.originalFallback).toBeUndefined()
    cleanup()
  })

  it('keeps a panorama hidden and selects the original when a square cover needs more pixels', () => {
    vi.stubGlobal('devicePixelRatio', 3)
    const image = loadedImage({ sourceWidth: 2000, sourceHeight: 100 })
    image.style.objectFit = 'cover'
    const cleanup = observeResponsiveImage(image)
    expect(image.style.visibility).toBe('hidden')
    expect(image.src).toBe(original)
    expect(image.srcset).toBe('')
    expect(image.dataset.originalFallback).toBe('true')
    image.dispatchEvent(new Event('load'))
    expect(image.style.visibility).toBe('')
    cleanup()
  })

  it('does not unnecessarily fall back for a wide source fitted inside its slot', () => {
    vi.stubGlobal('devicePixelRatio', 3)
    const image = loadedImage({ sourceWidth: 2000, sourceHeight: 100 })
    image.style.objectFit = 'contain'
    const cleanup = observeResponsiveImage(image)
    expect(image.dataset.originalFallback).toBeUndefined()
    expect(image.style.visibility).toBe('')
    cleanup()
  })

  it('recovers from an optimizer error before observation, and stops after the original fails', () => {
    const image = loadedImage()
    expect(retryOriginalImage(image)).toBe(true)
    const cleanup = observeResponsiveImage(image)
    image.dispatchEvent(new Event('load'))
    expect(image.style.visibility).toBe('')
    expect(retryOriginalImage(image)).toBe(false)
    expect(image.src).toBe(original)
    cleanup()
  })

  it('ignores an old observer after React switches the element to an eager original', () => {
    const image = loadedImage()
    const onError = vi.fn()
    image.addEventListener('error', onError)
    const cleanup = observeResponsiveImage(image)
    delete image.dataset.originalSrc
    image.removeAttribute('srcset')
    image.src = original
    image.dispatchEvent(new Event('load'))
    expect(onError).not.toHaveBeenCalled()
    expect(image.style.visibility).toBe('')
    Object.defineProperty(image, 'complete', { value: false })
    window.dispatchEvent(new Event('resize'))
    expect(image.style.visibility).toBe('')
    expect(onError).not.toHaveBeenCalled()
    cleanup()
  })

  it('retries a failed request that completed before hydration, then reports final failure once', () => {
    const image = loadedImage({ sourceWidth: 0, sourceHeight: 0 })
    const onOriginal = vi.fn()
    const onError = vi.fn()
    image.addEventListener('error', onError)
    const cleanup = observeResponsiveImage(image, onOriginal)
    expect(image.src).toBe(original)
    expect(onOriginal).toHaveBeenCalledOnce()
    image.dispatchEvent(new Event('load'))
    window.dispatchEvent(new Event('resize'))
    expect(onError).toHaveBeenCalledOnce()
    expect(image.style.visibility).toBe('')
    cleanup()
  })

  it('rechecks layout and zoom, retaining the original after a beyond-limit display', () => {
    vi.stubGlobal('devicePixelRatio', 1)
    let resize: (() => void) | undefined
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe() {}
      disconnect = disconnect
    })
    const image = loadedImage({ width: 1200, height: 600, requestedWidth: 3840 })
    const cleanup = observeResponsiveImage(image)
    expect(image.dataset.originalFallback).toBeUndefined()
    vi.stubGlobal('devicePixelRatio', 4)
    window.dispatchEvent(new Event('resize'))
    expect(image.dataset.originalFallback).toBe('true')
    vi.stubGlobal('devicePixelRatio', 1)
    resize?.()
    expect(image.src).toBe(original)
    cleanup()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('rechecks DPR changes even when the viewport dimensions do not change', () => {
    vi.stubGlobal('devicePixelRatio', 1)
    const media = new EventTarget()
    vi.stubGlobal('matchMedia', vi.fn(() => media))
    const image = loadedImage({ requestedWidth: 128 })
    const cleanup = observeResponsiveImage(image)
    vi.stubGlobal('devicePixelRatio', 3)
    media.dispatchEvent(new Event('change'))
    expect(image.src).toBe(original)
    cleanup()
  })
})
