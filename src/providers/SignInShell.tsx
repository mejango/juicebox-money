/**
 * The sign-in sheet's silhouette: same blocks, same heights, no behaviour.
 *
 * Shown while the real sheet cannot render yet — first because Para's chunk
 * is still downloading, then because `ParaProvider` renders nothing at all
 * until Para's API answers. Both waits land on this, so the panel stays put
 * and only its contents resolve.
 */
export function SignInShell() {
  return (
    <div className="w-full" aria-busy="true">
      <h2 className="font-agrandir text-2xl font-medium text-ink">Sign in</h2>
      <p className="mt-1 text-sm text-smoke-700">You will receive a code.</p>
      <div className="input-well mt-5 h-[46px] w-full animate-pulse bg-smoke-25" />
      <div className="mt-3 flex justify-end">
        <div className="h-10 w-24 animate-pulse rounded-lg bg-smoke-100" />
      </div>
      {[7, 4].map((count, row) => (
        <div key={row}>
          <div className="mb-2 mt-4 h-3 w-14 animate-pulse rounded bg-smoke-100" />
          <div className="flex min-h-10 flex-wrap gap-1.5">
            {Array.from({ length: count }, (_, i) => (
              <div
                key={i}
                className="h-10 w-10 animate-pulse rounded-lg bg-smoke-100"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
