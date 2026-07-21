/**
 * Shared 721 tier metadata helpers: the data-URI JSON parser and the
 * productName/name field mapping the Shop tab and Pay card both apply to a
 * tier's `resolvedUri` (or its fetched IPFS JSON).
 */

/** Initial supply at/above this sentinel means unlimited inventory
 *  (website/ parity: TIER_UNLIMITED_SUPPLY in nft721-build.js). */
export const TIER_UNLIMITED_SUPPLY = 999_999_999

/**
 * Parse a `data:application/json[;base64],…` URI into its JSON object.
 * Null for non-data URIs, non-object JSON, or any decode failure —
 * metadata is cosmetic, so callers fall back rather than throw.
 */
export function parseTierMetadataJson(
  uri: string,
): Record<string, unknown> | null {
  if (!uri.startsWith('data:application/json')) return null
  try {
    const json = JSON.parse(
      uri.includes('base64,')
        ? // decodeURIComponent(escape(...)) round-trips UTF-8 through atob.
          decodeURIComponent(escape(atob(uri.split('base64,')[1])))
        : decodeURIComponent(uri.split(',').slice(1).join(',')),
    ) as unknown
    return json && typeof json === 'object'
      ? (json as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export type PickedTierMetadata = {
  name?: string
  description?: string
  /** Raw image value (`image` ?? `imageUri`) — callers map ipfs:// etc. */
  image?: string
  animationUrl?: string
  mediaType?: string
  categoryName?: string
}

/** The shared field mapping: productName/name, productDescription/description,
 *  image/imageUri, and the media-type aliases. String fields only. */
export function pickTierMetadata(
  json: Record<string, unknown>,
): PickedTierMetadata {
  return {
    name: str(json.productName) ?? str(json.name),
    description: str(json.productDescription) ?? str(json.description),
    image: str(json.image) ?? str(json.imageUri),
    animationUrl: str(json.animation_url) ?? str(json.animationUrl),
    mediaType:
      str(json.mediaType) ?? str(json.animationType) ?? str(json.mimeType),
    categoryName: str(json.categoryName),
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** `<cid>[/path]` from an ipfs:// URI or any https gateway's /ipfs/ URL. */
function ipfsAssetPath(url: string): string | null {
  if (url.startsWith('ipfs://')) return url.slice('ipfs://'.length)
  const gateway = /^https?:\/\/[^/]+\/ipfs\/(.+)$/.exec(url)
  return gateway ? gateway[1] : null
}

/**
 * Make a tier media URL loadable from the browser. IPFS-addressed URLs —
 * ipfs:// URIs AND ones hot-linked to somebody else's gateway host (Banny
 * resolver SVGs point at bannyverse.infura-ipfs.io) — are re-routed through
 * the app's own immutable IPFS cache (/api/ipfs): the CID path never
 * changes, third-party gateways retire, public ones 504 on cold DHT
 * lookups, and the upstream throttles a grid's worth of parallel fetches.
 */
export function tierMediaAssetUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  if (value.startsWith('data:')) return value
  const path = ipfsAssetPath(value)
  return path ? `/api/ipfs/${path}` : value
}

/** Decoded markup of a `data:image/svg+xml…` URI (base64 or URL-encoded), else null. */
function svgDataUriMarkup(uri: string): string | null {
  const match = /^data:image\/svg\+xml([^,]*),([\s\S]*)$/.exec(uri)
  if (!match) return null
  try {
    return match[1].includes('base64')
      ? // decodeURIComponent(escape(...)) round-trips UTF-8 through atob.
        decodeURIComponent(escape(atob(match[2])))
      : decodeURIComponent(match[2])
  } catch {
    return null
  }
}

/**
 * Make a metadata image renderable in an <img>. Resolvers sometimes return an
 * SVG data URI that merely wraps an external `<image href="…">` (Banny
 * accessories) — browsers block external loads inside an <img> data URI, so
 * pull the href out and load the bitmap directly (through the gateway, see
 * tierMediaAssetUrl). Self-contained SVGs pass through untouched.
 */
export function tierMediaImageUrl(image: unknown): string | undefined {
  if (typeof image !== 'string' || !image) return undefined
  const markup = svgDataUriMarkup(image)
  if (markup) {
    // Also matches xlink:href, single or double quoted.
    const href = /<image[^>]+href=["']([^"']+)["']/.exec(markup)?.[1]
    if (href && !href.startsWith('data:')) return tierMediaAssetUrl(href)
    return image
  }
  return tierMediaAssetUrl(image)
}
