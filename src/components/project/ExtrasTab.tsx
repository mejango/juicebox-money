'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { isAddress, zeroAddress, type Address, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { ChainIcon } from '@/components/ChainIcon'
import { AddressField } from '@/components/create/AddressField'
import { AddressLink } from '@/components/ui/AddressLink'
import { ModalShell } from '@/components/ui/ModalShell'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { useWallet } from '@/hooks/useWallet'
import { resolvedAddress } from '@/lib/ens'
import { draftFileName } from '@/lib/draft'
import { truncateAddress } from '@/lib/format'
import { getProjectPayers, type BsProjectPayer } from '@/lib/bendystraw'
import {
  buildProjectDraftExport,
  type ExportProjectProfile,
} from '@/lib/project-draft-export'
import { chainName } from '@/lib/urn'
import { useProjectTokenSymbol } from '@/hooks/useProjectTokenSymbol'
import { explorerAddressUrl, explorerTxUrl } from '@/lib/chainDisplay'
import { buildPayerDeploymentReview, finishPayerDeployment, loadPayerDeployment, payerDeploymentScope, runPayerDeployments, type PayerDeploymentSession } from '@/lib/payer-relayr'

/**
 * Extras tab: export a verified create-flow draft, plus the payer-address
 * deployer (tx #32, JBProjectPayerDeployer.deployProjectPayer).
 */

type ExtrasTabProps = {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
  profile: ExportProjectProfile
  /** Per-chain deployments: [chainId, projectId] — sibling ids can differ. */
  chains: [number, number][]
  /** Per-chain project owner or revnet operator. */
  authorities: [number, string | null | undefined][]
}

export function ExtrasTab(props: ExtrasTabProps) {
  return (
    <div className="space-y-5">
      <ProjectDraftExportCard {...props} />
      <PayerAddressCard
        chainId={props.chainId}
        projectId={props.projectId}
        chains={props.chains}
      />
    </div>
  )
}

