import { describe, expect, it } from 'vitest'
import { mapConcurrentChecks } from '@/lib/concurrent-checks'

function deferred() {
  let resolve!: (value: number) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<number>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('independent chain checks', () => {
  it('starts every independent check without waiting for responses and retains input order', async () => {
    const gates = Array.from({ length: 4 }, deferred)
    const started: number[] = []
    const result = mapConcurrentChecks(gates, (gate, index) => {
      started.push(index)
      return gate.promise
    })
    expect(started).toEqual([0, 1, 2, 3])
    gates[1].resolve(10)
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2, 3])
    gates[2].resolve(20)
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2, 3])
    gates[3].resolve(30)
    gates[0].resolve(0)
    await expect(result).resolves.toEqual([0, 10, 20, 30])
  })

  it('captures synchronous failures while starting and draining later checks', async () => {
    const gate = deferred()
    const error = new Error('Invalid check')
    const started: number[] = []
    const result = mapConcurrentChecks([0, 1], index => {
      started.push(index)
      if (index === 0) throw error
      return gate.promise
    })
    const assertion = expect(result).rejects.toBe(error)
    expect(started).toEqual([0, 1])
    gate.resolve(1)
    await assertion
  })

  it('drains every check before reporting failure and allowing a retry', async () => {
    const gates = Array.from({ length: 3 }, deferred)
    const error = new Error('Safe policy changed')
    let settled = false
    const result = mapConcurrentChecks(gates, gate => gate.promise)
    const assertion = expect(result).rejects.toBe(error)
    void result.then(() => { settled = true }, () => { settled = true })
    gates[0].reject(error)
    gates[1].resolve(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    gates[2].resolve(2)
    await assertion
    expect(settled).toBe(true)
  })
})
