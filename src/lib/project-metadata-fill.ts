import { ipfsUrl } from '@/lib/format'
import { fetchMetadataJson } from '@/lib/metadata-json'

export type MetadataLoader = (url: string) => Promise<unknown>

const loadMetadata: MetadataLoader = url => fetchMetadataJson(url, { signal: AbortSignal.timeout(8_000) })

type IndexedNameRow = {
  name?: string | null
  logoUri?: string | null
  projectTagline?: string | null
  metadataUri?: string | null
}

async function fetchIndexedMetadata(
  metadataUri: string,
  load: MetadataLoader,
): Promise<{ name?: unknown; logoUri?: unknown; projectTagline?: unknown } | null> {
  const url = ipfsUrl(metadataUri)
  if (!url) return null
  try {
    const json = await load(url)
    return typeof json === 'object' && json !== null && !Array.isArray(json)
      ? (json as { name?: unknown; logoUri?: unknown; projectTagline?: unknown })
      : null
  } catch {
    return null
  }
}

/**
 * Bendystraw fetches project metadata once, when the uri is set; when its
 * gateway misses, the row indexes with no name or logo for good. Fill those
 * rows from the uri itself so a list never shows "Project N" with a blank
 * logo for a project whose metadata resolves fine.
 */
export async function fillIndexedMetadata<T extends IndexedNameRow>(
  rows: readonly T[],
  load: MetadataLoader = loadMetadata,
): Promise<T[]> {
  return Promise.all(
    rows.map(async row => {
      if (row.name || row.logoUri || !row.metadataUri) return row
      const metadata = await fetchIndexedMetadata(row.metadataUri, load)
      if (!metadata) return row
      return {
        ...row,
        name: typeof metadata.name === 'string' ? metadata.name : row.name,
        logoUri: typeof metadata.logoUri === 'string' ? metadata.logoUri : row.logoUri,
        projectTagline:
          typeof metadata.projectTagline === 'string'
            ? metadata.projectTagline
            : row.projectTagline,
      }
    }),
  )
}
