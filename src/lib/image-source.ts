export function ipfsUrl(uri: string | null | undefined): string | null {
  if (!uri) return null
  return appIpfsUrl(uri)
}

export function appIpfsUrl(uri: string): string | null {
  const suffix = uri.replace(/^ipfs:\/\//i, '')
  const segments = suffix.split('/')
  if (
    segments.length < 1 ||
    segments.length > 8 ||
    segments.some(
      segment =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z\d._~-]{1,128}$/.test(segment),
    )
  ) {
    return null
  }
  return `https://juicebox.center/ipfs/${segments
    .map(encodeURIComponent)
    .join('/')}`
}

const MAX_INLINE_LOGO_LENGTH = 1_000_000
const SAFE_RASTER_DATA_IMAGE =
  /^data:image\/(?:avif|bmp|gif|jpe?g|png|webp);base64,[A-Za-z\d+/]+={0,2}$/i
const SVG_DATA_IMAGE_PREFIX = 'data:image/svg+xml,'
const ACTIVE_SVG_CONTENT =
  /<(?:script|foreignObject|iframe|object|embed|image|use|style)\b|(?:on[a-z]+|href|src)\s*=|url\s*\(|@import|<!doctype|<\?xml-stylesheet/iu

/**
 * Resolve an untrusted project logo without turning arbitrary URI schemes into
 * bogus IPFS gateway paths. Project metadata in the wild also uses inline
 * data-image URIs (notably generated SVG logos), which are valid image sources
 * and should be passed through unchanged.
 */
export function projectLogoUrl(uri: string | null | undefined): string | null {
  const value = uri?.trim()
  if (!value || value.length > MAX_INLINE_LOGO_LENGTH) return null
  if (SAFE_RASTER_DATA_IMAGE.test(value)) return value
  if (value.startsWith(SVG_DATA_IMAGE_PREFIX)) {
    try {
      const svg = decodeURIComponent(value.slice(SVG_DATA_IMAGE_PREFIX.length))
      if (
        svg.length > 0 &&
        svg.length <= 256_000 &&
        /^\s*<svg(?:\s|>)/iu.test(svg) &&
        !ACTIVE_SVG_CONTENT.test(svg)
      ) {
        return value
      }
    } catch {
      return null
    }
    return null
  }
  if (/^ipfs:\/\//i.test(value)) {
    return appIpfsUrl(value)
  }

  // Keep supporting the bare CIDs accepted historically, but reject another
  // explicit scheme (javascript:, data:text/html, blob:, and so on).
  if (!/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('//')) {
    return appIpfsUrl(value)
  }
  return null
}
