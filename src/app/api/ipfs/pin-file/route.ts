import { makePinFileHandler } from '@/lib/ipfs-server'

export const runtime = 'nodejs'

/** Logos only: small images. Anything bigger belongs somewhere else. */
const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/avif',
])

export const POST = makePinFileHandler({
  maxBytes: 1024 * 1024,
  typeAllowed: type => ALLOWED_TYPES.has(type),
  typeError: 'Only image uploads are allowed',
  filename: 'logo',
  label: 'file',
})
