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
