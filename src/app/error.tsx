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

export default function AppError({
  error,
  reset,
}: {
  error: Error
  reset: () => void
}) {
  useEffect(() => {
    if (isStaleDeploymentError(error)) window.location.reload()
  }, [error])

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
