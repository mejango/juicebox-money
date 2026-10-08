'use client'

import { useState } from 'react'
import { ResponsiveImage } from '@/components/ResponsiveImage'
import { ProjectLogo } from '@/components/ProjectLogo'
import { RichContent } from '@/components/RichContent'

const CID = 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR'
const source = (kind: string) => `https://juicebox.center/ipfs/${CID}/${kind}`

export default function ImageProofPage() {
  const [expanded, setExpanded] = useState(false)
  const [failed, setFailed] = useState(false)
  const rich = `<img src="ipfs://${CID}/raster" alt="Description image" onerror="window.__badImage=true" srcset="https://evil.invalid/low.png 1x" data-original-src="https://evil.invalid/original.png">`
  return (
    <main style={{ padding: 16, background: '#fff', color: '#111' }}>
      <h1>Responsive image proof</h1>
      <div data-testid="critical-project-logo"><ProjectLogo name="Critical proof" logoUri={`ipfs://${CID}/bigcritical`} size={112} eager /></div>
      <ResponsiveImage loading="eager" fetchPriority="high" alt="Critical header cover" src={source('bigcritical')} sizes="(max-width: 1136px) calc(100vw - 32px), 1104px" className="object-cover" style={{ width: 'min(1104px, 100%)', height: 240 }} />
      <ResponsiveImage loading="eager" alt="Critical inline cover" src={source('transition')} sizes="128px" style={{ width: 128, height: 128, objectFit: 'cover' }} />
      <ResponsiveImage fetchPriority="high" alt="High priority thumbnail" src={source('bigcritical')} sizes="96px" style={{ width: 96, height: 96, objectFit: 'contain' }} />
      <ResponsiveImage alt="Default cart thumbnail" src={source('bigcritical')} sizes="64px" style={{ width: 64, height: 64, objectFit: 'contain' }} />

      <div data-testid="project-logo"><ProjectLogo name="Image proof" logoUri={`ipfs://${CID}/alpha`} size={48} /></div>
      <div data-testid="eager-project-logo"><ProjectLogo name="Eager proof" logoUri={`ipfs://${CID}/alpha`} size={48} eager /></div>
      <ResponsiveImage loading="lazy" alt="Raster preview" src={source('raster')} sizes="(max-width: 640px) calc(100vw - 32px), 320px" style={{ width: 'min(320px, 100%)', height: 'auto' }} />
      <ResponsiveImage loading="lazy" alt="Transparent image" src={source('alpha')} sizes="96px" style={{ width: 96, height: 96 }} />
      <ResponsiveImage loading="lazy" alt="Panorama cover" src={source('panorama')} sizes="128px" style={{ width: 128, height: 128, objectFit: 'cover' }} />
      <ResponsiveImage loading="lazy" alt="SVG image" src={source('svg')} sizes="96px" style={{ width: 96, height: 96 }} />
      <div style={{ width: 320, maxWidth: '100%' }}><RichContent html={rich} fallback={[]} imageSizes="320px" className="[&_img]:w-full [&_img]:h-auto" /></div>
      <ResponsiveImage loading="lazy" alt="Shop thumbnail slot" src={source('raster')} sizes="128px" style={{ width: 128, height: 128, objectFit: 'contain' }} />
      <ResponsiveImage loading="eager" alt="Shop detail slot" src={source('bigcritical')} sizes="320px" style={{ width: 320, height: 160, objectFit: 'contain' }} />
      <button type="button" onClick={() => setExpanded(true)}>Expand beyond derivatives</button>
      <ResponsiveImage loading="lazy" alt="Resizable image" src={source('raster')} sizes={expanded ? '2000px' : '128px'} style={{ width: expanded ? 2000 : 128, height: 'auto', maxWidth: 'none' }} />
      <ResponsiveImage loading="lazy" alt="Recovered image" src={source('recover')} sizes="96px" style={{ width: 96, height: 48 }} />
      {failed ? <span>Original also unavailable</span> : <ResponsiveImage loading="lazy" alt="Unavailable image" src={source('missing')} sizes="96px" onError={() => setFailed(true)} style={{ width: 96, height: 48 }} />}
      {['gif', 'avif', 'avis'].map(kind => <ResponsiveImage loading="lazy" key={kind} alt={`${kind} animation`} src={source(kind)} sizes="64px" style={{ width: 64, height: 64 }} />)}
    </main>
  )
}
