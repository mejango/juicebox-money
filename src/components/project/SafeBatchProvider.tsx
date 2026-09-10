'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Address } from 'viem'
import {
  readSafeBatch,
  subscribeSafeBatch,
  upsertStep,
  writeSafeBatch,
  type BatchStep,
} from '@/lib/safe-batch'
import { chainName } from '@/lib/urn'

export type SafeBatchDeployment = {
  chainId: JBChainId
  projectId: number
  indexedAuthority: Address | null
}

type SafeBatchContextValue = {
  deployments: SafeBatchDeployment[]
  isRevnet: boolean
  /** Queued steps per chain, in submission order. */
  batches: Record<number, BatchStep[]>
  stepsOn: (chainId: number) => BatchStep[]
  /** Upsert each step into its own chain's tray and announce it. */
  queue: (steps: readonly BatchStep[]) => void
  replace: (chainId: JBChainId, steps: readonly BatchStep[]) => void
  clear: (chainId?: JBChainId) => void
  notice: string | null
  setNotice: (notice: string | null) => void
}

const SafeBatchContext = createContext<SafeBatchContextValue | null>(null)

/**
 * The per-project batch tray. One instance wraps the whole project page so
 * the queue survives tab switches; localStorage keeps it across reloads.
 */
export function SafeBatchProvider({
  deployments,
  isRevnet,
  children,
}: {
  deployments: SafeBatchDeployment[]
  isRevnet: boolean
  children: ReactNode
}) {
  const [batches, setBatches] = useState<Record<number, BatchStep[]>>({})
  const [notice, setNotice] = useState<string | null>(null)

  const reload = useCallback(() => {
    const next: Record<number, BatchStep[]> = {}
    for (const deployment of deployments) {
      const steps = readSafeBatch(deployment.chainId, deployment.projectId)
      if (steps.length) next[deployment.chainId] = steps
    }
    setBatches(next)
  }, [deployments])

  useEffect(() => {
    reload()
    return subscribeSafeBatch(reload)
  }, [reload])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 8_000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const projectOn = useCallback(
    (chainId: number) =>
      deployments.find(deployment => deployment.chainId === chainId)?.projectId ??
      null,
    [deployments],
  )

  const replace = useCallback(
    (chainId: JBChainId, steps: readonly BatchStep[]) => {
      const projectId = projectOn(chainId)
      if (projectId === null) return
      setBatches(current => {
        const next = { ...current }
        if (steps.length) next[chainId] = [...steps]
        else delete next[chainId]
        return next
      })
      writeSafeBatch(chainId, projectId, steps)
    },
    [projectOn],
  )

  const queue = useCallback(
    (steps: readonly BatchStep[]) => {
      const next = { ...batches }
      const touched: JBChainId[] = []
      for (const step of steps) {
        if (projectOn(step.chainId) !== step.projectId) continue
        next[step.chainId] = upsertStep(next[step.chainId] ?? [], step)
        if (!touched.includes(step.chainId)) touched.push(step.chainId)
      }
      if (!touched.length) return
      setBatches(next)
      for (const chainId of touched) {
        const projectId = projectOn(chainId)
        if (projectId !== null) writeSafeBatch(chainId, projectId, next[chainId])
      }
      setNotice(`Added to the batch for ${touched.map(chainName).join(', ')}.`)
    },
    [batches, projectOn],
  )

  const clear = useCallback(
    (chainId?: JBChainId) => {
      const targets = chainId
        ? deployments.filter(deployment => deployment.chainId === chainId)
        : deployments
      for (const deployment of targets) {
        writeSafeBatch(deployment.chainId, deployment.projectId, [])
      }
      setBatches(current => {
        if (!chainId) return {}
        const next = { ...current }
        delete next[chainId]
        return next
      })
    },
    [deployments],
  )

  const stepsOn = useCallback(
    (chainId: number) => batches[chainId] ?? [],
    [batches],
  )

  const value = useMemo<SafeBatchContextValue>(
    () => ({
      deployments,
      isRevnet,
      batches,
      stepsOn,
      queue,
      replace,
      clear,
      notice,
      setNotice,
    }),
    [deployments, isRevnet, batches, stepsOn, queue, replace, clear, notice],
  )

  return (
    <SafeBatchContext.Provider value={value}>{children}</SafeBatchContext.Provider>
  )
}

/** The tray, or null outside a project page (forms then hide "Add to batch"). */
export function useSafeBatch(): SafeBatchContextValue | null {
  return useContext(SafeBatchContext)
}
