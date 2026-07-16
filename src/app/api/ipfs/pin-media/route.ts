import { NextRequest, NextResponse } from 'next/server'
import { pinToIpfs } from '@/lib/ipfs-server'

export const runtime = 'nodejs'

/** Store-item media: any common media type, larger cap than logos. */
const MAX_BYTES = 25 * 1024 * 1024

function typeAllowed(type: string): boolean {
  return (
    type.startsWith('image/') ||
    type.startsWith('video/') ||
    type.startsWith('audio/') ||
    type === 'application/pdf' ||
    type === 'text/plain'
  )
}

export async function POST(req: NextRequest) {
  const declaredLength = Number(req.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_BYTES * 1.05) {
    return NextResponse.json({ error: 'File too large (max 25MB)' }, { status: 413 })
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
    return NextResponse.json({ error: 'File must be 1 byte – 25MB' }, { status: 413 })
  }
  if (!typeAllowed(file.type)) {
    return NextResponse.json(
      { error: 'Images, video, audio, PDF, or plain text only' },
      { status: 415 },
    )
  }

  try {
    const cid = await pinToIpfs(file, 'media')
    return NextResponse.json({ cid })
  } catch {
    return NextResponse.json({ error: 'Failed to pin media' }, { status: 502 })
  }
}
