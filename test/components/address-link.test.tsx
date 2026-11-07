// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { AddressLink } from '@/components/ui/AddressLink'

vi.mock('@/hooks/useEnsName', () => ({ useEnsName: () => ({ data: null }) }))
vi.mock('@/components/SafeBadge', () => ({ SafeBadge: () => null }))

const ADDRESS = '0x1111111111111111111111111111111111111111'
async function hrefOf(element: React.ReactElement) {
  const host = document.createElement('div')
  await act(async () => { createRoot(host).render(element) })
  return host.querySelector('a')?.getAttribute('href')
}

it('opens the account page in the app, whatever the chain', async () => {
  expect(await hrefOf(<AddressLink address={ADDRESS} />)).toBe(`/account/${ADDRESS}`)
  expect(await hrefOf(<AddressLink address={ADDRESS} chainId={1} />)).toBe(`/account/${ADDRESS}`)
})

it('keeps the block explorer for a contract', async () => {
  expect(await hrefOf(<AddressLink explorer address={ADDRESS} chainId={1} />)).toContain(`etherscan.io/address/${ADDRESS}`)
})
