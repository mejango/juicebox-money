'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { getFunctionSelector, type Address, type Hex, type PublicClient } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { verifyReviewedWriteReceipt, WRITE_EXIT_LABEL, writeExitMessage, writeHeldMessage } from '@bananapus/nana-sdk-core/review'
import { DefifaNftTransactionRevertedError, restoreDefifaNftReceiptContext, verifyDefifaNftTransaction } from '@bananapus/nana-sdk-core/v6'
import { reportedSafeExecution, waitForSafeExecutionHash } from '@/lib/safe-connector'
import { explorerTxUrl } from '@/lib/chainDisplay'
import { chainName } from '@/lib/urn'
import { invalidateProjectDisplayQueries } from '@/lib/project-display-cache'
import { useUnmountSignal } from '@/hooks/useUnmountSignal'
import { DEFIFA_HOLDINGS_QUERY_PREFIX, SHOP_721_QUERY_PREFIX } from '@/hooks/useShop721'
import { abandonDefifaWriteRecovery, clearDefifaWriteRecovery, readDefifaWriteRecovery, resolveDefifaWriteRecovery, DEFIFA_RECOVERY_QUERY_PREFIX, DEFIFA_RECOVERY_CHANGE_EVENT, type DefifaWriteAction } from '@/lib/defifa-write-recovery'
const actionLabel = { pay: 'NFT mint', 'cash-out': 'NFT cash-out', transfer: 'NFT transfer' }
const describe = (error: unknown) => error instanceof Error ? error.message : 'The original transaction could not be verified.'

