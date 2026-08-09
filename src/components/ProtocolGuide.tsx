'use client'

import { useEffect } from 'react'
import {
  renderBuildTab,
  renderLearnTab,
} from '@/lib/juicescan-learn-build'

export function ProtocolGuide({ guide }: { guide: 'learn' | 'build' }) {
  const containerId = `tab-${guide}`

  useEffect(() => {
    if (guide === 'learn') renderLearnTab()
    else renderBuildTab()

    const target = window.location.hash
      ? document.getElementById(window.location.hash.slice(1))
      : null
    target?.scrollIntoView({ block: 'start' })

    return () => {
      const container = document.getElementById(containerId)
      if (container) container.replaceChildren()
    }
  }, [containerId, guide])

  return (
    <div
      id={containerId}
      className="juicebox-guide"
      aria-label={guide === 'learn' ? 'Learn Juicebox' : 'Build with Juicebox'}
    />
  )
}
