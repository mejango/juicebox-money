/**
 * Server-side redundant IPFS pinning. Filebase creates and retains the
 * canonical DAG-PB CID, then Pinata pins that exact CID. Credentials never
 * reach the client.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { isIpfsCid } from '@/lib/ipfs-cid'

const FILEBASE_IPFS_API_BASE = 'https://rpc.filebase.io'
const PINATA_PIN_BY_CID_URL =
  'https://api.pinata.cloud/v3/files/public/pin_by_cid'
const IPFS_REQUEST_TIMEOUT_MS = 20_000
export const PINNING_INGRESS_HEADER = 'x-juicebox-pinning-ingress-token'

function pinningConfigured(): boolean {
  return (
    process.env.IPFS_PINNING_ENABLED === 'true' &&
    process.env.IPFS_PINNING_EDGE_PROTECTED === 'true' &&
    (process.env.IPFS_PINNING_INGRESS_TOKEN?.trim().length ?? 0) >= 32 &&
    !!process.env.FILEBASE_IPFS_RPC_TOKEN &&
    !!process.env.PINATA_JWT
  )
}

function hasValidIngressToken(req: NextRequest): boolean {
  const expected = process.env.IPFS_PINNING_INGRESS_TOKEN
  const supplied = req.headers.get(PINNING_INGRESS_HEADER)
  if (!expected || !supplied) return false

  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(expected), digest(supplied))
}

/**
 * Public, credential-backed pinning must be an explicit deployment decision.
 * The ingress must strip the private header from untrusted requests, enforce
 * its caller/quota policy, then inject the shared token. Browser Origin
 * headers and the edge-protection acknowledgement are not authorization.
 */
export function requirePinningAccess(req: NextRequest): NextResponse | null {
  if (!pinningConfigured()) {
    return NextResponse.json(
      { error: 'IPFS pinning is unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    )
  }
  if (!hasValidIngressToken(req)) {
    return NextResponse.json(
      { error: 'IPFS pinning ingress is not authorized' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    )
  }
  return null
}

export async function readLimitedJson(
  req: NextRequest,
  maxBytes: number,
): Promise<{ value: unknown } | { response: NextResponse }> {
  const declaredLength = Number(req.headers.get('content-length') ?? 0)
  if (!Number.isFinite(declaredLength) || declaredLength < 0) {
    return {
      response: NextResponse.json(
        { error: 'Invalid content length' },
        { status: 400 },
      ),
    }
  }
  if (declaredLength > maxBytes) {
    return {
      response: NextResponse.json(
        { error: 'JSON body too large' },
        { status: 413 },
      ),
    }
  }

  const reader = req.body?.getReader()
  if (!reader) {
    return {
      response: NextResponse.json(
        { error: 'Expected a JSON body' },
        { status: 400 },
      ),
    }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return {
        response: NextResponse.json(
          { error: 'JSON body too large' },
          { status: 413 },
        ),
      }
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return {
      response: NextResponse.json(
        { error: 'Expected a JSON body' },
        { status: 400 },
      ),
    }
  }
}

export async function pinToIpfs(
  content: Blob | string,
  filename = 'file',
): Promise<string> {
  if (!pinningConfigured()) throw new Error('IPFS pinning is unavailable')
  const filebaseToken = process.env.FILEBASE_IPFS_RPC_TOKEN
  const pinataJwt = process.env.PINATA_JWT
  if (!filebaseToken || !pinataJwt) {
    throw new Error('IPFS pinning is not configured')
  }

  const form = new FormData()
  form.append(
    'file',
    typeof content === 'string'
      ? new Blob([content], { type: 'application/json' })
      : content,
    filename,
  )

  const filebaseResponse = await fetch(
    `${FILEBASE_IPFS_API_BASE}/api/v0/add?pin=true&cid-version=0`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${filebaseToken}` },
      body: form,
      signal: AbortSignal.timeout(IPFS_REQUEST_TIMEOUT_MS),
    },
  )
  if (!filebaseResponse.ok) {
    throw new Error(`Filebase IPFS add failed: ${filebaseResponse.status}`)
  }

  const filebaseResult = (await filebaseResponse.json()) as { Hash?: string }
  if (!filebaseResult.Hash || !isIpfsCid(filebaseResult.Hash)) {
    throw new Error('Filebase IPFS add returned an invalid CID')
  }

  const cid = filebaseResult.Hash
  const pinataResponse = await fetch(PINATA_PIN_BY_CID_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pinataJwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cid, name: filename }),
    signal: AbortSignal.timeout(IPFS_REQUEST_TIMEOUT_MS),
  })
  if (!pinataResponse.ok) {
    throw new Error(`Pinata replication failed: ${pinataResponse.status}`)
  }

  const pinataResult = (await pinataResponse.json()) as {
    data?: { cid?: string }
  }
  if (pinataResult.data?.cid !== cid) {
    throw new Error('Pinata replication returned a mismatched CID')
  }
  return cid
}

/**
 * A POST handler that pins one multipart file upload, shared by pin-file and
 * pin-media. `label` names the upload in error messages; `filename` is the
 * name pinned to IPFS.
 */
export function makePinFileHandler({
  maxBytes,
  typeAllowed,
  typeError,
  filename,
  label,
}: {
  maxBytes: number
  typeAllowed: (type: string, name: string) => boolean
  typeError: string
  filename: string
  label: string
}) {
  const sizeLabel = `${maxBytes / (1024 * 1024)}MB`

  return async function POST(req: NextRequest) {
    const unavailable = requirePinningAccess(req)
    if (unavailable) return unavailable

    // Cheap early reject before buffering the body.
    const rawLength = req.headers.get('content-length')
    const declaredLength = Number(rawLength)
    if (
      !rawLength ||
      !Number.isSafeInteger(declaredLength) ||
      declaredLength <= 0
    ) {
      return NextResponse.json(
        { error: 'A valid Content-Length header is required' },
        { status: 411 },
      )
    }
    // formData() buffers before the Blob size can be checked. Requiring and
    // bounding the envelope closes the chunked/lying-length memory-DoS path;
    // the edge must also reject requests whose received bytes exceed it.
    if (declaredLength > maxBytes + 256 * 1024) {
      return NextResponse.json(
        { error: `File too large (max ${sizeLabel})` },
        { status: 413 },
      )
    }

    let form: FormData
    try {
      form = await req.formData()
    } catch {
      return NextResponse.json({ error: 'Expected multipart form data' }, { status: 400 })
    }

    const file = form.get('file')
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'Missing file field' }, { status: 400 })
    }
    if (file.size === 0 || file.size > maxBytes) {
      return NextResponse.json(
        { error: `File must be 1 byte – ${sizeLabel}` },
        { status: 413 },
      )
    }
    const fileName = 'name' in file && typeof file.name === 'string' ? file.name : ''
    if (!typeAllowed(file.type, fileName)) {
      return NextResponse.json({ error: typeError }, { status: 415 })
    }

    try {
      const cid = await pinToIpfs(file, filename)
      return NextResponse.json({ cid })
    } catch {
      return NextResponse.json({ error: `Failed to pin ${label}` }, { status: 502 })
    }
  }
}

/**
 * Validate one optional length-capped string field for the pin-json/pin-item
 * metadata routes, assigning its trimmed value when present. Returns the 400
 * response on invalid input, or null when the field is fine (absent, or
 * consumed into `metadata`).
 */
export function takeString(
  metadata: Record<string, string>,
  key: string,
  value: unknown,
  max: number,
): NextResponse | null {
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length > max) {
    return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 })
  }
  if (value.trim()) metadata[key] = value.trim()
  return null
}