/** Reads the original SDK journal before another quote, including after a closed phase or remount. */
export function DefifaRecovery({ chainId, projectId, account, hook, actions, active, children }: {
  chainId: JBChainId; projectId: number; account?: Address; hook: Address
  actions: readonly DefifaWriteAction[]; active: boolean; children: ReactNode
}) {
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const queries = useQueryClient()
  const flowSignal = useUnmountSignal()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolved, setResolved] = useState<{ hash: Hex; chainId: number; failed: boolean }>()
  const identity = `${chainId}:${projectId}:${account ?? ''}:${actions.join(',')}`
  const actor = useRef({ identity, generation: 0 })
  if (actor.current.identity !== identity) actor.current = { identity, generation: actor.current.generation + 1 }
  const saved = useQuery({
    queryKey: [...DEFIFA_RECOVERY_QUERY_PREFIX, chainId, projectId, account, actions.join(',')],
    enabled: !!account, retry: false, staleTime: 0,
    queryFn: () => actions.flatMap(action => {
      const scope = { chainId, projectId, account: account!, action }
      const record = readDefifaWriteRecovery(scope)
      return record ? [{ scope, record }] : []
    }),
  })
  useEffect(() => {
    setChecking(false); setError(null); setResolved(undefined)
  }, [identity])
  useEffect(() => {
    const refresh = () => { void queries.invalidateQueries({ queryKey: DEFIFA_RECOVERY_QUERY_PREFIX }) }
    window.addEventListener('storage', refresh)
    window.addEventListener(DEFIFA_RECOVERY_CHANGE_EVENT, refresh)
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener(DEFIFA_RECOVERY_CHANGE_EVENT, refresh) }
  }, [queries])
  const original = saved.data?.[0]
  // An ordinary write saved without a hash may be proven by the chain: its
  // exact call at the nonce the account had when the wallet opened.
  const unhashed = original && !original.record.hash && !original.record.safe ? original : undefined
  const unhashedRef = useRef(unhashed)
  unhashedRef.current = unhashed
  const unhashedId = unhashed?.record.id
  useEffect(() => {
    const current = unhashedRef.current
    if (!unhashedId || !current || !client) return
    void resolveDefifaWriteRecovery(current.scope, current.record, client).catch(() => {
      // Unread: the hold stays, with its exit.
    })
  }, [unhashedId, client])
  const exit = () => {
    if (!original) return
    try {
      abandonDefifaWriteRecovery(original.scope, original.record)
    } catch (reason) {
      setError(describe(reason))
    }
  }
  const verify = async () => {
    if (!original?.record.hash || !client || checking) return
    const generation = actor.current.generation
    const { scope, record } = original
    setChecking(true); setError(null)
    try {
      let execution = record.hash!
      if (record.safe) {
        try {
          execution = await waitForSafeExecutionHash(scope.chainId, record.hash!, { client, signal: AbortSignal.any([flowSignal(), AbortSignal.timeout(10_000)]) })
        } catch (reason) {
          const failedExecution = await reportedSafeExecution(reason, scope.chainId, record.account, record.hash!)
          if (!failedExecution) throw reason
          execution = failedExecution
        }
      }
      const receipt = await client.getTransactionReceipt({ hash: execution })
      let failed = false
      const approval = scope.action === 'pay' && record.call.data.startsWith(getFunctionSelector('approve(address,uint256)'))
      if (approval) failed = await verifyReviewedWriteReceipt(client, record, receipt) === 'failed'
      else {
        const context = await restoreDefifaNftReceiptContext(client, { chainId: scope.chainId, projectId: BigInt(scope.projectId), record, receipt, expectedHook: hook })
        try {
          await verifyDefifaNftTransaction(client, context, receipt)
        } catch (reason) {
          if (!(reason instanceof DefifaNftTransactionRevertedError) || reason.chainId !== scope.chainId || reason.hash.toLowerCase() !== receipt.transactionHash.toLowerCase()) throw reason
          failed = true
        }
      }
      await clearDefifaWriteRecovery(scope, record)
      await Promise.all([
        queries.invalidateQueries({ queryKey: DEFIFA_RECOVERY_QUERY_PREFIX }),
        queries.invalidateQueries({ queryKey: SHOP_721_QUERY_PREFIX }),
        queries.invalidateQueries({ queryKey: DEFIFA_HOLDINGS_QUERY_PREFIX }),
        invalidateProjectDisplayQueries(queries, scope.chainId),
      ])
      if (actor.current.generation === generation) setResolved({ hash: receipt.transactionHash, chainId: scope.chainId, failed })
    } catch (reason) { if (actor.current.generation === generation) setError(describe(reason)) }
    finally { if (actor.current.generation === generation) setChecking(false) }
  }
  if (active || !account) return children
  if (saved.isLoading) return <p role="status" className="text-sm">Checking saved NFT actions…</p>
  if (saved.isError) return <div role="alert" className="card space-y-3 p-5"><p>{describe(saved.error)}</p><button className="btn-secondary px-4 py-2" onClick={() => void saved.refetch()}>Retry saved action</button></div>
  if (original) return <div className="card space-y-3 p-5">
    <span className="field-label">Earlier {actionLabel[original.scope.action]} on {chainName(original.scope.chainId)}</span>
    <p className="text-sm">{writeHeldMessage(actionLabel[original.scope.action])}</p>
    <div className="flex flex-wrap gap-2">
      {original.record.hash ? <button type="button" className="btn-primary px-4 py-2" disabled={checking} onClick={() => void verify()}>{checking ? 'Checking original transaction…' : 'Check original transaction'}</button> : null}
      <button type="button" className="btn-secondary px-4 py-2" disabled={checking} onClick={exit}>{WRITE_EXIT_LABEL}</button>
    </div>
    <p className="text-xs text-smoke-600">{writeExitMessage(original.record.call, actionLabel[original.scope.action])}</p>
    {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
  </div>
  return <>{resolved ? <p className="mb-3 text-sm">{resolved.failed ? 'Original transaction failed onchain.' : 'Original transaction verified onchain.'} <a className="underline" target="_blank" rel="noopener noreferrer" href={explorerTxUrl(resolved.chainId, resolved.hash) ?? undefined}>View original transaction</a></p> : null}{children}</>
}
