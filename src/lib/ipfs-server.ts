/**
 * Server-side Infura IPFS pinning. Credentials never reach the client — the
 * pin routes call through here. Same auth + endpoint mechanics as the classic
 * juicebox.money site.
 */

import { NextRequest, NextResponse } from 'next/server'

const INFURA_IPFS_API_BASE = 'https://ipfs.infura.io:5001'

export async function pinToIpfs(
  content: Blob | string,
  filename = 'file',
): Promise<string> {
  const projectId = process.env.INFURA_IPFS_PROJECT_ID
  const secret = process.env.INFURA_IPFS_API_SECRET
  if (!projectId || !secret) {
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

  const res = await fetch(`${INFURA_IPFS_API_BASE}/api/v0/add?pin=true`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${projectId}:${secret}`).toString('base64')}`,
    },
    body: form,
  })
  if (!res.ok) throw new Error(`ipfs add failed: ${res.status}`)

  const json = (await res.json()) as { Hash?: string }
  if (!json.Hash) throw new Error('ipfs add returned no hash')
  return json.Hash
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
    // Cheap early reject before buffering the body.
    const declaredLength = Number(req.headers.get('content-length') ?? 0)
    if (declaredLength > maxBytes * 1.05) {
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
