// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { ResponsiveImage } from '@/components/ResponsiveImage'
import { RichContent } from '@/components/RichContent'
import { ProjectLogo } from '@/components/ProjectLogo'
import { ProjectLogoWithFallback } from '@/components/ProjectLogoWithFallback'

let root: Root | undefined
const container = document.createElement('div')
document.body.append(container)
afterEach(async () => { await act(async () => root?.unmount()) })

describe('ProjectLogo', () => {
  it('keeps the inline SVG format used by updated project metadata at original fidelity', async () => {
    const src = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E'
    root = createRoot(container)
    await act(async () => root?.render(<ProjectLogo name="Kenny's Bounty Engine Network" logoUri={src} size={112} />))
    const image = container.querySelector('img')!
    expect(image.src).toBe(src)
    expect(image.hasAttribute('srcset')).toBe(false)
    expect(image.style.visibility).toBe('')
  })

  it('retries the original once, then replaces a failed original with the deterministic initial tile', async () => {
    root = createRoot(container)
    await act(async () => root?.render(<ProjectLogoWithFallback name="Broken logo" logoUri="ipfs://QmBroken" size={56} />))
    const image = container.querySelector('img')!
    expect(image.sizes).toBe('56px')
    await act(async () => image.dispatchEvent(new Event('error')))
    expect(image.src).toBe('https://juicebox.center/ipfs/QmBroken')
    expect(container.querySelector('img')).toBe(image)
    await act(async () => image.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('span')?.textContent).toBe('B')
  })

  it('keeps the original after same-source sizes/class updates and reveals it after loading', async () => {
    root = createRoot(container)
    const src = 'https://juicebox.center/ipfs/QmPhoto'
    await act(async () => root?.render(<ResponsiveImage src={src} sizes="112px" alt="Artwork" loading="lazy" />))
    const image = container.querySelector('img')!
    await act(async () => image.dispatchEvent(new Event('error')))
    await act(async () => root?.render(<ResponsiveImage src={src} sizes="100vw" alt="Artwork" loading="lazy" className="w-full" />))
    expect(image.src).toBe(src)
    expect(image.srcset).toBe('')
    expect(image.sizes).toBe('')
    expect(image.style.objectFit).toBe('contain')
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 2000 }, naturalHeight: { value: 1000 } })
    await act(async () => image.dispatchEvent(new Event('load')))
    expect(image.style.visibility).toBe('')
  })

  it.each([
    {}, { loading: 'eager' as const }, { loading: 'lazy' as const, fetchPriority: 'high' as const },
  ])('server-renders a visible contained critical derivative without waiting for hydration: %j', props => {
    const src = 'https://juicebox.center/ipfs/QmPhoto'
    const html = renderToStaticMarkup(<ResponsiveImage src={src} sizes="112px" alt="Artwork" {...props} />)
    expect(html).toContain('srcSet=')
    expect(html).toContain('object-fit:contain')
    expect(html).not.toContain('visibility:hidden')
    expect(html).toContain(`data-original-src="${src}"`)
  })

  it('still server-renders guarded responsive candidates for explicitly lazy images', () => {
    const html = renderToStaticMarkup(<ResponsiveImage src="https://juicebox.center/ipfs/QmPhoto" sizes="112px" alt="Artwork" loading="lazy" />)
    expect(html).toContain('srcSet=')
    expect(html).toContain('object-fit:contain')
    expect(html).not.toContain('visibility:hidden')
  })

  it('installs the fidelity guard when a source changes from eager to lazy delivery', async () => {
    root = createRoot(container)
    const src = 'https://juicebox.center/ipfs/QmPhoto'
    await act(async () => root?.render(<ResponsiveImage src={src} sizes="112px" alt="Artwork" />))
    const image = container.querySelector('img')!
    expect(image.style.visibility).toBe('')
    await act(async () => root?.render(<ResponsiveImage src={src} sizes="112px" alt="Artwork" loading="lazy" />))
    expect(image.style.objectFit).toBe('contain')
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 384 }, naturalHeight: { value: 384 } })
    await act(async () => image.dispatchEvent(new Event('load')))
    expect(image.style.visibility).toBe('')
  })

  it('requalifies a changed inline fit and retains native upgrades across pending React rerenders', async () => {
    root = createRoot(container)
    const src = 'https://juicebox.center/ipfs/QmPhoto'
    await act(async () => root?.render(<ResponsiveImage src={src} sizes="144px" alt="Artwork" style={{ objectFit: 'contain' }} />))
    const image = container.querySelector('img')!
    const first = `http://localhost/_next/image?url=${encodeURIComponent(src)}&w=384&q=90`
    Object.defineProperties(image, {
      currentSrc: { configurable: true, value: first }, complete: { configurable: true, value: true },
      naturalWidth: { value: 1536 }, naturalHeight: { value: 384 },
    })
    let size = 144
    image.getBoundingClientRect = () => ({ width: size, height: size }) as DOMRect
    await act(async () => image.dispatchEvent(new Event('load')))
    await act(async () => root?.render(<ResponsiveImage src={src} sizes="144px" alt="Artwork" style={{ objectFit: 'cover' }} />))
    expect(new URL(image.src).searchParams.get('w')).toBe('640')
    expect(image.style.objectFit).toBe('contain')
    expect(image.style.visibility).toBe('')
    Object.defineProperty(image, 'complete', { configurable: true, value: false })
    await act(async () => root?.render(<ResponsiveImage src={src} sizes="100vw" alt="Artwork" className="changed-parent" style={{ objectFit: 'cover' }} />))
    for (let i = 0; i < 3; i++) await act(async () => window.dispatchEvent(new Event('resize')))
    expect(new URL(image.src).searchParams.get('w')).toBe('640')
    expect(image.srcset).toBe('')
    expect(image.style.visibility).toBe('')
    Object.defineProperties(image, { currentSrc: { configurable: true, value: image.src }, complete: { configurable: true, value: true } })
    await act(async () => image.dispatchEvent(new Event('load')))
    expect(image.style.objectFit).toBe('cover')
    await act(async () => root?.render(<ResponsiveImage src={src} sizes="100vw" alt="Artwork" className="changed-parent" style={{ objectFit: 'cover' }} />))
    expect(image.style.objectFit).toBe('cover')
    size = 350
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(new URL(image.src).searchParams.get('w')).toBe('1920')
    expect(image.dataset.originalFallback).toBeUndefined()
  })

  it('recovers from a failed replacement while currentSrc still names the previous decoded candidate', async () => {
    root = createRoot(container)
    await act(async () => root?.render(<ProjectLogoWithFallback name="Broken replacement" logoUri="ipfs://QmPhoto" size={144} />))
    const image = container.querySelector('img')!
    image.dataset.imageFit = 'cover'
    const currentSrc = `http://localhost/_next/image?url=${encodeURIComponent(image.dataset.originalSrc!)}&w=384&q=90`
    Object.defineProperties(image, { currentSrc: { value: currentSrc }, complete: { value: true }, naturalWidth: { value: 1536 }, naturalHeight: { value: 384 } })
    image.getBoundingClientRect = () => ({ width: 144, height: 144 }) as DOMRect
    await act(async () => image.dispatchEvent(new Event('load')))
    expect(new URL(image.src).searchParams.get('w')).toBe('640')
    await act(async () => image.dispatchEvent(new Event('error')))
    expect(image.src).toBe('https://juicebox.center/ipfs/QmPhoto')
    expect(image.dataset.originalFallback).toBe('true')
    await act(async () => image.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('span')?.textContent).toBe('B')
  })

  it('recovers a pending sanitized description candidate through the real ancestor error handler', async () => {
    root = createRoot(container)
    await act(async () => root?.render(<RichContent html="![Artwork](ipfs://QmPhoto)" fallback={[]} imageSizes="144px" />))
    const image = container.querySelector('img')!
    image.dataset.imageFit = 'cover'
    const currentSrc = `http://localhost/_next/image?url=${encodeURIComponent(image.dataset.originalSrc!)}&w=384&q=90`
    Object.defineProperties(image, { currentSrc: { value: currentSrc }, complete: { value: true }, naturalWidth: { value: 1536 }, naturalHeight: { value: 384 } })
    image.getBoundingClientRect = () => ({ width: 144, height: 144 }) as DOMRect
    await act(async () => image.dispatchEvent(new Event('load')))
    expect(new URL(image.src).searchParams.get('w')).toBe('640')
    await act(async () => image.dispatchEvent(new Event('error')))
    expect(image.src).toBe('https://juicebox.center/ipfs/QmPhoto')
    expect(image.dataset.originalFallback).toBe('true')
    await act(async () => image.dispatchEvent(new Event('error')))
    expect(image.src).toBe('https://juicebox.center/ipfs/QmPhoto')
    expect(image.style.visibility).toBe('')
  })

  it('resets the delivery lifecycle for a changed source instead of retaining a failed image', async () => {
    root = createRoot(container)
    await act(async () => root?.render(<ProjectLogo name="Project" logoUri="ipfs://QmFirst" size={112} />))
    const first = container.querySelector('img')!
    await act(async () => first.dispatchEvent(new Event('error')))
    expect(first.dataset.originalFallback).toBe('true')
    await act(async () => root?.render(<ProjectLogo name="Project" logoUri="ipfs://QmSecond" size={112} />))
    const second = container.querySelector('img')!
    expect(second).not.toBe(first)
    expect(second.dataset.originalSrc).toBe('https://juicebox.center/ipfs/QmSecond')
    expect(second.dataset.originalFallback).toBeUndefined()
    expect(second.style.objectFit).toBe('contain')
  })
})
