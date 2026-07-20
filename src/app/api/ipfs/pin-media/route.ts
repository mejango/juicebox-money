import { makePinFileHandler } from '@/lib/ipfs-server'

export const runtime = 'nodejs'

/** Store-item media: any common media type, larger cap than logos. */
export const POST = makePinFileHandler({
  maxBytes: 25 * 1024 * 1024,
  typeAllowed: (type, name) =>
    type.startsWith('image/') ||
    type.startsWith('video/') ||
    type.startsWith('audio/') ||
    type === 'application/pdf' ||
    type.startsWith('text/') ||
    /\.(md|markdown|txt)$/i.test(name),
  typeError: 'Images, video, audio, PDF, or text only',
  filename: 'media',
  label: 'media',
})
