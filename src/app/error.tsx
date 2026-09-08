'use client'

import { useEffect } from 'react'

/** True for the failure modes a fresh page load reliably fixes: a stale or
    cold-start-interrupted chunk/RSC fetch. */
function isStaleDeploymentError(error: Error) {
  return (
    error.name === 'ChunkLoadError' ||
    /Loading chunk .* failed|Failed to fetch dynamically imported module|import\(\) failed/i.test(
      error.message,
    )
  )
}

const RELOAD_KEY = 'stale-deployment-reload'

/** One automatic reload per page: a second failure on the same URL shows the
    message instead of looping. */
function shouldReload(error: Error) {
  if (typeof window === 'undefined' || !isStaleDeploymentError(error)) return false
  try {
    return sessionStorage.getItem(RELOAD_KEY) !== window.location.href
  } catch {
    return true
  }
}

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const reloading = shouldReload(error)

  // The boundary used to swallow the error, so a screenshot of this screen carried
  // nothing to diagnose — not even whether the auto-reload path had been taken.
  // Log it before deciding what to do with it.
  useEffect(() => {
    console.error('[juicebox] page error boundary', {
      name: error.name,
      message: error.message,
      digest: error.digest,
      staleDeployment: isStaleDeploymentError(error),
      url: typeof window === 'undefined' ? null : window.location.href,
    })
  }, [error])

  useEffect(() => {
    if (!reloading) return
    try {
      sessionStorage.setItem(RELOAD_KEY, window.location.href)
    } catch {}
    window.location.reload()
  }, [reloading])

  // The reload lands within a moment; a blank frame reads better than an
  // error the visitor never needed to act on.
  if (reloading) return null

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="font-agrandir-wide text-lg font-bold">
        Something went wrong loading this page.
      </h1>
      <p className="max-w-md text-sm leading-relaxed text-smoke-700">
        This is usually a hiccup while the app wakes up. Trying again almost
        always fixes it.
      </p>
      <button
        type="button"
        onClick={() => {
          reset()
          window.location.reload()
        }}
        className="btn-primary min-h-[44px] px-5 text-sm"
      >
        Reload
      </button>
    </main>
  )
}
