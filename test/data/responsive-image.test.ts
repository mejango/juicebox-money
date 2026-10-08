// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { observeResponsiveImage, responsiveImageProps, retryOriginalImage } from '@/lib/responsive-image'

const original = 'https://juicebox.center/ipfs/QmPhoto'
const candidate = (width: number) => `/_next/image?url=${encodeURIComponent(original)}&w=${width}&q=90`

function loadedImage({ width = 112, height = 112, sourceWidth = 400, sourceHeight = 400, requestedWidth = 384, fit = 'contain' } = {}) {
  const image = document.createElement('img')
  image.dataset.originalSrc = original
  image.dataset.imageFit = fit
  image.src = candidate(requestedWidth)
  image.srcset = responsiveImageProps(original, `${width}px`).srcSet!
  image.sizes = `${width}px`
  image.style.objectFit = 'contain'
  Object.defineProperties(image, {
    currentSrc: { configurable: true, value: image.src },
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: sourceWidth },
    naturalHeight: { configurable: true, value: sourceHeight },
  })
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({ width, height } as DOMRect)
  return image
}

function finish(image: HTMLImageElement) {
  Object.defineProperties(image, { currentSrc: { configurable: true, value: image.src }, complete: { configurable: true, value: true } })
  image.dispatchEvent(new Event('load'))
}

