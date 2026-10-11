import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
const identity = vi.hoisted(() => ({ result: { isSuccess: true, isError: false, data: null as null | { protocol: string }, refetch: vi.fn() } }))
vi.mock('@/hooks/useProjectNftProtocol', () => ({ useProjectNftProtocol: () => identity.result }))
import { ProjectFlavor } from '@/components/project/ProjectFlavor'
describe('verified project flavor', () => {
  it('labels native protocol as Defifa and preserves ordinary Project and Revnet', () => {
    identity.result.data = { protocol: 'defifa' }
    expect(renderToStaticMarkup(<ProjectFlavor chainId={1} projectId={1} isRevnet={false} />)).toBe('Defifa')
    identity.result.data = { protocol: 'jb721' }
    expect(renderToStaticMarkup(<ProjectFlavor chainId={1} projectId={1} isRevnet={false} />)).toBe('Project')
    identity.result.data = null
    expect(renderToStaticMarkup(<ProjectFlavor chainId={1} projectId={1} isRevnet />)).toBe('Revnet')
  })
  it('keeps unread identity unknown with retry rather than guessing native or ordinary flavor', () => {
    identity.result.isSuccess = false; identity.result.isError = true
    expect(renderToStaticMarkup(<ProjectFlavor chainId={1} projectId={1} isRevnet={false} />)).toContain('Unavailable. Retry')
  })
})
