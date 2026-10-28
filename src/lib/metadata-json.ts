/** Match Juicebox Center's JSON pin limit so every supported upload remains readable. */
export const MAX_METADATA_BYTES = 2 * 1024 * 1024

/** Read the original stream, aborting it on failure rather than leaving a cache clone running. */
export async function fetchMetadataJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController()
  const signal = init.signal
    ? AbortSignal.any([controller.signal, init.signal])
    : controller.signal
  try {
    const response = await fetch(url, { ...init, cache: 'no-store', signal })
    if (!response.ok) throw new Error(`Metadata request failed (${response.status}).`)
    return await readMetadataJson(response)
  } catch (error) {
    controller.abort()
    throw error
  }
}

/** Bound decoded response bytes before parsing; Content-Length alone is not authoritative. */
export async function readMetadataJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_METADATA_BYTES) {
    void response.body?.cancel().catch(() => {})
    throw new Error('Metadata exceeds the supported 2 MiB size.')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Metadata has no readable body.')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_METADATA_BYTES) {
        void reader.cancel().catch(() => {})
        throw new Error('Metadata exceeds the supported 2 MiB size.')
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
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}
