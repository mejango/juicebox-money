import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// The browser's own arrow sits flush against a select's edge. Every select draws the shared caret
// (`select-caret`) or is an invisible overlay over its own drawn control.
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.tsx') ? [join(dir, entry.name)] : [],
  )
}

it('no select shows the browser default arrow', () => {
  const bare: string[] = []
  for (const path of sources('src')) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/<select\b[\s\S]*?\n?[^=]>/g)) {
      const tag = match[0]
      if (/select-caret|appearance-none|opacity-0|className=\{/.test(tag)) continue
      bare.push(`${path}:${source.slice(0, match.index).split('\n').length}`)
    }
  }
  expect(bare).toEqual([])
})