function ProjectDraftExportCard({
  chainId,
  projectId,
  isRevnet,
  profile,
  chains,
  authorities,
}: ExtrasTabProps) {
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{
    kind: 'idle' | 'success' | 'error'
    text: string
  }>({ kind: 'idle', text: '' })

  const download = async () => {
    if (!client || busy) return
    setBusy(true)
    setStatus({ kind: 'idle', text: 'Verifying live rules, funds, and splits…' })
    try {
      const authorityByChain = Object.fromEntries(
        authorities.flatMap(([id, authority]) =>
          authority ? [[id, authority]] : [],
        ),
      )
      const result = await buildProjectDraftExport({
        client,
        chainId,
        projectId,
        isRevnet,
        profile,
        chains: chains.map(([id]) => id),
        authorityByChain,
      })
      if (
        result.warnings.length &&
        !window.confirm(
          `${result.warnings.join('\n\n')}\n\nExport this editable .jb anyway?`,
        )
      ) {
        setStatus({ kind: 'idle', text: 'Cancelled' })
        return
      }
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result.draft, null, 2)], {
          type: 'application/json',
        }),
      )
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = draftFileName(profile.name)
      anchor.click()
      URL.revokeObjectURL(url)
      setStatus({
        kind: 'success',
        text: 'Exported .jb. Import it from Start a project to review and edit.',
      })
    } catch (error) {
      setStatus({
        kind: 'error',
        text:
          error instanceof Error
            ? error.message
            : 'Could not safely reconstruct this project.',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card p-5">
      <h2 className="font-agrandir text-lg font-medium">Export deployment</h2>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        Download this project&apos;s deployed configuration as a .jb file.
        Import it from Start a project to review the reconstructed rules and
        make changes before deploying. No transaction is required.
      </p>
      {status.text ? (
        <p
          className={`mt-3 text-sm ${
            status.kind === 'error'
              ? 'text-red-700'
              : status.kind === 'success'
                ? 'text-green-700'
                : 'text-smoke-700'
          }`}
        >
          {status.text}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void download()}
        disabled={busy || !client}
        className="btn-secondary mt-4 min-h-[40px] px-4 text-sm disabled:opacity-50"
      >
        {busy ? 'Verifying…' : 'Export .jb'}
      </button>
    </div>
  )
}

/** Permissionless payer deployments share frozen settings across explicitly selected project chains. */
function PayerAddressCard({ chainId, projectId, chains }: {
  chainId: JBChainId
  projectId: number
  chains: [number, number][]
}) {
  const { isConnected, address, openSignIn } = useWallet()
  const { data: ownToken } = useProjectTokenSymbol(chainId, projectId)
  const beneficiaryLabel = `${ownToken?.symbol || 'Token'} beneficiary`
  const projects = useMemo(() => [
    [chainId, projectId] as [number, number],
    ...chains.filter(([id]) => id !== chainId),
  ], [chains, chainId, projectId])
  const scope = payerDeploymentScope(projects)
  const [selectedChains, setSelectedChains] = useState<number[]>([chainId])
  const [addToBalance, setAddToBalance] = useState(false)
  const [beneficiary, setBeneficiary] = useState('')
  const [memo, setMemo] = useState('')
  const [editable, setEditable] = useState(false)
  const [adminInput, setAdminInput] = useState('')
  const [flowError, setFlowError] = useState<string | null>(null)
  const [review, setReview] = useState<PayerDeploymentSession | null>(null)
  const [session, setSession] = useState<PayerDeploymentSession | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const { data: payerRows = [], isLoading: payersLoading, isError: payersError,
    isFetching: payersFetching, refetch: refetchPayers } = useQuery({
    queryKey: ['projectPayers', ...projects.flat()],
    queryFn: () => getProjectPayers(projects), enabled: projects.length > 0, staleTime: 30_000, retry: 1,
  })

  useEffect(() => {
    setReview(null)
    setSelectedChains([chainId])
    try { setSession(loadPayerDeployment(scope)) }
    catch (error) { setFlowError(error instanceof Error ? error.message : 'The saved payer deployment could not be read.') }
  }, [scope, chainId])

  const invalidate = () => { setReview(null); setFlowError(null) }
  const handleReview = () => {
    if (busy || session) return
    if (!isConnected || !address) { openSignIn(); return }
    setFlowError(null)
    const beneficiaryAddress = beneficiary.trim() ? resolvedAddress(beneficiary.trim()) : zeroAddress
    if (!beneficiaryAddress) {
      setFlowError('Enter a valid beneficiary address or ENS name, or leave it empty.')
      return
    }
    const owner = editable ? (adminInput.trim() ? resolvedAddress(adminInput.trim()) : address) : zeroAddress
    if (!owner) { setFlowError('Enter a valid admin address or ENS name.'); return }
    try {
      setReview(buildPayerDeploymentReview({ projects, selectedChainIds: selectedChains, account: address,
        beneficiary: beneficiaryAddress, owner, memo: memo.trim(), addToBalance }))
    } catch (error) { setFlowError(error instanceof Error ? error.message : 'Could not review the payer addresses.') }
  }
  const run = async (frozen: PayerDeploymentSession) => {
    if (busy) return
    if (!address || address.toLowerCase() !== frozen.account.toLowerCase()) {
      setReview(null)
      setFlowError('Your connected account changed — review the deploy again.')
      return
    }
    setBusy(true)
    setFlowError(null)
    try {
      const result = await runPayerDeployments(frozen, update => { setSession(update); setReview(null) })
      setSession(result)
      setReview(null)
      await refetchPayers()
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'The payer deployments remain unresolved.')
      try { setSession(loadPayerDeployment(scope)) } catch { /* Keep the last in-memory recovery view. */ }
    } finally { setBusy(false) }
  }
  const resetAll = async () => {
    try {
      if (session) await finishPayerDeployment(session.scope, session.id)
      setSession(null)
      setReview(null)
      setFlowError(null)
    } catch (error) { setFlowError(error instanceof Error ? error.message : 'Resolve the existing deployments first.') }
  }
  const complete = session?.phase === 'complete'

  return (
    <div className="card p-5">
      <h2 className="font-agrandir text-lg font-medium">Payer address</h2>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        Get a dedicated address that pays this project whenever someone sends ETH to it — no app needed.
        Sending other tokens to it directly doesn&apos;t work. Anyone can create any number of payer addresses.
      </p>
      <button type="button" onClick={() => setDialogOpen(true)} className="btn-secondary mt-4 min-h-[40px] px-4 text-sm">
        {session && !complete ? 'Resume payer deployment' : 'Create payer address'}
      </button>
      {session && !complete ? <p className="mt-3 text-sm text-smoke-700">A saved deployment is {session.phase.replaceAll('-', ' ')}. Resume it to check the original addresses.</p> : null}
      {!dialogOpen && flowError ? <TxError error={flowError} className="mt-3 text-sm text-red-700" /> : null}
      {dialogOpen ? (
        <ModalShell title="Create payer address" subtitle="Choose the project chains that need a payer address." onClose={() => setDialogOpen(false)} busy={busy}>
          <div className="max-h-[min(72vh,46rem)] overflow-y-auto px-5 py-5 sm:px-6">
            {session ? (
              <>
                <p className="text-sm text-smoke-700">Saved payer settings: {session.calls[0].addToBalance ? 'Add to balance' : 'Pay'}.
                  {' '}Admin: {session.calls[0].owner === zeroAddress ? 'None (immutable)' : session.calls[0].owner}.
                  {' '}Beneficiary: {session.calls[0].beneficiary === zeroAddress ? 'Whoever sends the ETH' : session.calls[0].beneficiary}.</p>
                {session.outcomes.map((outcome, index) => (
                  <div key={outcome.chainId} className="mt-4 rounded-xl border border-smoke-200 p-3">
                    <p className="text-sm font-medium">{chainName(outcome.chainId)} · project #{session.calls[index].projectId} · {outcome.state}</p>
                    {outcome.state === 'verified' && outcome.payer ? (
                      <PayerDeployedPanel payer={outcome.payer} chainId={outcome.chainId}
                        txUrl={outcome.hash ? explorerTxUrl(outcome.chainId, outcome.hash) : null}
                        onReset={complete ? resetAll : undefined} />
                    ) : outcome.hash && explorerTxUrl(outcome.chainId, outcome.hash) ? (
                      <a href={explorerTxUrl(outcome.chainId, outcome.hash)!} target="_blank" rel="noreferrer" className="mt-2 inline-flex text-xs underline">View original transaction</a>
                    ) : <p className="mt-1 text-xs text-smoke-700">{outcome.safeProposalHash ? `Safe proposal ${outcome.safeProposalHash}` : outcome.state === 'sending' ? 'The wallet may have submitted this deployment. Its hash is unavailable.' : 'This address has not been verified yet.'}</p>}
                    {outcome.error ? <p className="mt-1 text-xs text-red-700">{outcome.error}</p> : null}
                  </div>
                ))}
                {session.quote ? <p className="mt-3 break-all text-xs text-smoke-700">Relayr bundle {session.quote.bundle_uuid}</p> : null}
                {!complete ? <button type="button" disabled={busy} onClick={() => void run(session)} className="btn-primary mt-4 min-h-[44px] px-5 text-sm">
                  {busy ? 'Checking deployments…' : session.phase === 'quoted' || session.phase === 'reviewed' ? 'Continue saved deployment' : 'Check deployment status'}
                </button> : null}
              </>
            ) : (
              <>
                <label className="block max-w-sm"><span className="field-label">Behavior</span>
                  <select value={addToBalance ? 'balance' : 'pay'} disabled={busy} onChange={e => { setAddToBalance(e.target.value === 'balance'); invalidate() }} className="input-well select-caret mt-1.5 min-h-[40px] w-full px-3 pr-9 text-sm">
                    <option value="pay">Pay</option><option value="balance">Add to balance</option>
                  </select>
                </label>
                <p className="mt-1.5 text-xs text-smoke-700">{addToBalance ? 'Adds funds to the project without minting any tokens.' : 'Pays the project and mints its tokens to the beneficiary.'}</p>
                {!addToBalance ? <div className="mt-4"><span className="field-label">{beneficiaryLabel}</span>
                  <AddressField value={beneficiary} onChange={value => { setBeneficiary(value); invalidate() }} disabled={busy}
                    placeholder="0x… or name.eth (optional)" ariaLabel={beneficiaryLabel} className="mt-1.5" compact />
                  <p className="mt-1.5 text-xs text-smoke-700">Leave empty and whoever sends the ETH gets the tokens.</p>
                </div> : null}
                <label className="mt-4 block"><span className="field-label">Memo</span>
                  <input type="text" value={memo} onChange={e => { setMemo(e.target.value.slice(0, 256)); invalidate() }} disabled={busy}
                    placeholder="Optional note attached to every payment" aria-label="Memo" className="input-well mt-1.5 min-h-[40px] w-full px-3 text-sm" />
                </label>
                <label className="mt-4 flex items-start gap-2.5 text-sm text-ink">
                  <input type="checkbox" checked={editable} disabled={busy} onChange={e => { setEditable(e.target.checked); invalidate() }} className="mt-0.5" />
                  <span>Let me edit this later<span className="mt-0.5 block text-xs leading-relaxed text-smoke-700">
                    {editable ? 'The admin can later change the destination project, behavior, beneficiary, and memo. It never receives the payments.' : 'Off by default: the settings above are permanent once deployed.'}
                  </span></span>
                </label>
                {editable ? <div className="mt-3"><span className="field-label">Address admin</span>
                  <AddressField value={adminInput} onChange={value => { setAdminInput(value); invalidate() }} disabled={busy} placeholder="0x… or name.eth" ariaLabel="Address admin" className="mt-1.5" compact />
                  <p className="mt-1.5 text-xs text-smoke-700">Leave empty to use your connected wallet.</p>
                </div> : null}
                <fieldset className="mt-4"><legend className="field-label">Deploy on</legend>
                  {projects.map(([id, pid]) => <label key={id} className="mt-2 flex items-center gap-2 text-sm">
                    <input type="checkbox" aria-label={`Deploy on ${chainName(id)} project #${pid}`} checked={selectedChains.includes(id)} disabled={busy}
                      onChange={e => { setSelectedChains(current => e.target.checked ? [...current, id] : current.filter(value => value !== id)); invalidate() }} />
                    <ChainIcon chainId={id as JBChainId} size={16} />{chainName(id)} · project #{pid}
                  </label>)}
                </fieldset>
                <p className="mt-2 text-xs text-smoke-700">Each selected chain gets its own payer address. Supported deployments can share one Relayr payment across all mainnets or all testnets. Safe deployments confirm in sequence.</p>
                <button onClick={handleReview} disabled={busy} className="btn-primary mt-4 min-h-[44px] px-5 text-sm">{isConnected ? 'Deploy payer address' : 'Sign in to continue'}</button>
              </>
            )}
            <TxError error={flowError} className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700" />
          </div>
        </ModalShell>
      ) : null}
      {review ? <TxConfirmDialog open title="Confirm deploy" rows={payerReviewRows(review)}
        steps={[{ title: `Deploy ${review.calls.length} payer address${review.calls.length === 1 ? '' : 'es'}` }]}
        activeIndex={busy ? 0 : -1} action="Confirm deploy" onConfirm={() => void run(review)} busy={busy} complete={false}
        error={flowError} onClose={() => { if (!busy) setReview(null) }}>
        <p className="text-xs text-smoke-700">{review.calls[0].owner === zeroAddress ? 'These settings can never be changed.' : `${truncateAddress(review.calls[0].owner)} can change these settings later.`}</p>
      </TxConfirmDialog> : null}
      <PayerAddressList rows={payerRows} isLoading={payersLoading} isError={payersError} isFetching={payersFetching} />
    </div>
  )
}

function payerReviewRows(review: PayerDeploymentSession): TxConfirmRow[] {
  const settings = review.calls[0]
  const rows: TxConfirmRow[] = [
    { label: 'Behavior', value: settings.addToBalance ? 'Add to balance' : 'Pay', strong: true },
    ...review.calls.map(call => ({ label: chainName(call.chainId), value: `Project #${call.projectId}` })),
    { label: 'Execution', value: review.transport === 'relayr' ? 'One Relayr payment; choose its funding chain next' : 'Confirm each chain in sequence' },
  ]
  if (!settings.addToBalance) rows.push({ label: 'Tokens go to', value: settings.beneficiary === zeroAddress ? 'Whoever sends the ETH' : settings.beneficiary })
  if (settings.memo) rows.push({ label: 'Memo', value: settings.memo })
  rows.push({ label: 'Admin', value: settings.owner === zeroAddress ? 'None' : settings.owner })
  return rows
}

function payerUsd(value: string): string {
  try {
    const raw = BigInt(value.split('.')[0])
    const cents = (raw + 5_000_000_000_000_000n) / 10_000_000_000_000_000n
    const dollars = cents / 100n
    const remainder = (cents % 100n).toString().padStart(2, '0')
    return `$${dollars.toLocaleString('en-US')}.${remainder}`
  } catch {
    return '$0.00'
  }
}

function payerCounts(row: BsProjectPayer): string {
  const parts: string[] = []
  if (row.paymentsCount) parts.push(`${row.paymentsCount} pay`)
  if (row.addToBalanceCount) {
    parts.push(`${row.addToBalanceCount} balance`)
  }
  return parts.length ? parts.join(' | ') : 'No payments yet'
}

function PayerAddressList({
  rows,
  isLoading,
  isError,
  isFetching,
}: {
  rows: BsProjectPayer[]
  isLoading: boolean
  isError: boolean
  isFetching: boolean
}) {
  return (
    <section className="mt-6 border-t border-smoke-200 pt-5">
      <h3 className="text-sm font-semibold text-ink">
        Deployed payer addresses
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-smoke-700">
        Reuse an existing address or review how much each one has facilitated.
      </p>
      {isFetching && !isLoading ? (
        <p className="mt-2 text-xs text-smoke-700" role="status">
          Refreshing indexed payer addresses…
        </p>
      ) : null}
      {isLoading ? (
        <p className="mt-4 text-sm text-smoke-700">Loading payer addresses…</p>
      ) : isError ? (
        <p className="mt-4 text-sm text-smoke-700">
          Could not load payer addresses from Bendystraw.
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-smoke-700">
          No deployed payer addresses indexed yet.
        </p>
      ) : (
        <div className="mt-4 divide-y divide-smoke-200 border-y border-smoke-200">
          {rows.map(row => (
            <div
              key={`${row.chainId}-${row.address}`}
              className="grid gap-3 py-3 text-sm sm:grid-cols-[8rem_1fr_10rem_8rem] sm:items-start"
            >
              <div className="flex items-center gap-2">
                <ChainIcon chainId={row.chainId} size={16} />
                <span>{chainName(row.chainId)}</span>
              </div>
              <div className="min-w-0 font-mono text-xs">
                {isAddress(row.address) ? (
                  <AddressLink
                    address={row.address}
                    chainId={row.chainId}
                    className="text-ink"
                  />
                ) : (
                  <span className="break-all">{row.address}</span>
                )}
              </div>
              <div>
                <p>{row.defaultAddToBalance ? 'Add to balance' : 'Pay'}</p>
                <p className="mt-0.5 text-xs text-smoke-700">
                  {payerCounts(row)}
                </p>
              </div>
              <div className="sm:text-right">
                <p>{payerUsd(row.totalFacilitatedUsd)}</p>
                <p className="mt-0.5 text-xs text-smoke-700">Facilitated</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** Success panel: the deployed payer address, ready to copy and share. */
function PayerDeployedPanel({
  payer,
  chainId,
  txUrl,
  onReset,
}: {
  payer: Address | null
  chainId: JBChainId
  txUrl: string | null
  onReset?: () => void
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <div className="mt-4 rounded-xl border border-smoke-200 p-4">
      <p className="text-sm font-medium text-ink">
        Payer address deployed. Anyone who sends ETH to it pays this project.
      </p>
      {payer ? (
        <div className="mt-3">
          <span className="field-label">Send ETH to</span>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <code className="break-all rounded-lg bg-split-50 px-3 py-2 font-mono text-xs text-ink">
              {payer}
            </code>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(payer)
                setCopied(true)
              }}
              className="btn-secondary px-2.5 py-1 text-[11px]"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-smoke-700">
          The new address will show on the transaction&apos;s explorer page.
        </p>
      )}
      <div className="mt-3 flex gap-3 text-sm font-semibold">
        {payer && explorerAddressUrl(chainId, payer) ? (
          <a
            href={explorerAddressUrl(chainId, payer)!}
            target="_blank"
            rel="noopener noreferrer"
            className="text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
          >
            View on explorer
          </a>
        ) : null}
        {txUrl ? (
          <a
            href={txUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
          >
            View transaction
          </a>
        ) : null}
        {onReset ? <button onClick={onReset} className="text-smoke-700 hover:text-ink">
          Deploy another
        </button> : null}
      </div>
    </div>
  )
}
