import { NextRequest, NextResponse } from 'next/server'
import { pinToIpfs } from '@/lib/ipfs-server'

export const runtime = 'nodejs'

/**
 * Pin a project-metadata JSON. Fields are whitelisted and length-capped, so
 * the pinned object is always small and exactly the shape project pages
 * expect: { name, projectTagline?, description?, logoUri? }.
 */
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected a JSON object' }, { status: 400 })
  }

  const { name, projectTagline, description, logoUri } = body as Record<
    string,
    unknown
  >

  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    return NextResponse.json(
      { error: 'name is required (1–100 characters)' },
      { status: 400 },
    )
  }

  const metadata: Record<string, string> = { name: name.trim() }

  if (projectTagline !== undefined) {
    if (typeof projectTagline !== 'string' || projectTagline.length > 200) {
      return NextResponse.json({ error: 'Invalid projectTagline' }, { status: 400 })
    }
    if (projectTagline.trim()) metadata.projectTagline = projectTagline.trim()
  }
  if (description !== undefined) {
    if (typeof description !== 'string' || description.length > 5000) {
      return NextResponse.json({ error: 'Invalid description' }, { status: 400 })
    }
    if (description.trim()) metadata.description = description.trim()
  }
  if (logoUri !== undefined) {
    if (
      typeof logoUri !== 'string' ||
      !/^ipfs:\/\/[a-zA-Z0-9]{1,128}$/.test(logoUri)
    ) {
      return NextResponse.json({ error: 'Invalid logoUri' }, { status: 400 })
    }
    metadata.logoUri = logoUri
  }

  try {
    const cid = await pinToIpfs(JSON.stringify(metadata), 'metadata.json')
    return NextResponse.json({ cid })
  } catch {
    return NextResponse.json({ error: 'Failed to pin metadata' }, { status: 502 })
  }
}
