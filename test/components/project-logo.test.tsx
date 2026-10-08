// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ResponsiveImage } from '@/components/ResponsiveImage'
import { ProjectLogo } from '@/components/ProjectLogo'
import { ProjectLogoWithFallback } from '@/components/ProjectLogoWithFallback'

let root: Root | undefined
const container = document.createElement('div')
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
    await act(async () => root?.render(<ResponsiveImage src={src} sizes="112px" alt="Artwork" />))
    const image = container.querySelector('img')!
    await act(async () => image.dispatchEvent(new Event('error')))
    await act(async () => root?.render(<ResponsiveImage src={src} sizes="100vw" alt="Artwork" className="w-full" />))
    expect(image.src).toBe(src)
    expect(image.srcset).toBe('')
    expect(image.sizes).toBe('')
    expect(image.style.visibility).toBe('hidden')
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 2000 }, naturalHeight: { value: 1000 } })
    await act(async () => image.dispatchEvent(new Event('load')))
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
    expect(second.style.visibility).toBe('hidden')
  })
})
