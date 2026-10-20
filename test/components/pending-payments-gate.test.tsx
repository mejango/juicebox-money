// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ connected: false }))
vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: mocks.connected }) }))
vi.mock('next/dynamic', () => ({
  default: () => (props: { projectId: number }) => <p data-panel>{`panel ${props.projectId}`}</p>,
}))

import { PendingPaymentsGate } from '@/components/project/PendingPaymentsGate'

const props = { chainId: 1 as const, projectId: 7, chains: [] as const }
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  mocks.connected = false
  localStorage.clear()
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(() => act(() => root.unmount()))
const render = () => act(() => root.render(<PendingPaymentsGate {...props} />))

it('mounts nothing for a signed-out visitor with nothing saved', () => {
  render()
  expect(host.querySelector('[data-panel]')).toBeNull()
})

it('mounts the panel for a connected wallet', () => {
  mocks.connected = true
  render()
  expect(host.textContent).toBe('panel 7')
})

it('mounts the panel without a wallet when this browser saved a batch, legacy ones included', () => {
  localStorage.setItem('jb-project-batch:v1:alias:route-pending-payments:1:7', 'saved')
  render()
  expect(host.textContent).toBe('panel 7')
  act(() => root.unmount())
  localStorage.clear()
  localStorage.setItem('jb-project-batch:v1:alias:route-destination-payments:1:7', 'saved')
  root = createRoot(host)
  render()
  expect(host.textContent).toBe('panel 7')
})

it('ignores other saved batch actions', () => {
  localStorage.setItem('jb-project-batch:v1:alias:route-other-action:1:7', 'saved')
  render()
  expect(host.querySelector('[data-panel]')).toBeNull()
})

it('keeps the panel mounted after the wallet disconnects', () => {
  mocks.connected = true
  render()
  mocks.connected = false
  render()
  expect(host.textContent).toBe('panel 7')
})
