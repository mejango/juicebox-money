import { NextRequest, NextResponse } from 'next/server'
import { pinToIpfs, takeString } from '@/lib/ipfs-server'

export const runtime = 'nodejs'

/**
 * Pin a project-metadata JSON. Fields are whitelisted and length-capped, so
 * the pinned object is always small and exactly the shape project pages
 * expect: { name, projectTagline?, description?, logoUri?, infoUri?,
 * twitter?, discord? }. The link fields exist so owner edits can carry a
 * project's existing links forward instead of dropping them.
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

  const {
    name,
    projectTagline,
    description,
    logoUri,
    coverImageUri,
    payDisclosure,
    tags,
    infoUri,
    twitter,
    discord,
    telegram,
    whatsapp,
    instagram,
  } = body as Record<string, unknown>

  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    return NextResponse.json(
      { error: 'name is required (1–100 characters)' },
      { status: 400 },
    )
  }

  const metadata: Record<string, string> = { name: name.trim() }

  const invalidTagline = takeString(metadata, 'projectTagline', projectTagline, 200)
  if (invalidTagline) return invalidTagline
  const invalidDescription = takeString(metadata, 'description', description, 5000)
  if (invalidDescription) return invalidDescription
  for (const [key, value] of [
    ['logoUri', logoUri],
    ['coverImageUri', coverImageUri],
  ] as const) {
    if (value === undefined) continue
    if (
      typeof value !== 'string' ||
      !/^ipfs:\/\/[a-zA-Z0-9]{1,128}$/.test(value)
    ) {
      return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 })
    }
    metadata[key] = value
  }

  if (tags !== undefined) {
    if (
      !Array.isArray(tags) ||
      tags.length > 3 ||
      tags.some(t => typeof t !== 'string' || t.length > 30)
    ) {
      return NextResponse.json({ error: 'Invalid tags' }, { status: 400 })
    }
    if (tags.length > 0)
      (metadata as Record<string, unknown>).tags = tags
  }

  const invalidDisclosure = takeString(metadata, 'payDisclosure', payDisclosure, 1000)
  if (invalidDisclosure) return invalidDisclosure

  // Plain length-capped strings; project pages sanitize on render
  // (https-only URLs, handle-shaped twitter/instagram).
  const links: [string, unknown, number][] = [
    ['infoUri', infoUri, 300],
    ['twitter', twitter, 100],
    ['discord', discord, 300],
    ['telegram', telegram, 300],
    ['whatsapp', whatsapp, 300],
    ['instagram', instagram, 100],
  ]
  for (const [key, value, max] of links) {
    const invalid = takeString(metadata, key, value, max)
    if (invalid) return invalid
  }

  try {
    const cid = await pinToIpfs(JSON.stringify(metadata), 'metadata.json')
    return NextResponse.json({ cid })
  } catch {
    return NextResponse.json({ error: 'Failed to pin metadata' }, { status: 502 })
  }
}
