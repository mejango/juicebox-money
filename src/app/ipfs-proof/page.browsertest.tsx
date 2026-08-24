'use client'

/**
 * Deterministic-browser-only proof for the real Juicebox Center adapter.
 *
 * Native Window.fetch rejects calls made with an arbitrary object receiver.
 * Unit-test mocks do not enforce that browser contract, so this route lets the
 * Playwright suite exercise the adapter in Chromium. It is excluded from every
 * production build by next.config.js's pageExtensions setting.
 */

import { useEffect, useState } from 'react'
import { jbCenterIpfs } from '@/lib/jbcenter-ipfs'

export default function IpfsProofPage() {
  const [result, setResult] = useState('idle')
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])

  const pin = async () => {
    setResult('saving')
    try {
      const saved = await jbCenterIpfs.pinJson({ name: 'Browser proof' })
      setResult(saved.uri)
    } catch (error) {
      setResult(error instanceof Error ? error.message : 'Unknown error')
    }
  }

  return (
    <main data-ipfs-proof-ready={ready ? 'true' : 'false'}>
      <h1>IPFS browser proof</h1>
      <button type="button" onClick={() => void pin()}>
        Save metadata
      </button>
      <output data-testid="pin-result">{result}</output>
    </main>
  )
}
