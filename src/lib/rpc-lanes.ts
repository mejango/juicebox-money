import type { JBCenterLimiter } from '@bananapus/nana-sdk-core/jbcenter'

type Waiting = {
  start: () => void
}

/**
 * Two lines in front of one limiter, which starts requests in the order they reach it. Only one
 * request waits in the limiter at a time, so the first lane overtakes everything still held here
 * while the limiter keeps the page's pacing and its pause after a 429.
 */
export function createRpcLanes(limiter: JBCenterLimiter) {
  const held: Record<'first' | 'rest', Waiting[]> = { first: [], rest: [] }
  let inLimiter = false

  function next() {
    if (inLimiter) return
    const waiting = held.first.shift() ?? held.rest.shift()
    if (!waiting) return
    inLimiter = true
    waiting.start()
  }

  function lane(name: keyof typeof held): JBCenterLimiter {
    return {
      ...limiter,
      run: (send, { signal } = {}) =>
        new Promise((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason)
          const leave = () => {
            held[name].splice(held[name].indexOf(waiting), 1)
            reject(signal!.reason)
          }
          const waiting: Waiting = {
            start() {
              signal?.removeEventListener('abort', leave)
              let left = false
              const leaveLimiter = () => {
                if (left) return
                left = true
                inLimiter = false
                // A later turn: the limiter refuses a request asked for while one is starting.
                queueMicrotask(next)
              }
              limiter
                .run(() => {
                  leaveLimiter()
                  return send()
                }, { signal })
                .then(resolve, reject)
                .finally(leaveLimiter)
            },
          }
          signal?.addEventListener('abort', leave, { once: true })
          held[name].push(waiting)
          next()
        }),
    }
  }

  return { first: lane('first'), rest: lane('rest') }
}
