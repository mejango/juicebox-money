'use client'

import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  buildDeployProjectPayerTx,
  projectPayerFromDeployLogs,
} from '@bananapus/nana-sdk-core/v6'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { zeroAddress, type Address, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { AddressField } from '@/components/create/AddressField'
import { TxError } from '@/components/ui/TxError'
import { txPhaseLabel, useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { resolvedAddress } from '@/lib/ens'
import { draftFileName } from '@/lib/draft'
import { truncateAddress } from '@/lib/format'
import {
  buildProjectDraftExport,
  type ExportProjectProfile,
} from '@/lib/project-draft-export'
import { chainName, toUrn } from '@/lib/urn'
import { useProjectTokenSymbol } from '@/hooks/useProjectTokenSymbol'

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
  authorities: [number, string | null][]
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

/** A reviewed, ready-to-send deploy: the exact args are frozen here so what
 *  the user confirms is what's sent. */
type ReviewedDeploy = {
  request: ReturnType<typeof buildDeployProjectPayerTx>
  beneficiary: Address
  owner: Address
  addToBalance: boolean
  memo: string
  /** The account the review was made for. */
  account: Address
}

/**
 * "Payer address" (tx #32): deploy a JBProjectPayer so plain ETH transfers
 * to a dedicated address pay the project. Website parity: default behavior
 * is Pay, default beneficiary is the zero address (the original payer
 * receives the tokens), default owner is the zero address (immutable) with
 * an opt-in editable mode owned by the connected wallet, and metadata is
 * always 0x. Deploys are permissionless.
 */
function PayerAddressCard({
  chainId,
  projectId,
  chains,
}: {
  chainId: JBChainId
  projectId: number
  /** Per-chain deployments: [chainId, projectId] — sibling ids can differ. */
  chains: [number, number][]
}) {
  const { isConnected, address, openSignIn } = useWallet()
  const tx = useSafeTx(chainId)
  const { data: ownToken } = useProjectTokenSymbol(chainId, projectId)
  // Name the field after what the beneficiary actually receives.
  const beneficiaryLabel = `${ownToken?.symbol || 'Token'} beneficiary`

  const [addToBalance, setAddToBalance] = useState(false)
  const [beneficiary, setBeneficiary] = useState('')
  const [memo, setMemo] = useState('')
  const [editable, setEditable] = useState(false)
  const [adminInput, setAdminInput] = useState('')
  const [flowError, setFlowError] = useState<string | null>(null)
  const [review, setReview] = useState<ReviewedDeploy | null>(null)

  const chainMeta = JB_CHAINS[chainId]
  const etherscanHost = chainMeta?.etherscanHostname
  const txUrl = tx.hash
    ? `https://${etherscanHost}/tx/${tx.hash}`
    : null

  const busy = tx.busy

  // Editing any input invalidates the reviewed args.
  const invalidate = () => {
    setReview(null)
    setFlowError(null)
  }

  // The deployed payer address comes from the deployer's DeployProjectPayer
  // event in the receipt (the function's return value isn't available from
  // a transaction) — projectPayer is the indexed first arg.
  const deployedPayer = useMemo(() => {
    if (!tx.receipt) return null
    return projectPayerFromDeployLogs(tx.receipt.logs)
  }, [tx.receipt])

  const otherChains = chains.filter(([id]) => id !== chainId)

  const handleReview = () => {
    if (busy) return
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    setFlowError(null)
    // Empty beneficiary = the zero address: the payer contract mints to
    // whoever sent the ETH.
    let beneficiaryAddress: Address = zeroAddress
    const raw = beneficiary.trim()
    if (raw) {
      const resolved = resolvedAddress(raw)
      if (!resolved) {
        setFlowError(
          'Enter a valid beneficiary address or ENS name, or leave it empty.',
        )
        return
      }
      beneficiaryAddress = resolved
    }
    // Owner defaults to the zero address — nobody can ever change the payer.
    // Editable mode names an admin explicitly, defaulting to the connected
    // wallet but not assuming it: whoever deploys is often not who should
    // administer the address afterwards.
    let owner: Address = zeroAddress
    if (editable) {
      const rawAdmin = adminInput.trim()
      if (rawAdmin) {
        const resolvedAdmin = resolvedAddress(rawAdmin)
        if (!resolvedAdmin) {
          setFlowError('Enter a valid admin address or ENS name.')
          return
        }
        owner = resolvedAdmin
      } else {
        owner = address
      }
    }
    setReview({
      request: buildDeployProjectPayerTx({
        chainId,
        projectId: BigInt(projectId),
        beneficiary: beneficiaryAddress,
        memo: memo.trim(),
        addToBalance,
        owner,
      }),
      beneficiary: beneficiaryAddress,
      owner,
      addToBalance,
      memo: memo.trim(),
      account: address,
    })
  }

  const handleConfirm = () => {
    if (!review || busy) return
    // Account-unchanged recheck: the reviewed args embed the owner.
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      setReview(null)
      setFlowError('Your connected account changed — review the deploy again.')
      return
    }
    tx.send(review.request)
  }

  const resetAll = () => {
    setReview(null)
    setFlowError(null)
    tx.reset()
  }

  return (
    <div className="card p-5">
      <div>
        <h2 className="font-agrandir text-lg font-medium">Payer address</h2>
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          Get a dedicated address that pays this project whenever someone sends
          ETH to it — no app needed. Sending other tokens to it directly
          doesn&apos;t work. Anyone can create any number of payer addresses.
        </p>
        {tx.phase !== 'success' ? (
          <>
            <label className="mt-4 block max-w-sm">
              <span className="field-label">Behavior</span>
              <select
                value={addToBalance ? 'balance' : 'pay'}
                disabled={busy}
                onChange={e => {
                  setAddToBalance(e.target.value === 'balance')
                  invalidate()
                }}
                className="input-well select-caret mt-1.5 min-h-[40px] w-full px-3 pr-9 text-sm"
              >
                <option value="pay">Pay</option>
                <option value="balance">Add to balance</option>
              </select>
            </label>
            <p className="mt-1.5 text-xs text-smoke-700">
              {addToBalance
                ? 'Adds funds to the project without minting any tokens.'
                : 'Pays the project and mints its tokens to the beneficiary.'}
            </p>
          </>
        ) : null}
      </div>
      {tx.phase === 'success' ? (
        <PayerDeployedPanel
          payer={deployedPayer}
          etherscanHost={etherscanHost}
          txUrl={txUrl}
          onReset={resetAll}
        />
      ) : (
        <>
          {!addToBalance ? (
            <div className="mt-4">
              <span className="field-label">{beneficiaryLabel}</span>
              <AddressField
                value={beneficiary}
                onChange={value => {
                  setBeneficiary(value)
                  invalidate()
                }}
                disabled={busy}
                placeholder="0x… or name.eth (optional)"
                ariaLabel={beneficiaryLabel}
                className="mt-1.5"
                compact
              />
              <p className="mt-1.5 text-xs text-smoke-700">
                Leave empty and whoever sends the ETH gets the tokens.
              </p>
            </div>
          ) : null}

          <label className="mt-4 block">
            <span className="field-label">Memo</span>
            <input
              type="text"
              value={memo}
              onChange={e => {
                setMemo(e.target.value.slice(0, 256))
                invalidate()
              }}
              disabled={busy}
              placeholder="Optional note attached to every payment"
              aria-label="Memo"
              className="input-well mt-1.5 min-h-[40px] w-full px-3 text-sm disabled:opacity-60"
            />
          </label>

          <label className="mt-4 flex items-start gap-2.5 text-sm text-ink">
            <input
              type="checkbox"
              checked={editable}
              disabled={busy}
              onChange={e => {
                setEditable(e.target.checked)
                invalidate()
              }}
              className="mt-0.5"
            />
            <span>
              Let me edit this later
              <span className="mt-0.5 block text-xs leading-relaxed text-smoke-700">
                {editable
                  ? 'The admin can later change the destination project, behavior, beneficiary, and memo. It never receives the payments.'
                  : 'Off by default: the settings above are permanent once deployed.'}
              </span>
            </span>
          </label>

          {editable ? (
            <div className="mt-3">
              <span className="field-label">Address admin</span>
              <AddressField
                value={adminInput}
                onChange={value => {
                  setAdminInput(value)
                  invalidate()
                }}
                disabled={busy}
                placeholder="0x… or name.eth"
                ariaLabel="Address admin"
                className="mt-1.5"
                compact
              />
              <p className="mt-1.5 text-xs text-smoke-700">
                Leave empty to use your connected wallet.
              </p>
            </div>
          ) : null}

          {review ? (
            <div className="callout callout-info mt-4 text-xs">
              <p>
                Deploys a payer address on {chainName(chainId)} that{' '}
                {review.addToBalance
                  ? 'adds every ETH transfer to the project balance without minting tokens'
                  : 'pays the project with every ETH transfer'}
                .
              </p>
              {!review.addToBalance ? (
                <p className="mt-1">
                  Tokens go to{' '}
                  {review.beneficiary === zeroAddress
                    ? 'whoever sends the ETH'
                    : truncateAddress(review.beneficiary)}
                  .
                </p>
              ) : null}
              {review.memo ? (
                <p className="mt-1">Memo: {review.memo}</p>
              ) : null}
              <p className="mt-1 text-smoke-700">
                {review.owner === zeroAddress
                  ? 'These settings can never be changed.'
                  : `${truncateAddress(review.owner)} can change these settings later.`}
              </p>
            </div>
          ) : null}

          <button
            onClick={review ? handleConfirm : handleReview}
            disabled={busy}
            className="btn-primary mt-4 min-h-[44px] px-5 text-sm"
          >
            {txPhaseLabel(tx.phase, {
              pending: 'Deploying…',
              idle: !isConnected
                ? 'Sign in to continue'
                : review
                  ? 'Confirm deploy'
                  : 'Review deploy',
            })}
          </button>

          {tx.phase === 'pending' && txUrl ? (
            <p className="mt-2 text-center text-xs text-smoke-700">
              Waiting for confirmation —{' '}
              <a
                href={txUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                view transaction
              </a>
            </p>
          ) : null}

          <TxError
            error={flowError ?? tx.error}
            className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
          />
        </>
      )}

      {otherChains.length > 0 ? (
        <p className="mt-4 text-xs leading-relaxed text-smoke-700">
          Payer addresses deploy per chain. For other chains:{' '}
          {otherChains.map(([id, pid], i) => (
            <span key={id}>
              <Link
                href={`/${toUrn(id, pid)}#extras`}
                className="underline underline-offset-2 hover:text-ink"
              >
                {chainName(id)}
              </Link>
              {i < otherChains.length - 1 ? ', ' : ''}
            </span>
          ))}
          .
        </p>
      ) : null}
    </div>
  )
}

/** Success panel: the deployed payer address, ready to copy and share. */
function PayerDeployedPanel({
  payer,
  etherscanHost,
  txUrl,
  onReset,
}: {
  payer: Address | null
  etherscanHost?: string
  txUrl: string | null
  onReset: () => void
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
        {payer && etherscanHost ? (
          <a
            href={`https://${etherscanHost}/address/${payer}`}
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
        <button onClick={onReset} className="text-smoke-700 hover:text-ink">
          Deploy another
        </button>
      </div>
    </div>
  )
}
