'use client'

import { useEffect, useState } from 'react'
import type { NormalizedProjectHandle } from '@/lib/project-handles'
import {
  peekProjectHandleFromRoute,
  projectHandleFromRoute,
} from '@/lib/project-handle-route'

/**
 * A route segment's `/@handle`, re-rendering once ENSIP-15 normalization has
 * loaded. `undefined` means a handle segment whose answer is still loading
 * (or whose normalizer failed to download);
 * once loaded, later segments answer on the first render.
 */
export function useProjectHandleFromRoute(
  segment: string,
): NormalizedProjectHandle | null | undefined {
  const [loaded, setLoaded] = useState<{
    segment: string
    handle: NormalizedProjectHandle | null
  } | null>(null)
  const peeked = peekProjectHandleFromRoute(segment)

  useEffect(() => {
    if (peeked !== undefined) return
    let live = true
    // A failed download stays pending (undefined), not "no handle": callers
    // keep the handle intent and their next parse requests the chunk again.
    projectHandleFromRoute(segment).then(
      handle => { if (live) setLoaded({ segment, handle }) },
      () => {},
    )
    return () => { live = false }
  }, [peeked, segment])

  if (peeked !== undefined) return peeked
  return loaded?.segment === segment ? loaded.handle : undefined
}
