// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { useChosen } from '@/hooks/useChosen'
import { decimalKey } from '@/lib/transaction-builders'

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
    expect(get().key()).toBe('auto:amount')
    await act(async () => get().fill('6'))
    expect(get().key()).toBe('auto:amount')
    await act(async () => root.unmount())
  })

  it('keys a typed value by its value, through a key function', async () => {
    const { get, root } = await mount()
    await act(async () => get().set('1.0'))
    expect(get().key()).toBe('1.0')
    expect(get().key(decimalKey)).toBe('1')
    await act(async () => root.unmount())
  })

  it('keys a policy by its name, through the app refilling it', async () => {
    const { get, root } = await mount()
    await act(async () => get().choose('max', '5'))
    expect(get().key()).toBe('policy:max')
    // The balance moved: the app refills Max, still the user's choice of all.
    await act(async () => get().fill('6'))
    expect(get().value).toBe('6')
    expect(get().key()).toBe('policy:max')
    await act(async () => root.unmount())
  })

  it('keeps a typed key through an app refill, numerically the same or not', async () => {
    const { get, root } = await mount()
    await act(async () => get().set('5'))
    await act(async () => get().fill('5'))
    expect(get().key()).toBe('5')
    // The app refilled another number: shown, never keyed. Two typed choices may merge, never split.
    await act(async () => get().fill('7'))
    expect(get().value).toBe('7')
    expect(get().key()).toBe('5')
    // A seed resets it, as a fresh form does.
    await act(async () => get().choose('max', '9'))
    await act(async () => get().seed(''))
    expect(get().key()).toBe('auto:amount')
    await act(async () => root.unmount())
  })
})

describe('a value retyped as it already is', () => {
  it('keeps its provenance and key, so a retry after a lost reply is the same action; another value is typed', async () => {
    const { get, root } = await mount()
    await act(async () => get().seed('100'))
    expect(get().key(decimalKey)).toBe('auto:amount')
    // The user retypes the seeded amount, canonically the same.
    await act(async () => get().set('100.0'))
    expect(get().value).toBe('100.0')
    expect(get().key(decimalKey)).toBe('auto:amount')
    await act(async () => get().set('99'))
    expect(get().key(decimalKey)).toBe('99')
    await act(async () => root.unmount())
  })
})

describe('a chosen value set on every render', () => {
  it('settles: an effect that seeds, fills or chooses the same value each render stays stable', async () => {
    let renders = 0
    function Seeder({ how }: { how: 'seed' | 'fill' | 'choose' | 'set' }) {
      renders += 1
      const field = useChosen({ min: '', max: '' }, 'range')
      const { seed, fill, choose, set } = field
      useEffect(() => {
        // A fresh object every render, equal in content.
        const next = { min: '1', max: '2' }
        if (how === 'seed') seed(next)
        else if (how === 'fill') fill(next)
        else if (how === 'choose') choose('default', next)
        else set(next)
      })
      return null
    }
    for (const how of ['seed', 'fill', 'choose', 'set'] as const) {
      renders = 0
      const root = createRoot(document.createElement('div'))
      await act(async () => root.render(<Seeder how={how} />))
      expect(renders, how).toBeLessThan(5)
      await act(async () => root.unmount())
    }
  })
})

describe('an amount in a key', () => {
  it('is the canonical decimal the user typed, whatever token decimals it meets', () => {
    expect(decimalKey('1')).toBe('1')
    expect(decimalKey('1.0')).toBe('1')
    expect(decimalKey('01.500')).toBe('1.5')
    expect(decimalKey(' .5 ')).toBe('0.5')
    expect(decimalKey('0.000')).toBe('0')
    expect(decimalKey('abc')).toBe('abc')
  })
})
