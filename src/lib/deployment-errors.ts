/** Failures for which a fresh document can replace an outdated client bundle. */
export function isStaleDeploymentError(error: Error) {
  return (
    error.name === 'ChunkLoadError' ||
    /Loading chunk .* failed|Failed to fetch dynamically imported module|import\(\) failed/i.test(error.message)
  )
}
