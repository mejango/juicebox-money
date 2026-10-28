import { unstable_cache } from 'next/cache'
import { fetchMetadataJson } from '@/lib/metadata-json'

/** Cache only admitted JSON, never an unbounded response clone inside Next's fetch cache. */
function cachedMetadata(revalidate: number, timeoutMs: number) {
  return unstable_cache(async (url: string): Promise<Record<string, unknown>> => {
    const json = await fetchMetadataJson(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error('Metadata is not a JSON object.')
    }
    return json as Record<string, unknown>
  }, ['bounded-project-metadata-v1', String(revalidate), String(timeoutMs)], { revalidate })
}

export const readIndexedMetadataJson = cachedMetadata(600, 8_000)
export const readProjectMetadataJson = cachedMetadata(300, 10_000)
