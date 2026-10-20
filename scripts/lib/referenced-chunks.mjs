/**
 * A chunk URL as its path under the dist directory. Next appends the deployment
 * id (`?dpl=…`) to chunk URLs; that suffix is not part of the emitted file.
 * Decode only after removing it, so encoded filename characters stay part of
 * the path.
 */
function chunkPath(url) {
  const path = decodeURIComponent(url.split(/[?#]/u, 1)[0]).replace(/^\/_next\//u, '')
  if (!path.endsWith('.js') || path.split('/').includes('..')) {
    throw new Error(`A page references an unexpected client asset: ${url}`)
  }
  return path
}

const FLIGHT = /<script>self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/gu
const CHUNK = /(?:\/_next\/)?static\/chunks\/[^"'\s<>\\]+?\.js(?:[?#][^"'\s<>\\]*)?/gu

/**
 * The client chunks a page loads up front: every `static/chunks/*.js` its HTML
 * names in script and preload tags, and every one its RSC payload names. The
 * payload streams in pieces that can split a filename, so they are decoded
 * and joined before reading. `nomodule` tags (polyfills, which modern
 * browsers skip) are dropped, not their files: a chunk a nomodule tag names
 * still counts when anything else references it.
 */
export function referencedChunks(html) {
  const flight = [...html.matchAll(FLIGHT)]
    .map(([, record]) => {
      const [kind, data] = JSON.parse(record)
      return kind === 1 && typeof data === 'string' ? data : ''
    })
    .join('')
  const markup = html.replace(FLIGHT, '').replace(/<script\b[^>]*\bnomodule\b[^>]*>/giu, '')
  return [
    ...new Set([...`${markup}\n${flight}`.matchAll(CHUNK)].map(([reference]) => chunkPath(reference))),
  ]
}
