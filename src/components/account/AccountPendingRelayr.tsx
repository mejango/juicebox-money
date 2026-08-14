'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChainIcon } from '@/components/ChainIcon'
import { useWallet } from '@/hooks/useWallet'
import {
  fetchRelayrBundlesByAccount,
  relayrSessionExpired,
  relayrSessionExpiresAt,
  relayrDestinationHash,
  relayrProgress,
  relayrRecordChain,
  relayrStateIsFailed,
  relayrStateIsSuccess,
  resumeRelayrSession,
  type RelayrPendingSession,
  type RelayrTransactionRecord,
} from '@/lib/relayr'
import { chainName } from '@/lib/urn'
import { etherscanTxUrl, formatDate } from '@/lib/format'

type LegState = 'confirmed' | 'failed' | 'pending'

function legStateOf(record: RelayrTransactionRecord | undefined): LegState {
  if (relayrStateIsSuccess(record?.status?.state)) return 'confirmed'
  if (relayrStateIsFailed(record?.status?.state)) return 'failed'
  return 'pending'
}

function requiresProjectSafeProof(
  scope: string,
  session: RelayrPendingSession,
): boolean {
  return (
    scope.startsWith('safe-queue:') ||
    !!session.expectedEntries ||
    !!session.expectedSafeExecutions
  )
}

/** Pair each selected chain with its (first unclaimed) bundle record. */
export function sessionLegs(
  session: RelayrPendingSession,
): { chainId: number; record: RelayrTransactionRecord | undefined }[] {
  const unclaimed = [...session.records]
  return session.chainIds.map(chainId => {
    const index = unclaimed.findIndex(
      record => relayrRecordChain(record) === chainId,
    )
    const record = index === -1 ? undefined : unclaimed.splice(index, 1)[0]
    return { chainId, record }
  })
}

const LEG_STYLE: Record<LegState, string> = {
  confirmed: 'border-bluebs-500 text-bluebs-600',
  failed: 'border-crush-500 text-crush-600',
  pending: 'border-smoke-300 text-smoke-600',
}

/**
 * The account's saved cross-chain bundles that are still (or last known to
 * be) in flight, with per-chain leg states and a resume path. Only rendered
 * for the connected wallet's own account — the sessions live in this
 * device's localStorage.
 */
export function AccountPendingRelayr({ address }: { address: string }) {
  const { address: connected } = useWallet()
  const isSelf =
    !!connected && connected.toLowerCase() === address.toLowerCase()
  const [bundles, setBundles] = useState<
    { scope: string; session: RelayrPendingSession }[]
  >([])
  const [busyScope, setBusyScope] = useState<string | null>(null)
  const [notices, setNotices] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    setBundles(isSelf ? await fetchRelayrBundlesByAccount(address) : [])
  }, [address, isSelf])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!isSelf || bundles.length === 0) return null

  const resume = async (scope: string) => {
    if (!connected) return
    setBusyScope(scope)
    setNotices(previous => ({ ...previous, [scope]: 'Resuming…' }))
    try {
      await resumeRelayrSession({ scope, account: connected })
      setNotices(previous => ({
        ...previous,
        [scope]: 'Completed on every chain.',
      }))
    } catch (error) {
      setNotices(previous => ({
        ...previous,
        [scope]:
          error instanceof Error ? error.message : 'Could not resume.',
      }))
    } finally {
      setBusyScope(null)
      void refresh()
    }
  }

  return (
    <div className="mb-4 space-y-3">
      {bundles.map(({ scope, session }) => {
        const progress = relayrProgress(session.records, session.expectedCount)
        const projectSafeProof = requiresProjectSafeProof(scope, session)
        return (
          <div key={scope} className="card border-bluebs-500/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium text-ink">
                Cross-chain action in flight
                <span className="ml-2 text-xs font-normal text-smoke-500">
                  {formatDate(Math.floor(session.createdAt / 1000))} —{' '}
                  {projectSafeProof
                    ? `${progress.confirmed}/${progress.total} Relayr-reported; onchain proof pending`
                    : `${progress.confirmed}/${progress.total} chains done`}
                </span>
              </div>
              {relayrSessionExpired(session) ? (
                // The signed ForwardRequests are past their 47-hour deadline, so the
                // forwarder will reject them — offering Resume here promised a retry that
                // cannot succeed, on a bundle the user has already paid for.
                <span className="text-xs text-smoke-600">
                  Signatures expired{' '}
                  {formatDate(Math.floor(relayrSessionExpiresAt(session) / 1000))} — this
                  bundle can no longer be executed.
                </span>
              ) : projectSafeProof ? (
                <span className="text-xs text-smoke-600">
                  Verify this paid bundle from the relevant project&apos;s
                  Owner/Operator tab.
                </span>
              ) : (
                <button
                  onClick={() => resume(scope)}
                  disabled={busyScope !== null}
                  className="btn-secondary min-h-[36px] px-4 text-sm"
                >
                  {busyScope === scope ? 'Resuming…' : 'Resume'}
                </button>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {sessionLegs(session).map(({ chainId, record }, index) => {
                const reportedState = legStateOf(record)
                const state =
                  projectSafeProof && reportedState === 'confirmed'
                    ? 'pending'
                    : reportedState
                const hash = record ? relayrDestinationHash(record) : null
                const txUrl = hash ? etherscanTxUrl(chainId, hash) : null
                const leg = (
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${LEG_STYLE[state]}`}
                  >
                    <ChainIcon chainId={chainId} size={14} />
                    {chainName(chainId)} —{' '}
                    {projectSafeProof && reportedState === 'confirmed'
                      ? 'Relayr-reported; verify in Owner/Operator'
                      : state}
                  </span>
                )
                return txUrl ? (
                  <a
                    key={`${chainId}-${index}`}
                    href={txUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="transition-opacity hover:opacity-70"
                  >
                    {leg}
                  </a>
                ) : (
                  <span key={`${chainId}-${index}`}>{leg}</span>
                )
              })}
            </div>
            {notices[scope] ? (
              <p className="mt-2 text-xs text-smoke-600">{notices[scope]}</p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
