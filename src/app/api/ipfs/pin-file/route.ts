import { NextRequest, NextResponse } from 'next/server'
import { pinToIpfs } from '@/lib/ipfs-server'

export const runtime = 'nodejs'

/** Logos only: small images. Anything bigger belongs somewhere else. */
const MAX_BYTES = 1024 * 1024

const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/avif',
])

export async function POST(req: NextRequest) {
  // Cheap early reject before buffering the body.
  const declaredLength = Number(req.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_BYTES * 1.05) {
    return NextResponse.json({ error: 'File too large (max 1MB)' }, { status: 413 })
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
  if (file.size === 0 || file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File must be 1 byte – 1MB' }, { status: 413 })
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: 'Only image uploads are allowed' }, { status: 415 })
  }

  try {
    const cid = await pinToIpfs(file, 'logo')
    return NextResponse.json({ cid })
  } catch {
    return NextResponse.json({ error: 'Failed to pin file' }, { status: 502 })
  }
}
