const QUICK_MS = 5_000
const QUICK_WINDOW_MS = 2 * 60_000
const SETTLED_MS = 30_000

/**
 * Run `check` now, then every 5 seconds for the 2 minutes in which a launch
 * usually gets indexed, then every 30 seconds. A check is skipped while the
 * document is hidden. Returns the stop function.
 */
export function pollIndexed(check: () => Promise<void>): () => void {
  const startedAt = Date.now()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = async () => {
    if (document.visibilityState !== 'hidden') await check()
    if (stopped) return
    timer = setTimeout(
      () => void run(),
      Date.now() - startedAt < QUICK_WINDOW_MS ? QUICK_MS : SETTLED_MS,
    )
  }
  void run()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
