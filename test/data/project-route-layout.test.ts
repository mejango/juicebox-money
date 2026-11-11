import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectRouteLayout from '@/app/[urn]/layout'

const render = (urn: string) =>
  ProjectRouteLayout({ children: 'page', params: Promise.resolve({ urn }) })

describe('project route layout', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lets chain:id and @handle routes through to the page', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const urn of ['basesep:1', 'eth%3A1', '@rev', '%40rev', '@name.eth']) {
      expect(await render(urn), urn).toBe('page')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 404 before streaming for a slug that cannot name a project', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    for (const urn of ['learn.md', 'build.md', 'llms-full.txt', 'nochain:1', 'base:0', '%E0%A4%A']) {
      await expect(render(urn), urn).rejects.toMatchObject({ digest: expect.stringContaining('404') })
    }
  })

  it('still hands a page the legacy site serves over to it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
    await expect(render('old.page')).rejects.toMatchObject({
      digest: expect.stringContaining('https://old.juicebox.money/old.page'),
    })
  })
})
