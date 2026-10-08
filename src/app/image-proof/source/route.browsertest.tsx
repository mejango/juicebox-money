import sharp from 'sharp'
import { animatedAvifBase64 } from '../../../../test/fixtures/image-optimizer-animated'

// Deterministic-browser-only originals for real Next optimizer integration.
// No arbitrary source/dimensions; pageExtensions excludes this route on release.
export async function GET(request: Request) {
  const kind = new URL(request.url).searchParams.get('kind') ?? 'raster'
  if (kind === 'avif' || kind === 'avis') {
    const bytes = Buffer.from(animatedAvifBase64, 'base64')
    if (kind === 'avis') bytes.write('avis', 8, 'ascii')
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/avif' } })
  }
  if (!['raster', 'panorama', 'alpha', 'svg', 'gif'].includes(kind)) {
    return new Response('Unknown fixture', { status: 404 })
  }
  if (kind === 'gif') {
    const bytes = Buffer.alloc(32 * 64 * 3)
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const offset = (y * 32 + x) * 3
        bytes[offset + (y < 32 ? 0 : 1)] = 255
      }
    }
    const body = await sharp(bytes, { raw: { width: 32, height: 64, channels: 3, pageHeight: 32 } }).gif({ delay: [200, 200], loop: 0 }).toBuffer()
    return new Response(new Uint8Array(body), { headers: { 'Content-Type': 'image/gif' } })
  }
  const size = kind === 'alpha' || kind === 'svg' ? 1024 : 4096
  const height = kind === 'panorama' ? 512 : kind === 'raster' ? 2048 : size
  const nested = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#e72666' } }).png().toBuffer()
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${height}"><style>.tile{fill:#4bc0a5}.mark{fill:#e72666}</style>${kind === 'alpha' ? '' : `<rect class="tile" width="${size}" height="${height}"/>`}<circle class="mark" cx="${size / 2}" cy="${height / 2}" r="${height / 3}"/><path d="M${size / 2 - 60} ${height / 2 - 120}v240m120-240v240" stroke="white" stroke-width="12"/><image href="data:image/png;base64,${nested.toString('base64')}" x="${size / 8}" y="${height / 8}" width="${size / 8}" height="${height / 8}"/><script>globalThis.__imageScriptRan=true</script></svg>`
  const body = kind === 'svg' ? Buffer.from(svg) : await sharp(Buffer.from(svg)).png().toBuffer()
  return new Response(new Uint8Array(body), { headers: { 'Content-Type': kind === 'svg' ? 'image/svg+xml' : 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } })
}
