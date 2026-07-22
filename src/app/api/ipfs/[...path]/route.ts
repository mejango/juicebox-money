import { NextRequest } from 'next/server'
import { isIpfsCid } from '@/lib/ipfs-cid'

const IPFS_GATEWAY = 'https://jbm.infura-ipfs.io/ipfs'
const MAX_PROXY_BYTES = 25 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 15_000
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]{1,128}$/

const SAFE_RESPONSE_HEADERS = {
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
}

function safePath(parts: string[]): string | null {
  if (parts.length < 1 || parts.length > 8) return null
  if (!isIpfsCid(parts[0])) return null
  if (
    parts
      .slice(1)
      .some(part => part === '.' || part === '..' || !SAFE_SEGMENT.test(part))
  ) {
    return null
  }
  const path = parts.map(encodeURIComponent).join('/')
  return path.length <= 512 ? path : null
}

function downloadOnlyContent(type: string): boolean {
  // Never expose executable, document, or style content under the app's
  // origin. JSON stays fetchable for tier metadata; scripts/styles/WASM and
  // navigable documents are downloads even if an upstream labels them as
  // executable. SVG remains renderable as an image and is sandboxed when
  // navigated directly by the response CSP.
  return /^(?:text\/(?:html|xml|css|javascript|ecmascript)|application\/(?:xhtml\+xml|xml|javascript|ecmascript|pdf|wasm))/i.test(
    type,
  )
}

/**
 * Same-origin IPFS asset cache. Tier media resolves to dozens of cold gateway
 * URLs at once and the upstream gateway throttles parallel browser fetches;
 * fronting it here lets the content — immutable by construction (CIDs) — be
 * cached by the browser and a bounded CDN in front of the app. The origin does
 * not persist attacker-selected CID keys in Next's data cache.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const path = safePath((await params).path)
  if (!path) {
    return Response.json(
      { error: 'Invalid IPFS path' },
      { status: 400, headers: SAFE_RESPONSE_HEADERS },
    )
  }

  let upstream: Response
  try {
    upstream = await fetch(`${IPFS_GATEWAY}/${path}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    return Response.json(
      { error: 'IPFS gateway timed out' },
      { status: 504, headers: SAFE_RESPONSE_HEADERS },
    )
  }

  if (!upstream.ok) {
    return new Response(null, {
      status: upstream.status,
      headers: SAFE_RESPONSE_HEADERS,
    })
  }

  const declaredLength = Number(upstream.headers.get('content-length') ?? 0)
  if (!Number.isFinite(declaredLength) || declaredLength < 0) {
    return Response.json(
      { error: 'Invalid IPFS response' },
      { status: 502, headers: SAFE_RESPONSE_HEADERS },
    )
  }
  if (declaredLength > MAX_PROXY_BYTES) {
    return Response.json(
      { error: 'IPFS asset too large' },
      { status: 413, headers: SAFE_RESPONSE_HEADERS },
    )
  }

  const upstreamType =
    upstream.headers.get('content-type') ?? 'application/octet-stream'
  const forceDownload = downloadOnlyContent(upstreamType)
  const type = forceDownload
    ? 'application/octet-stream'
    : upstreamType
  let streamedBytes = 0
  const body = upstream.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        streamedBytes += chunk.byteLength
        if (streamedBytes > MAX_PROXY_BYTES) {
          controller.error(new Error('IPFS asset exceeds proxy limit'))
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )

  return new Response(body, {
    status: 200,
    headers: {
      ...SAFE_RESPONSE_HEADERS,
      'content-type': type,
      'cache-control': 'public, max-age=31536000, immutable',
      ...(forceDownload
        ? { 'content-disposition': 'attachment; filename="ipfs-asset"' }
        : {}),
      ...(declaredLength > 0
        ? { 'content-length': String(declaredLength) }
        : {}),
    },
  })
}
