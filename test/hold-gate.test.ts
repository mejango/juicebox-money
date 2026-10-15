import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appHoldLogic } from '../scripts/app-hold-logic.mjs'

const root = new URL('../', import.meta.url)
function sourceFiles(dir: string): string[] {
  return readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
  })
}

describe('held writes and saved-attempt recovery have one owner: the SDK', () => {
  it('leaves no app-local hold or recovery logic, storage key access or copied SDK line in src', () => {
    const found = sourceFiles('src').flatMap(path => appHoldLogic(path, readFileSync(new URL(path, root), 'utf8')))
    expect(found).toEqual([])
  })

  it.each([
    ['an app send loop', 'export async function sendUnderHold() {}'],
    ['an app copy of an SDK helper', 'const hidesShownExit = () => false'],
    ['app saved-attempt recovery', 'await recoverSavedLaunch(hold, client, saved)'],
    ['an app hold watcher', "import { useWriteHoldWatch } from '@/hooks/useWriteHoldWatch'"],
    ['an app-made held-write view', 'const view = createHeldWriteView(handle, { client })'],
    ['the SDK storage keys', "localStorage.getItem('nana-sdk:reviewed-write:1')"],
    ['a copied SDK line', "const line = 'I checked my wallet. Send again'"],
    ['a copied went-through gate', "throw new Error('Your earlier transaction went through.')"],
  ])('fails on %s', (_what, source) => {
    expect(appHoldLogic('src/example.ts', source)).not.toEqual([])
  })

  it('every SDK-owned recovery surface uses useSavedAttempt through the one display component', () => {
    const recovery = readFileSync(new URL('src/components/ui/SavedAttemptRecovery.tsx', root), 'utf8')
    expect(recovery).toContain('useSavedAttempt(')
    expect(recovery).toContain('useHeldWrite(')
    const engine = readFileSync(new URL('src/hooks/useSafeTx.ts', root), 'utf8')
    expect(engine).toContain('useHeldSend(')
  })
})
