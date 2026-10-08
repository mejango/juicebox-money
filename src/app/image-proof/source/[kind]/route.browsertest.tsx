import sharp from 'sharp'
import { animatedAvifBase64 } from '../../../../../test/fixtures/image-optimizer-animated'

// A bounded, deterministic high-resolution source with gradients, fine texture
// and crisp marks. Reuse the bytes across candidate requests in this test server.
let bigCritical: Promise<Buffer> | undefined
function bigCriticalRaster() {
  return bigCritical ??= (async () => {
    const width = 4096
    const height = 2048
    const pixels = Buffer.alloc(width * height * 3)
    let seed = 0x13579bdf
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        const noise = (seed >>> 28) - 8
        const offset = (y * width + x) * 3
        const circle = (x - width * .57) ** 2 + (y - height * .5) ** 2 < (height * .34) ** 2
        const line = circle && Math.abs(x - width * .57) < 28 && Math.abs(y - height * .5) < height * .24
        pixels[offset] = line ? 255 : circle ? 218 + noise : 45 + x / width * 95 + noise
        pixels[offset + 1] = line ? 255 : circle ? 47 + noise : 155 + y / height * 55 + noise
        pixels[offset + 2] = line ? 255 : circle ? 111 + noise : 148 + x / width * 45 + noise
      }
    }
    return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer()
  })()
}

// Deterministic-browser-only originals for real Next optimizer integration.
// No arbitrary source/dimensions; pageExtensions excludes this route on release.
export async function GET(request: Request) {
  const match = new URL(request.url).pathname.split('/').at(-1)?.match(/^(raster|panorama|alpha|svg|gif|avif|avis|bigcritical)(?:-[0-9]+)?$/)
  const kind = match?.[1]
  if (!kind) return new Response('Unknown fixture', { status: 404 })
  if (kind === 'bigcritical') {
    return new Response(new Uint8Array(await bigCriticalRaster()), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } })
  }
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
