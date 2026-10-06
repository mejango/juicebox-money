import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StrictMode, useEffect } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { useUnmountSignal } from '@/hooks/useUnmountSignal'

/** A component that hands out its flow signal after it mounts, as a click would. */
function Flow({ onMounted }: { onMounted: (signal: () => AbortSignal) => void }) {
  const flowSignal = useUnmountSignal()
  useEffect(() => onMounted(flowSignal), [flowSignal, onMounted])
  return null
}

describe('the signal of a flow a component starts', () => {
  it('stays live while the component is mounted, and aborts when it unmounts', async () => {
    let read: (() => AbortSignal) | undefined
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Flow onMounted={signal => { read = signal }} />) })
    const started = read!()
    expect(started.aborted).toBe(false)
    expect(read!()).toBe(started)
    await act(async () => renderer.unmount())
    expect(started.aborted).toBe(true)
  })

  it("survives React's development remount with a live signal", async () => {
    let read: (() => AbortSignal) | undefined
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<StrictMode><Flow onMounted={signal => { read = signal }} /></StrictMode>)
    })
    expect(read!().aborted).toBe(false)
    await act(async () => renderer.unmount())
    expect(read!().aborted).toBe(true)
  })
})

/**
 * Every function that can wait for a Safe to execute a proposal takes the
 * flow's signal (TypeScript requires it). Each component that starts such a
 * flow ends it when it unmounts: it reads its signal from useUnmountSignal.
 */
const SAFE_WAITING = [
  'waitForSafeExecutionHash',
  'runAuthorityCalls',
  'runProjectBatch',
  'runPayerDeployments',
  'submitSafeBatch',
  'submitSplitReview',
  'submitQueueReview',
  'executeSafeTx',
  'deploySafeSameAddress',
  'prepareLaunchMultisigs',
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('components that wait for a Safe', () => {
  it('end the wait when they unmount', () => {
    const waiting = sources('src/components').flatMap(path => {
      const text = readFileSync(path, 'utf8')
      const calls = SAFE_WAITING.filter(name => new RegExp(`\\b${name}\\(`).test(text) &&
        !new RegExp(`export (async )?function ${name}\\(`).test(text))
      return calls.length ? [{ path, text }] : []
    })
    expect(waiting.length).toBeGreaterThanOrEqual(17)
    expect(waiting.filter(({ text }) => !/useUnmountSignal\(\)/.test(text)).map(({ path }) => path)).toEqual([])
  })
})
