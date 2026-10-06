import { JBCENTER_MAX_RATE_LIMIT_PAUSE_MS, retryAfterOf } from "@bananapus/nana-sdk-core/jbcenter";

// Leave headroom below Center's 600 requests/minute first-party limit.
const RPC_START_INTERVAL_MS = 125;

/** Pace request starts across chains without holding the queue for their responses. */
export function createPacedRpcFetch(send: typeof fetch): typeof fetch {
  const waiting = new Set<() => void>();
  let nextStart = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function pump() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!waiting.size) return;
    const delay = nextStart - Date.now();
    if (delay > 0) {
      timer = setTimeout(pump, delay);
      return;
    }
    const [start] = waiting;
    waiting.delete(start);
    nextStart = Date.now() + RPC_START_INTERVAL_MS;
    start();
    pump();
  }

  return (input, init) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    function abort() {
      waiting.delete(start);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
      pump();
    }
    function start() {
      signal?.removeEventListener("abort", abort);
      // Adopt synchronous throws too; neither errors nor slow responses block later starts.
      void Promise.resolve().then(() => send(input, init)).then((response) => {
        if (response.status === 429) {
          const seconds = retryAfterOf({ headers: response.headers });
          if (seconds !== undefined) {
            nextStart = Math.max(nextStart, Date.now() + Math.min(
              JBCENTER_MAX_RATE_LIMIT_PAUSE_MS,
              Math.max(0, seconds * 1_000),
            ));
            pump();
          }
        }
        resolve(response);
      }, reject);
    }
    signal?.addEventListener("abort", abort, { once: true });
    waiting.add(start);
    pump();
  });
}
