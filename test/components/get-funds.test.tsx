// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseUnits } from 'viem'
import { GetFunds } from '@/components/GetFunds'
import { ParaAuthContext } from '@/providers/ParaAuthContext'

const requestAddFunds = vi.fn()

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  requestAddFunds.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(node: ReactNode) {
  act(() =>
    root.render(
      <ParaAuthContext.Provider
        value={{
          modalOpen: false,
          sessionVersion: 0,
          requestSignIn: () => {},
          requestAddFunds,
        }}
      >
        {node}
      </ParaAuthContext.Provider>,
    ),
  )
}

function click() {
  const button = container.querySelector('button')
  act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('GetFunds', () => {
  it('offers only the amount the payer is short, not the whole payment', () => {
    render(
      <GetFunds
        symbol="ETH"
        chainId={8453}
        needed={parseUnits('1.5', 18)}
        balance={parseUnits('1.2', 18)}
        decimals={18}
      />,
    )

    // Buying 1.5 when 1.2 is already held would overcharge by 1.2 ETH.
    expect(container.textContent).toBe('Get 0.3 more ETH')
    click()
    expect(requestAddFunds).toHaveBeenCalledWith({
      asset: 'ETHEREUM',
      network: 'BASE',
      assetQuantity: '0.3',
    })
  })

  it('carries no amount when the balance already covers the payment', () => {
    render(
      <GetFunds
        symbol="USDC"
        chainId={1}
        needed={parseUnits('10', 6)}
        balance={parseUnits('25', 6)}
        decimals={6}
      />,
    )

    expect(container.textContent).toBe('Get USDC')
    click()
    expect(requestAddFunds).toHaveBeenCalledWith({
      asset: 'USDC',
      network: 'ETHEREUM',
      assetQuantity: undefined,
    })
  })

  it('drops the amount when the shortfall rounds below display precision', () => {
    render(
      <GetFunds
        symbol="ETH"
        chainId={10}
        needed={1n}
        balance={0n}
        decimals={18}
      />,
    )

    // A 1-wei shortfall trims to "0", and "Get 0 more ETH" is worse copy than
    // no amount at all — so it falls back rather than naming a zero.
    expect(container.textContent).toBe('Get ETH')
    click()
    expect(requestAddFunds).toHaveBeenCalledWith({
      asset: 'ETHEREUM',
      network: 'OPTIMISM',
      assetQuantity: undefined,
    })
  })

  it('renders nothing for a token or chain with no on-ramp route', () => {
    render(<GetFunds symbol="WETH" chainId={8453} />)
    expect(container.textContent).toBe('')

    render(<GetFunds symbol="ETH" chainId={84532} />)
    expect(container.textContent).toBe('')
  })
})
