// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { useChosen } from '@/hooks/useChosen'

async function mount() {
  let field!: ReturnType<typeof useChosen<string>>
  function Probe() {
    field = useChosen('', 'amount')
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
  return { get: () => field, root }
}

describe('a chosen value', () => {
  it('keys an untouched seed as auto, never its number', async () => {
    const { get, root } = await mount()
    await act(async () => get().fill('5'))
    expect(get().value).toBe('5')
    expect(get().key(5n)).toBe('auto:amount')
    await act(async () => get().fill('6'))
    expect(get().key(6n)).toBe('auto:amount')
    await act(async () => root.unmount())
  })

  it('keys a typed value by its value', async () => {
    const { get, root } = await mount()
    await act(async () => get().set('5'))
    expect(get().key(5n)).toBe(5n)
    await act(async () => root.unmount())
  })

  it('keys a policy by its name, through the app refilling it', async () => {
    const { get, root } = await mount()
    await act(async () => get().choose('max', '5'))
    expect(get().key(5n)).toBe('policy:max')
    // The balance moved: the app refills Max, still the user's choice of all.
    await act(async () => get().fill('6'))
    expect(get().value).toBe('6')
    expect(get().key(6n)).toBe('policy:max')
    await act(async () => root.unmount())
  })

  it('stops keying a typed value once the app overwrites it', async () => {
    const { get, root } = await mount()
    await act(async () => get().set('5'))
    await act(async () => get().fill('7'))
    expect(get().key(7n)).toBe('auto:amount')
    // A seed resets it, as a fresh form does.
    await act(async () => get().choose('max', '9'))
    await act(async () => get().seed(''))
    expect(get().key(0n)).toBe('auto:amount')
    await act(async () => root.unmount())
  })
})