describe('responsive project image delivery', () => {
  it('uses real Next width descriptors/quality and visibly contains the image until fit qualification', () => {
    const props = responsiveImageProps(original, '112px', undefined, 'cover')
    expect(props.sizes).toBe('112px')
    expect(props.srcSet).toContain('w=384&q=90 384w')
    expect(props.srcSet).toContain('w=3840&q=90 3840w')
    expect(props.srcSet).not.toMatch(/ [123]x(?:,|$)/)
    expect(props['data-original-src']).toBe(original)
    expect(props['data-image-fit']).toBe('cover')
    expect(props.style).toEqual({ objectFit: 'contain' })
  })

  it.each([
    'https://example.com/image.png', 'https://juicebox.center.evil/ipfs/QmPhoto',
    'https://juicebox.center:444/ipfs/QmPhoto', 'https://juicebox.center/ipfs/QmPhoto?extra=1',
    'https://juicebox.center/ipfs/../private', 'https://juicebox.center/ipfs/QmPhoto%2f..',
    'data:image/png;base64,AAAA', 'blob:https://juicebox.money/preview', '/assets/logo.svg',
  ])('keeps an unsupported/preview source outside the optimizer: %s', src => {
    expect(responsiveImageProps(src, '112px')).toEqual({ src })
  })

  it('leaves unmanaged original fit unchanged when its own request fails', () => {
    const image = document.createElement('img')
    image.src = 'https://example.com/image.png'
    image.style.objectFit = 'cover'
    expect(retryOriginalImage(image)).toBe(false)
    expect(image.style.objectFit).toBe('cover')
  })

  it('qualifies a cached image before hydration and restores intended inline fit', () => {
    vi.stubGlobal('devicePixelRatio', 3)
    const image = loadedImage({ fit: 'cover' })
    const cleanup = observeResponsiveImage(image)
    expect(image.style.objectFit).toBe('cover')
    expect(image.style.visibility).toBe('')
    expect(image.dataset.originalFallback).toBeUndefined()
    cleanup()
  })

  it('chooses the smallest adequate crop candidate and retains sharp contained pixels while it loads', () => {
    vi.stubGlobal('devicePixelRatio', 1)
    const image = loadedImage({ width: 144, height: 144, sourceWidth: 4, sourceHeight: 1, fit: 'cover' })
    const selected = vi.fn()
    const cleanup = observeResponsiveImage(image, selected)
    expect(new URL(image.src).searchParams.get('w')).toBe('640')
    expect(image.srcset).toBe('')
    expect(image.style.objectFit).toBe('contain')
    expect(image.style.visibility).toBe('')
    expect(selected).toHaveBeenCalledOnce()
    Object.defineProperty(image, 'complete', { configurable: true, value: false })
    window.dispatchEvent(new Event('resize'))
    expect(image.style.visibility).toBe('')
    expect(selected).toHaveBeenCalledOnce()
    finish(image)
    expect(image.style.objectFit).toBe('cover')
    cleanup()
    const resumed = observeResponsiveImage(image, selected)
    vi.mocked(image.getBoundingClientRect).mockReturnValue({ width: 350, height: 350 } as DOMRect)
    window.dispatchEvent(new Event('resize'))
    expect(new URL(image.src).searchParams.get('w')).toBe('1920')
    finish(image)
    vi.mocked(image.getBoundingClientRect).mockReturnValue({ width: 144, height: 144 } as DOMRect)
    window.dispatchEvent(new Event('resize'))
    expect(new URL(image.src).searchParams.get('w')).toBe('1920')
    expect(selected).toHaveBeenCalledTimes(2)
    resumed()
  })

  it('uses the original only after candidates cannot satisfy a panorama crop', () => {
    vi.stubGlobal('devicePixelRatio', 3)
    const image = loadedImage({ sourceWidth: 2000, sourceHeight: 100, fit: 'cover' })
    const selected = vi.fn()
    const cleanup = observeResponsiveImage(image, selected)
    expect(image.src).toBe(original)
    expect(image.dataset.originalFallback).toBe('true')
    expect(image.style.objectFit).toBe('contain')
    expect(image.style.visibility).toBe('')
    finish(image)
    expect(image.style.objectFit).toBe('cover')
    window.dispatchEvent(new Event('resize'))
    expect(selected).toHaveBeenCalledOnce()
    cleanup()
  })

  it('qualifies class-based fit and default fill using both image dimensions', () => {
    const style = document.createElement('style')
    style.textContent = '.test-cover { object-fit: cover; }'
    document.head.append(style)
    const image = loadedImage({ width: 80, height: 200, requestedWidth: 128, sourceWidth: 2, sourceHeight: 1 })
    delete image.dataset.imageFit
    image.className = 'test-cover'
    document.body.append(image)
    const cleanup = observeResponsiveImage(image)
    expect(new URL(image.src).searchParams.get('w')).toBe('640')
    finish(image)
    expect(image.style.objectFit).toBe('')
    expect(getComputedStyle(image).objectFit).toBe('cover')
    cleanup()
    image.remove()
    style.remove()
    const fill = loadedImage({ width: 80, height: 200, requestedWidth: 128, sourceWidth: 2, sourceHeight: 1, fit: 'fill' })
    const stop = observeResponsiveImage(fill)
    expect(new URL(fill.src).searchParams.get('w')).toBe('640')
    finish(fill)
    expect(fill.style.objectFit).toBe('fill')
    stop()
  })

  it('does not upgrade a wide source that already fits sharply inside its slot', () => {
    vi.stubGlobal('devicePixelRatio', 3)
    const image = loadedImage({ sourceWidth: 2000, sourceHeight: 100 })
    const cleanup = observeResponsiveImage(image)
    expect(image.dataset.originalFallback).toBeUndefined()
    expect(image.style.visibility).toBe('')
    cleanup()
  })

  it('recovers from an optimizer error before observation, and stops after the original fails', () => {
    const image = loadedImage()
    expect(retryOriginalImage(image)).toBe(true)
    const cleanup = observeResponsiveImage(image)
    finish(image)
    expect(image.style.visibility).toBe('')
    expect(retryOriginalImage(image)).toBe(false)
    expect(image.src).toBe(original)
    cleanup()
  })

  it('ignores an observer after ownership changes and starts fresh for the reused element', () => {
    const image = loadedImage()
    const error = vi.fn()
    image.addEventListener('error', error)
    const cleanup = observeResponsiveImage(image)
    delete image.dataset.originalSrc
    image.removeAttribute('srcset')
    image.src = original
    image.dispatchEvent(new Event('load'))
    Object.defineProperty(image, 'complete', { configurable: true, value: false })
    window.dispatchEvent(new Event('resize'))
    expect(image.style.visibility).toBe('')
    expect(error).not.toHaveBeenCalled()
    cleanup()
    const next = 'https://juicebox.center/ipfs/QmChanged'
    image.dataset.originalSrc = next
    image.dataset.imageFit = 'cover'
    image.src = candidate(32).replace(encodeURIComponent(original), encodeURIComponent(next))
    image.srcset = responsiveImageProps(next, '112px').srcSet!
    finish(image)
    const stop = observeResponsiveImage(image)
    expect(new URL(image.src).searchParams.get('url')).toBe(next)
    expect(new URL(image.src).searchParams.get('w')).toBe('128')
    stop()
  })

  it('retries failed-before-hydration images and reports terminal failure once', () => {
    const image = loadedImage({ sourceWidth: 0, sourceHeight: 0 })
    const selected = vi.fn()
    const error = vi.fn()
    image.addEventListener('error', error)
    const cleanup = observeResponsiveImage(image, selected)
    expect(image.src).toBe(original)
    expect(selected).toHaveBeenCalledOnce()
    finish(image)
    window.dispatchEvent(new Event('resize'))
    expect(error).toHaveBeenCalledOnce()
    expect(image.style.visibility).toBe('')
    cleanup()
  })

  it('uses the terminal original beyond the ceiling and cleans up resize observers', () => {
    vi.stubGlobal('devicePixelRatio', 1)
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect })
    const image = loadedImage({ width: 1200, height: 600, requestedWidth: 3840, sourceWidth: 2, sourceHeight: 1 })
    const cleanup = observeResponsiveImage(image)
    vi.stubGlobal('devicePixelRatio', 4)
    window.dispatchEvent(new Event('resize'))
    expect(image.dataset.originalFallback).toBe('true')
    expect(image.style.visibility).toBe('hidden')
    finish(image)
    expect(image.style.visibility).toBe('')
    cleanup()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('upgrades on native pinch zoom and removes the visual viewport listener', () => {
    vi.stubGlobal('devicePixelRatio', 1)
    const viewport = Object.assign(new EventTarget(), { scale: 1 })
    vi.stubGlobal('visualViewport', viewport)
    const add = vi.spyOn(viewport, 'addEventListener')
    const remove = vi.spyOn(viewport, 'removeEventListener')
    const image = loadedImage({ width: 128, height: 128, requestedWidth: 128 })
    const selected = vi.fn()
    const cleanup = observeResponsiveImage(image, selected)
    viewport.scale = 2
    viewport.dispatchEvent(new Event('resize'))
    expect(new URL(image.src).searchParams.get('w')).toBe('256')
    expect(image.dataset.originalFallback).toBeUndefined()
    expect(image.style.visibility).toBe('hidden')
    finish(image)
    expect(image.style.visibility).toBe('')
    viewport.scale = 3
    viewport.dispatchEvent(new Event('resize'))
    expect(new URL(image.src).searchParams.get('w')).toBe('384')
    expect(selected).toHaveBeenCalledTimes(2)
    cleanup()
    expect(remove).toHaveBeenCalledWith('resize', add.mock.calls[0][1])
    image.style.visibility = 'hidden'
    viewport.dispatchEvent(new Event('resize'))
    expect(image.style.visibility).toBe('hidden')
  })

  it('upgrades on a DPR-only native event without waiting for geometry changes', () => {
    vi.stubGlobal('devicePixelRatio', 1)
    const media = new EventTarget()
    vi.stubGlobal('matchMedia', vi.fn(() => media))
    const image = loadedImage({ requestedWidth: 128 })
    const cleanup = observeResponsiveImage(image)
    vi.stubGlobal('devicePixelRatio', 3)
    media.dispatchEvent(new Event('change'))
    expect(new URL(image.src).searchParams.get('w')).toBe('384')
    expect(image.dataset.originalFallback).toBeUndefined()
    cleanup()
  })
})
