import { bendystraw, BendystrawRateLimited } from '@/lib/bendystraw'
import { resolvePersistedBendystrawRequest } from '@/lib/bendystraw-proxy'

const MAX_REQUEST_BYTES = 32 * 1024

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** The wait a 429 names when the indexer gave none in whole seconds: one page refresh. */
const RETRY_AFTER_SECONDS = '30'

type SharedRead = { read: Promise<unknown>; waiting: number; stop: AbortController }
const inFlight = new Map<string, SharedRead>()

/**
 * One indexer read for identical requests that overlap: every visitor polls
 * the same queries, and they all spend this server's budget. The read ends
 * when the last browser waiting on it has left. Nothing is kept once it settles.
 */
function sharedRead(
  key: string,
  signal: AbortSignal,
  read: (signal: AbortSignal) => Promise<unknown>,
): Promise<unknown> {
  let shared = inFlight.get(key)
  if (!shared) {
    const stop = new AbortController()
    const entry: SharedRead = {
      stop,
      waiting: 0,
      read: read(stop.signal).finally(() => {
        if (inFlight.get(key) === entry) inFlight.delete(key)
      }),
    }
    inFlight.set(key, entry)
    shared = entry
  }
  const entry = shared
  entry.waiting += 1
  return new Promise((resolve, reject) => {
    const leave = () => {
      entry.waiting -= 1
      if (entry.waiting === 0) {
        if (inFlight.get(key) === entry) inFlight.delete(key)
        entry.stop.abort(signal.reason)
      }
      reject(signal.reason)
    }
    if (signal.aborted) {
      leave()
      return
    }
    signal.addEventListener('abort', leave, { once: true })
    entry.read
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', leave))
  })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ net: string }> },
) {
  const { net } = await params
  if (net !== 'mainnet' && net !== 'testnet') {
    return Response.json({ error: 'unsupported network' }, { status: 404 })
  }
  if (
    !request.headers.get('content-type')?.toLowerCase().startsWith(
      'application/json',
    )
  ) {
    return Response.json(
      { error: 'content type must be application/json' },
      { status: 415 },
    )
  }
  const declaredSize = Number(request.headers.get('content-length') ?? 0)
  if (declaredSize > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'request is too large' }, { status: 413 })
  }

  const bytes = await readBoundedBody(request.body)
  if (!bytes) {
    return Response.json({ error: 'request is too large' }, { status: 413 })
  }

  let persisted
  try {
    persisted = resolvePersistedBendystrawRequest(
      JSON.parse(new TextDecoder().decode(bytes)),
    )
  } catch {
    persisted = null
  }
  if (!persisted) {
    return Response.json(
      { error: 'unknown or invalid operation' },
      { status: 400 },
    )
  }

  try {
    // Uncached: Next's fetch cache would keep a disk file for every distinct
    // client query. The indexer read ends when every page that asked has left,
    // with no retry; a 429 is answered as one, not asked again.
    const data = await sharedRead(
      `${net}\n${persisted.query}\n${JSON.stringify(persisted.variables)}`,
      request.signal,
      signal =>
        bendystraw(persisted.query, persisted.variables, {
          network: net,
          policy: 'no-store',
          signal,
          failOnRateLimit: true,
        }),
    )
    return Response.json(
      { data },
      {
        headers: {
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      },
    )
  } catch (error) {
    // The cause is logged, on one line, and never sent: the answer is the same
    // whatever failed. Control characters go too, so an indexer's text cannot
    // start a terminal sequence or forge a log line. A read the browser ended
    // by leaving did not fail, so it is not logged.
    if (!request.signal.aborted) {
      console.error(
        'Bendystraw relay failed:',
        String(error).replace(/[\p{Cc}\s]+/gu, ' '),
      )
    }
    if (error instanceof BendystrawRateLimited) {
      return Response.json(
        { error: 'Bendystraw rate limited' },
        {
          status: 429,
          headers: {
            'cache-control': 'no-store',
            'retry-after': /^\d{1,5}$/.test(error.retryAfter ?? '')
              ? error.retryAfter!
              : RETRY_AFTER_SECONDS,
          },
        },
      )
    }
    return Response.json(
      { error: 'Bendystraw unavailable' },
      { status: 502 },
    )
  }
}
