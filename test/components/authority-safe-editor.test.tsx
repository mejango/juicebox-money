// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthoritySafeEditor } from '@/components/create/AuthoritySafeEditor'

const SIGNERS = [
  '0x52908400098527886e0F7030069857d2E4169eE7',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function Host({
  initialOwners = ['', '', ''],
  initialThreshold = 2,
  role = 'owner',
  disabled = false,
}: {
  initialOwners?: string[]
  initialThreshold?: number
  role?: 'owner' | 'operator'
  disabled?: boolean
}) {
  const [owners, setOwners] = useState(initialOwners)
  const [threshold, setThreshold] = useState(initialThreshold)
  return (
    <AuthoritySafeEditor
      role={role}
      owners={owners}
      threshold={threshold}
      onOwnersChange={setOwners}
      onThresholdChange={setThreshold}
      disabled={disabled}
    />
  )
}

function inputs() {
  return [...container.querySelectorAll<HTMLInputElement>('input')]
}

function policy() {
  return container.querySelector<HTMLSelectElement>('select')!
}

function click(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    element => element.getAttribute('aria-label') === label || element.textContent === label,
  )
  expect(button).toBeDefined()
  act(() => button!.click())
}

function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLInputElement
    ? HTMLInputElement.prototype
    : HTMLSelectElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('AuthoritySafeEditor', () => {
  it('labels signer fields accessibly without visible numbered headings and starts with no errors', () => {
    act(() => root.render(<Host />))

    expect(inputs().map(input => input.getAttribute('aria-label'))).toEqual([
      'Owner signer 1', 'Owner signer 2', 'Owner signer 3',
    ])
    expect(container.textContent).not.toContain('Owner 1')
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull()
    expect(policy().value).toBe('2')
    expect([...policy().options].map(option => option.textContent)).toEqual([
      '1 of 3', '2 of 3', '3 of 3',
    ])
    expect(policy().labels?.[0]?.textContent).toBe('Approval policy')
  })

  it('keeps the remaining signers and a possible approval policy when removing a signer', () => {
    act(() => root.render(<Host initialOwners={SIGNERS} initialThreshold={3} />))

    click('Remove owner signer 2')

    expect(inputs().map(input => input.value)).toEqual([SIGNERS[0], SIGNERS[2]])
    expect(policy().value).toBe('2')
    expect([...policy().options].map(option => option.textContent)).toEqual(['1 of 2', '2 of 2'])
    click('Remove owner signer 1')
    expect(inputs()).toHaveLength(2)
  })

  it('adds a blank signer without changing the selected approval count', () => {
    act(() => root.render(<Host initialOwners={SIGNERS} />))

    click('+ Add signer')
    change(policy(), '3')

    expect(inputs().map(input => input.value)).toEqual([...SIGNERS, ''])
    expect(policy().value).toBe('3')
    expect(policy().selectedOptions[0].textContent).toBe('3 of 4')
  })

  it('caps signer additions at twenty', () => {
    act(() => root.render(<Host initialOwners={Array.from({ length: 19 }, () => '')} />))

    click('+ Add signer')
    click('+ Add signer')

    expect(inputs()).toHaveLength(20)
    expect(container.querySelectorAll('button:disabled')).toHaveLength(1)
  })

  it.each([0, 4, 1.5])('requires choosing a policy when the imported threshold %s is invalid', initialThreshold => {
    act(() => root.render(<Host initialThreshold={initialThreshold} />))

    expect(policy().selectedOptions[0].textContent).toBe('Choose policy')
    expect(policy().getAttribute('aria-invalid')).toBe('true')

    change(policy(), '2')
    expect(policy().selectedOptions[0].textContent).toBe('2 of 3')
    expect(policy().getAttribute('aria-invalid')).toBe('false')
  })

  it('accepts normalized mixed-case addresses and identifies duplicate signers regardless of casing', () => {
    act(() => root.render(<Host initialOwners={SIGNERS} role="operator" />))
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull()

    change(inputs()[1], `  ${SIGNERS[0].toLowerCase()}  `)

    expect(inputs()[1].value).toBe(SIGNERS[0].toLowerCase())
    expect(inputs().map(input => input.getAttribute('aria-invalid'))).toEqual(['true', 'true', 'false'])
    const describedBy = inputs()[1].getAttribute('aria-describedby')!
    expect(document.getElementById(describedBy)?.textContent).toBe('Each signer must have a different address.')
    expect(policy().getAttribute('aria-label')).toBe('Operator approval policy')

    change(inputs()[1], SIGNERS[1])
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull()
  })

  it('rejects malformed, zero, and reserved signer addresses and clears empty-field errors', () => {
    act(() => root.render(<Host initialOwners={[
      'not an address',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000001',
    ]} />))

    expect(container.querySelectorAll('[aria-invalid="true"]')).toHaveLength(3)
    expect(container.textContent).toContain('Zero and reserved addresses cannot sign.')
    change(inputs()[0], '')
    expect(inputs()[0].getAttribute('aria-describedby')).toBeNull()
    expect(container.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2)
  })

  it('disables every editing control while launch is busy', () => {
    const onOwnersChange = vi.fn()
    const onThresholdChange = vi.fn()
    act(() => root.render(
      <AuthoritySafeEditor
        role="owner"
        owners={SIGNERS}
        threshold={2}
        onOwnersChange={onOwnersChange}
        onThresholdChange={onThresholdChange}
        disabled
      />,
    ))

    expect([...container.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select')]
      .every(element => element.disabled)).toBe(true)
    click('Remove owner signer 1')
    click('+ Add signer')
    expect(onOwnersChange).not.toHaveBeenCalled()
    expect(onThresholdChange).not.toHaveBeenCalled()
  })
})
