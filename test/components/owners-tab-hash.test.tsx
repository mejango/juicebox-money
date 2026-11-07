import type { ReactNode } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/sucker-group', () => ({
  useLinkedDeployments: (home: [number, number]) => ({ deployments: [home], line: null, pending: false }),
}))
vi.mock('@/components/project/TokenPanel', () => ({ TokenPanel: () => null }))
vi.mock('@/components/project/Tabs', () => ({
  SubTabs: ({ hashParent }: { hashParent: string; tabs: { content: ReactNode }[] }) => <span>{hashParent}</span>,
}))

import { OwnersTab } from '@/components/project/OwnersTab'

const hashParent = async (isRevnet: boolean) => {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      <OwnersTab chainId={1} projectId={3} isRevnet={isRevnet} suckerGroupId={null} chains={[[1, 3]]} />,
    )
  })
  const text = JSON.stringify(renderer.toJSON())
  await act(async () => renderer.unmount())
  return text
}

describe('the Owners or Tokens tab hash', () => {
  it('names the tab the project shows, so a subtab stays under it', async () => {
    expect(await hashParent(true)).toContain('owners')
    expect(await hashParent(false)).toContain('tokens')
  })
})
