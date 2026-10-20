'use client'

import { useEffect, useState } from 'react'
import type { NormalizedProjectHandle } from '@/lib/project-handles'
import {
  peekProjectHandleFromRoute,
  projectHandleFromRoute,
} from '@/lib/project-handle-route'

/**
 * A route segment's `/@handle`, re-rendering once ENSIP-15 normalization has
 * loaded. `undefined` means a handle segment whose answer is still loading;
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
    projectHandleFromRoute(segment).then(
      handle => { if (live) setLoaded({ segment, handle }) },
      () => { if (live) setLoaded({ segment, handle: null }) },
    )
    return () => { live = false }
  }, [peeked, segment])

  if (peeked !== undefined) return peeked
  return loaded?.segment === segment ? loaded.handle : undefined
}
