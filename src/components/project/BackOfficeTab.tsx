'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  RevnetCoreContracts,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbPermissionsAbi,
  jbProjectsAbi,
  revOwnerAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  JBPermissionIdsV6,
  buildSetPermissionsTx,
  getTokenAddress,
  isRevnetOperator,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import {
  erc20Abi,
  zeroAddress,
  zeroHash,
  type Address,
  type PublicClient,
} from 'viem'
import { usePublicClient, useReadContract } from 'wagmi'
import { AddressField } from '@/components/create/AddressField'
import { CheckRow } from '@/components/create/ui'
import {
  TransactionInProgress,
  usePreloadTransactionAnimation,
} from '@/components/TransactionInProgress'
import {
  AuthorityOverview,
  type AuthorityDeployment,
} from '@/components/project/AuthorityOverview'
import {
  AuthorityEditsCard,
  type AuthorityEditProfile,
} from '@/components/project/AuthorityEditsCard'
import { MultiChainBuybackRouterCard } from '@/components/project/MultiChainBuybackRouterCard'
import { AuthorityPowersCard } from '@/components/project/AuthorityPowersCard'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { getPermissionHolders, type BsPermissionHolder } from '@/lib/bendystraw'
import { resolvedAddress } from '@/lib/ens'
import { truncateAddress } from '@/lib/format'
import {
  TOKEN_SYMBOL_RE,
  buildDeployTokenRequest,
  isKnownController,
} from '@/lib/manage'

/**
 * The back-office cards on the Owner/Operator tab (website/ parity:
 * renderBackOfficeSection — Account, Permissions, Token). Renders alongside
 * OwnerPanel (which keeps the metadata/token-deploy strip); this adds who
 * controls the project, the transfer/relinquish flows, the permission
 * holders list + editor, and the token deploy/rename flows. Every write
 * follows the same pattern as FundsTab: review freezes the exact args from
 * LIVE re-reads, the connected account is re-checked at confirm, and the
 * signed call goes through useSafeTx (simulate-first).
 */
export function BackOfficeTab({
  chainId,
  projectId,
  isRevnet,
  owner,
  operator,
  deployments,
  profile,
}: {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
  /** Owner per bendystraw (custom projects); can lag a transfer. */
  owner: string | null
  /** Operator per bendystraw (revnets). */
  operator: string | null
  /** Every omnichain deployment and its indexed owner/operator. */
  deployments: AuthorityDeployment[]
  /** Current pinned profile used to prefill the chain-aware metadata editor. */
  profile: AuthorityEditProfile
}) {
  usePreloadTransactionAnimation()
  return (
    <div className="space-y-5">
      <AuthorityOverview
        deployments={deployments}
        isRevnet={isRevnet}
        beforePermissions={
          <>
            <AuthorityEditsCard
              deployments={deployments}
              isRevnet={isRevnet}
              profile={profile}
            />
            {!isRevnet ? (
              <AuthorityPowersCard deployments={deployments} />
            ) : null}
            <MultiChainBuybackRouterCard
              deployments={deployments}
              isRevnet={isRevnet}
            />
          </>
        }
      />
    </div>
  )
}

// ------------------------------------------------------------- shared bits --

const etherscanHostOf = (chainId: JBChainId) =>
  JB_CHAINS[chainId]?.etherscanHostname

function etherscanTx(
  chainId: JBChainId,
  hash: `0x${string}` | null,
): string | null {
  const host = etherscanHostOf(chainId)
  return hash && host ? `https://${host}/tx/${hash}` : null
}

function EtherscanAddress({
  chainId,
  address,
  className = 'font-mono text-sm text-ink hover:underline',
}: {
  chainId: JBChainId
  address: string
  className?: string
}) {
  const host = etherscanHostOf(chainId)
  const label = truncateAddress(address)
  if (!host) return <span className={className}>{label}</span>
  return (
    <a
      href={`https://${host}/address/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {label}
    </a>
  )
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </p>
  )
}

/** The explicit tick-to-arm gate every danger action requires. */
function DangerAck({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled: boolean
  children: React.ReactNode
}) {
  return (
    <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg border border-red-300 bg-red-50 px-3.5 py-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 shrink-0 accent-red-600"
      />
      <span className="text-xs leading-relaxed text-red-700">{children}</span>
    </label>
  )
}

function TxDone({
  chainId,
  hash,
  message,
  onDone,
}: {
  chainId: JBChainId
  hash: `0x${string}` | null
  message: string
  onDone: () => void
}) {
  const url = etherscanTx(chainId, hash)
  return (
    <div className="rounded-xl border border-smoke-200 p-4">
      <p className="text-sm font-medium text-ink">{message}</p>
      <div className="mt-2 flex gap-3 text-sm font-semibold">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
          >
            View transaction
          </a>
        ) : null}
        <button onClick={onDone} className="text-smoke-700 hover:text-ink">
          Done
        </button>
      </div>
    </div>
  )
}

function PendingNote({
  chainId,
  hash,
}: {
  chainId: JBChainId
  hash: `0x${string}` | null
}) {
  const url = etherscanTx(chainId, hash)
  if (!url) return null
  return (
    <TransactionInProgress className="mt-3">
      Waiting for confirmation —{' '}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2"
      >
        view transaction
      </a>
    </TransactionInProgress>
  )
}

/** A validation failure with copy that's already user-ready. */
class FlowError extends Error {}

/** Trim a raw read/simulation error down to its useful first line. */
function shortError(e: unknown): string {
  if (e instanceof FlowError) return e.message
  if (!(e instanceof Error)) return 'Something went wrong.'
  const message =
    'shortMessage' in e && typeof e.shortMessage === 'string'
      ? e.shortMessage
      : e.message
  if (/denied|rejected/i.test(message)) return 'Transaction cancelled.'
  return message.split('\n')[0]
}

/** Phase-driven label for the single review-then-confirm button. */
function actionLabel(args: {
  checking: boolean
  phase: string
  hasReview: boolean
  idle: string
  confirm: string
}): string {
  if (args.checking) return 'Checking onchain state…'
  if (args.phase === 'simulating') return 'Double-checking the transaction…'
  if (args.phase === 'signing') return 'Confirm in your wallet…'
  if (args.phase === 'pending') return 'Sending…'
  return args.hasReview ? args.confirm : args.idle
}

const txBusy = (phase: string) =>
  phase === 'simulating' || phase === 'signing' || phase === 'pending'

// ------------------------------------------------------------ account card --

function AccountCard({
  chainId,
  projectId,
  isRevnet,
  authority,
  isOwner,
  isOperator,
}: {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
  authority: Address | null
  isOwner: boolean
  isOperator: boolean
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined

  // Bytecode probe (custom): empty code means a plain wallet controls the
  // project; anything else is a contract — often a Safe.
  const { data: code, isFetched: codeFetched } = useQuery({
    queryKey: ['accountCode', chainId, authority],
    enabled: !isRevnet && !!authority && !!publicClient,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: () => publicClient!.getCode({ address: authority! }),
  })
  const accountKind = !isRevnet && authority && codeFetched
    ? code && code !== '0x'
      ? 'Contract — maybe a Safe'
      : 'Wallet (EOA)'
    : null

  return (
    <section className="card p-5">
      <span className="field-label">Account</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        {isRevnet
          ? 'Revnets have no owner — the rules were locked in at launch. The operator holds only the powers granted then, like managing splits, and can pass the role on.'
          : 'The account below owns this project and controls its rules, its funds, and everything on this page.'}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        {authority ? (
          <EtherscanAddress chainId={chainId} address={authority} />
        ) : (
          <span className="text-sm text-smoke-500">
            {isRevnet ? 'No operator' : 'Unknown'}
          </span>
        )}
        {accountKind ? (
          <span className="chip bg-smoke-100 text-[11px] text-smoke-700">
            {accountKind}
          </span>
        ) : null}
        {isRevnet && authority ? (
          <span className="chip bg-smoke-100 text-[11px] text-smoke-700">
            Operator
          </span>
        ) : null}
      </div>

      {isOwner ? (
        <TransferOwnershipFlow chainId={chainId} projectId={projectId} />
      ) : null}
      {isOperator ? (
        <SetOperatorFlow chainId={chainId} projectId={projectId} />
      ) : null}
    </section>
  )
}

/** Tx 36: JBProjects.transferFrom(owner, newOwner, projectId) — the project
 *  NFT is ownership, so this hands over everything. Owner-only. */
function TransferOwnershipFlow({
  chainId,
  projectId,
}: {
  chainId: JBChainId
  projectId: number
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { address } = useWallet()
  const tx = useSafeTx(chainId)

  const [open, setOpen] = useState(false)
  const [to, setTo] = useState('')
  const [checking, setChecking] = useState(false)
  const [ack, setAck] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [review, setReview] = useState<{
    from: Address
    to: Address
    account: Address
  } | null>(null)

  const projects = jbContractAddress['6'][JBCoreContracts.JBProjects][
    chainId
  ] as Address
  const busy = checking || txBusy(tx.phase)

  const closeAndReset = () => {
    setOpen(false)
    setTo('')
    setAck(false)
    setReview(null)
    setFlowError(null)
    tx.reset()
  }

  const handleReview = async () => {
    if (!publicClient || !address || busy) return
    setFlowError(null)
    const dest = resolvedAddress(to)
    if (!dest) {
      setFlowError('Enter a valid address or ENS name.')
      return
    }
    if (dest === zeroAddress) {
      setFlowError('You cannot transfer to the zero address.')
      return
    }
    setChecking(true)
    try {
      // LIVE re-read: the NFT may have moved since the page loaded.
      const liveOwner = (await publicClient.readContract({
        abi: jbProjectsAbi,
        address: projects,
        functionName: 'ownerOf',
        args: [BigInt(projectId)],
      })) as Address
      if (liveOwner.toLowerCase() !== address.toLowerCase()) {
        throw new FlowError('Your wallet no longer owns this project.')
      }
      if (dest.toLowerCase() === liveOwner.toLowerCase()) {
        throw new FlowError('That address already owns this project.')
      }
      setReview({ from: liveOwner, to: dest, account: address })
    } catch (e) {
      setFlowError(shortError(e))
    } finally {
      setChecking(false)
    }
  }

  const handleConfirm = () => {
    if (!review || !ack || busy) return
    // Account-unchanged recheck: the frozen args embed the from address.
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      setReview(null)
      setAck(false)
      setFlowError('Your connected account changed — review again.')
      return
    }
    tx.send({
      chainId,
      address: projects,
      abi: jbProjectsAbi,
      functionName: 'transferFrom',
      args: [review.from, review.to, BigInt(projectId)],
    })
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-4 min-h-[40px] rounded-xl border border-red-300 px-4 text-sm font-medium text-red-700 transition-colors hover:bg-red-50"
      >
        Transfer ownership
      </button>
    )
  }

  if (tx.phase === 'success') {
    return (
      <div className="mt-4">
        <TxDone
          chainId={chainId}
          hash={tx.hash}
          message="Ownership transferred. This page picks it up in about a minute."
          onDone={closeAndReset}
        />
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-xl border border-red-200 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-ink">Transfer ownership</span>
        <button
          onClick={closeAndReset}
          disabled={busy}
          className="text-xs font-medium text-smoke-700 hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      <label className="mt-3 block">
        <span className="field-label">New owner</span>
        <div className="mt-1.5">
          <AddressField
            value={to}
            onChange={value => {
              setTo(value)
              setReview(null)
              setAck(false)
              setFlowError(null)
            }}
            disabled={busy}
            ariaLabel="New owner address"
          />
        </div>
      </label>

      {review ? (
        <div className="callout callout-warning mt-3 text-xs">
          <p>
            Project #{projectId} moves from{' '}
            <span className="font-mono">{truncateAddress(review.from)}</span> to{' '}
            <span className="font-mono">{truncateAddress(review.to)}</span>. The
            new owner gets everything — the rules, the funds access, this whole
            page.
          </p>
        </div>
      ) : null}

      {review ? (
        <DangerAck checked={ack} onChange={setAck} disabled={busy}>
          I understand this hands over the whole project. There is no undo —
          only the new owner could give it back.
        </DangerAck>
      ) : null}

      <button
        onClick={review ? handleConfirm : handleReview}
        disabled={busy || !to.trim() || (!!review && !ack)}
        className="btn-primary mt-3 min-h-[44px] w-full text-sm"
      >
        {actionLabel({
          checking,
          phase: tx.phase,
          hasReview: !!review,
          idle: 'Review transfer',
          confirm: 'Transfer the project',
        })}
      </button>

      {tx.phase === 'pending' ? (
        <PendingNote chainId={chainId} hash={tx.hash} />
      ) : null}
      {flowError || tx.error ? (
        <ErrorNote message={flowError ?? tx.error!} />
      ) : null}
    </div>
  )
}

/** Tx 37: REVOwner.setOperatorOf(revnetId, newOperator) — the operator hands
 *  the role on. An empty or zero address relinquishes it forever (no one can
 *  set a new operator once it's gone). ABI + address from the SDK:
 *  revOwnerAbi and jbContractAddress['6'][RevnetCoreContracts.REVOwner]. */
function SetOperatorFlow({
  chainId,
  projectId,
}: {
  chainId: JBChainId
  projectId: number
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { address } = useWallet()
  const tx = useSafeTx(chainId)

  const [open, setOpen] = useState(false)
  const [to, setTo] = useState('')
  const [checking, setChecking] = useState(false)
  const [ack, setAck] = useState(false)
  const [ackForever, setAckForever] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [review, setReview] = useState<{
    newOperator: Address
    relinquish: boolean
    account: Address
  } | null>(null)

  const revOwner = jbContractAddress['6'][RevnetCoreContracts.REVOwner][
    chainId
  ] as Address
  const busy = checking || txBusy(tx.phase)

  const closeAndReset = () => {
    setOpen(false)
    setTo('')
    setAck(false)
    setAckForever(false)
    setReview(null)
    setFlowError(null)
    tx.reset()
  }

  const handleReview = async () => {
    if (!publicClient || !address || busy) return
    setFlowError(null)
    // Empty input = relinquish (spec item 37: zero address gives the role up).
    const dest = to.trim() === '' ? zeroAddress : resolvedAddress(to)
    if (!dest) {
      setFlowError(
        'Enter a valid address or ENS name — or leave it empty to relinquish the role.',
      )
      return
    }
    if (dest !== zeroAddress && dest.toLowerCase() === address.toLowerCase()) {
      setFlowError('That is already your wallet — nothing would change.')
      return
    }
    setChecking(true)
    try {
      // LIVE re-read: the role may have been handed on since the page loaded.
      const stillOperator = await isRevnetOperator(publicClient, {
        chainId,
        revnetId: BigInt(projectId),
        operator: address,
      })
      if (!stillOperator) {
        throw new FlowError('Your wallet is no longer this revnet’s operator.')
      }
      setReview({
        newOperator: dest,
        relinquish: dest === zeroAddress,
        account: address,
      })
    } catch (e) {
      setFlowError(shortError(e))
    } finally {
      setChecking(false)
    }
  }

  const handleConfirm = () => {
    if (!review || !ack || busy) return
    if (review.relinquish && !ackForever) return
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      setReview(null)
      setAck(false)
      setAckForever(false)
      setFlowError('Your connected account changed — review again.')
      return
    }
    tx.send({
      chainId,
      address: revOwner,
      abi: revOwnerAbi,
      functionName: 'setOperatorOf',
      args: [BigInt(projectId), review.newOperator],
    })
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-4 min-h-[40px] rounded-xl border border-red-300 px-4 text-sm font-medium text-red-700 transition-colors hover:bg-red-50"
      >
        Hand over the operator role
      </button>
    )
  }

  if (tx.phase === 'success') {
    return (
      <div className="mt-4">
        <TxDone
          chainId={chainId}
          hash={tx.hash}
          message={
            review?.relinquish
              ? 'Operator role relinquished. This revnet now runs itself.'
              : 'Operator role handed over. This page picks it up in about a minute.'
          }
          onDone={closeAndReset}
        />
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-xl border border-red-200 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-ink">
          Hand over the operator role
        </span>
        <button
          onClick={closeAndReset}
          disabled={busy}
          className="text-xs font-medium text-smoke-700 hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      <label className="mt-3 block">
        <span className="field-label">New operator</span>
        <div className="mt-1.5">
          <AddressField
            value={to}
            onChange={value => {
              setTo(value)
              setReview(null)
              setAck(false)
              setAckForever(false)
              setFlowError(null)
            }}
            disabled={busy}
            placeholder="0x… or name.eth — empty to relinquish"
            ariaLabel="New operator address"
          />
        </div>
      </label>
      <p className="mt-1.5 text-xs text-smoke-700">
        Leave it empty to relinquish the role entirely.
      </p>

      {review ? (
        <div className="callout callout-warning mt-3 text-xs">
          {review.relinquish ? (
            <p>
              The operator role is given up — no account will hold the powers
              granted at launch, and no one can ever take the role back up.
            </p>
          ) : (
            <p>
              <span className="font-mono">
                {truncateAddress(review.newOperator)}
              </span>{' '}
              becomes the operator, holding exactly the powers granted at
              launch. Your wallet keeps nothing.
            </p>
          )}
        </div>
      ) : null}

      {review ? (
        <DangerAck checked={ack} onChange={setAck} disabled={busy}>
          I understand I am giving up the operator role. There is no undo —
          only the new operator could give it back.
        </DangerAck>
      ) : null}
      {review?.relinquish ? (
        <DangerAck checked={ackForever} onChange={setAckForever} disabled={busy}>
          I understand no one will ever hold the operator role again. This is
          permanent.
        </DangerAck>
      ) : null}

      <button
        onClick={review ? handleConfirm : handleReview}
        disabled={
          busy || (!!review && (!ack || (review.relinquish && !ackForever)))
        }
        className="btn-primary mt-3 min-h-[44px] w-full text-sm"
      >
        {actionLabel({
          checking,
          phase: tx.phase,
          hasReview: !!review,
          idle: to.trim() === '' ? 'Review relinquish' : 'Review handover',
          confirm: review?.relinquish
            ? 'Relinquish the role'
            : 'Hand over the role',
        })}
      </button>

      {tx.phase === 'pending' ? (
        <PendingNote chainId={chainId} hash={tx.hash} />
      ) : null}
      {flowError || tx.error ? (
        <ErrorNote message={flowError ?? tx.error!} />
      ) : null}
    </div>
  )
}

// -------------------------------------------------------- permissions card --

/** Permission id to SDK constant name; unknown ids show as "#N". */
const PERMISSION_NAME_BY_ID = new Map<number, string>(
  Object.entries(JBPermissionIdsV6).map(([name, id]) => [id, name]),
)
const permissionName = (id: number) => PERMISSION_NAME_BY_ID.get(id) ?? `#${id}`

/** The curated subset the edit flow exposes (ids from JBPermissionIdsV6). */
const CURATED_PERMISSIONS: { id: number; title: string; blurb: string }[] = [
  {
    id: JBPermissionIdsV6.QUEUE_RULESETS,
    title: 'Queue rulesets',
    blurb: 'Change the rules that take effect in future cycles.',
  },
  {
    id: JBPermissionIdsV6.SET_SPLIT_GROUPS,
    title: 'Edit splits',
    blurb: 'Change where payouts and reserved tokens go.',
  },
  {
    id: JBPermissionIdsV6.SET_PROJECT_URI,
    title: 'Edit project details',
    blurb: 'Update the name, logo, and description.',
  },
  {
    id: JBPermissionIdsV6.USE_ALLOWANCE,
    title: 'Use surplus allowance',
    blurb: 'Withdraw from the owner’s surplus allowance.',
  },
  {
    id: JBPermissionIdsV6.SET_TERMINALS,
    title: 'Set terminals',
    blurb: 'Change which payment terminals the project uses.',
  },
  {
    id: JBPermissionIdsV6.MINT_TOKENS,
    title: 'Mint tokens',
    blurb: 'Create new project tokens when the rules allow it.',
  },
  {
    id: JBPermissionIdsV6.BURN_TOKENS,
    title: 'Burn tokens',
    blurb: 'Destroy project tokens they hold.',
  },
  {
    id: JBPermissionIdsV6.ADJUST_721_TIERS,
    title: 'Adjust NFT tiers',
    blurb: 'Add or remove items in the shop.',
  },
]
const CURATED_IDS = new Set(CURATED_PERMISSIONS.map(p => p.id))

function PermissionsCard({
  chainId,
  projectId,
  isRevnet,
  isOwner,
  authority,
}: {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
  isOwner: boolean
  authority: Address | null
}) {
  const {
    data: holders,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['permissionHolders', chainId, projectId],
    queryFn: () => getPermissionHolders(chainId, projectId),
    staleTime: 30_000,
    retry: 1,
  })

  return (
    <section className="card p-5">
      <span className="field-label">Permissions</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        {isRevnet
          ? 'The accounts holding the permissions this revnet granted at launch — the operator role, and any extras.'
          : 'Accounts the owner has trusted with specific controls. Each one can only do what it was granted.'}
      </p>

      {isLoading ? (
        <p className="mt-3 text-sm text-smoke-500">Loading…</p>
      ) : !holders || holders.length === 0 ? (
        <p className="mt-3 text-sm text-smoke-500">
          No accounts hold permissions for this project.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-smoke-100">
          {holders.map(holder => (
            <li key={`${holder.account}-${holder.operator}`} className="py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <EtherscanAddress chainId={chainId} address={holder.operator} />
                {authority &&
                holder.account.toLowerCase() !== authority.toLowerCase() ? (
                  <span className="text-xs text-smoke-500">
                    granted by {truncateAddress(holder.account)}
                  </span>
                ) : null}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {holder.permissions.map(id => (
                  <span
                    key={id}
                    className="chip bg-smoke-100 font-mono text-[11px] text-smoke-700"
                  >
                    {permissionName(id)}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!isRevnet && isOwner ? (
        <EditPermissionsFlow
          chainId={chainId}
          projectId={projectId}
          holders={holders ?? []}
          onDone={() => refetch()}
        />
      ) : null}
    </section>
  )
}

/** Tx 38: JBPermissions.setPermissionsFor — owner grants (or revokes) a
 *  curated set of permissions to an operator. The call OVERWRITES the
 *  operator's whole permission set for this project, so review re-reads the
 *  live bitmap and carries forward any permissions this form doesn't show. */
function EditPermissionsFlow({
  chainId,
  projectId,
  holders,
  onDone,
}: {
  chainId: JBChainId
  projectId: number
  holders: BsPermissionHolder[]
  onDone: () => void
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { address } = useWallet()
  const tx = useSafeTx(chainId)

  const [open, setOpen] = useState(false)
  const [opAddr, setOpAddr] = useState('')
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [checking, setChecking] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [review, setReview] = useState<{
    operator: Address
    account: Address
    finalIds: number[]
    keptIds: number[]
    removedIds: number[]
  } | null>(null)

  const busy = checking || txBusy(tx.phase)

  const resolvedOp = useMemo(() => resolvedAddress(opAddr), [opAddr])

  // Prefill from the holders list when the typed address matches an operator
  // the connected owner already granted to. Review re-reads the live bitmap
  // anyway — this is only a convenience.
  useEffect(() => {
    if (!resolvedOp || !address) return
    const row = holders.find(
      h =>
        h.operator.toLowerCase() === resolvedOp.toLowerCase() &&
        h.account.toLowerCase() === address.toLowerCase(),
    )
    setChecked(new Set(row?.permissions.filter(id => CURATED_IDS.has(id)) ?? []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedOp])

  const closeAndReset = () => {
    setOpen(false)
    setOpAddr('')
    setChecked(new Set())
    setReview(null)
    setFlowError(null)
    tx.reset()
  }

  const invalidate = () => {
    setReview(null)
    setFlowError(null)
  }

  const handleReview = async () => {
    if (!publicClient || !address || busy) return
    setFlowError(null)
    const op = resolvedAddress(opAddr)
    if (!op || op === zeroAddress) {
      setFlowError('Enter a valid operator address or ENS name.')
      return
    }
    if (op.toLowerCase() === address.toLowerCase()) {
      setFlowError('That is your own wallet — owners already hold every power.')
      return
    }
    setChecking(true)
    try {
      // LIVE bitmap: setPermissionsFor overwrites the whole set, so anything
      // the operator holds outside the curated list must be carried forward.
      const bitmap = (await publicClient.readContract({
        abi: jbPermissionsAbi,
        address: jbContractAddress['6'][JBCoreContracts.JBPermissions][
          chainId
        ] as Address,
        functionName: 'permissionsOf',
        args: [op, address, BigInt(projectId)],
      })) as bigint
      const liveIds: number[] = []
      for (let id = 1; id <= 255; id++) {
        if ((bitmap >> BigInt(id)) & 1n) liveIds.push(id)
      }
      const keptIds = liveIds.filter(id => !CURATED_IDS.has(id))
      const grantIds = CURATED_PERMISSIONS.map(p => p.id).filter(id =>
        checked.has(id),
      )
      const removedIds = liveIds.filter(
        id => CURATED_IDS.has(id) && !checked.has(id),
      )
      const finalIds = [...new Set([...keptIds, ...grantIds])].sort(
        (a, b) => a - b,
      )
      if (finalIds.length === 0 && liveIds.length === 0) {
        throw new FlowError(
          'Pick at least one permission — this operator holds none to remove.',
        )
      }
      setReview({ operator: op, account: address, finalIds, keptIds, removedIds })
    } catch (e) {
      setFlowError(shortError(e))
    } finally {
      setChecking(false)
    }
  }

  const handleConfirm = () => {
    if (!review || busy) return
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      setReview(null)
      setFlowError('Your connected account changed — review again.')
      return
    }
    // SDK builder: address + abi from jbPermissionsAbi, exact frozen ids.
    const request = buildSetPermissionsTx({
      chainId,
      account: review.account,
      operator: review.operator,
      projectId: BigInt(projectId),
      permissionIds: review.finalIds,
    })
    tx.send(request)
  }

  useEffect(() => {
    if (tx.phase === 'success') onDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase])

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="btn-secondary mt-4 min-h-[40px] px-4 text-sm"
      >
        Edit permissions
      </button>
    )
  }

  if (tx.phase === 'success') {
    return (
      <div className="mt-4">
        <TxDone
          chainId={chainId}
          hash={tx.hash}
          message="Permissions updated."
          onDone={closeAndReset}
        />
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-xl border border-smoke-200 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-ink">Edit permissions</span>
        <button
          onClick={closeAndReset}
          disabled={busy}
          className="text-xs font-medium text-smoke-700 hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      <label className="mt-3 block">
        <span className="field-label">Operator</span>
        <div className="mt-1.5">
          <AddressField
            value={opAddr}
            onChange={value => {
              setOpAddr(value)
              invalidate()
            }}
            disabled={busy}
            ariaLabel="Operator address"
          />
        </div>
      </label>

      <div className="mt-3 space-y-2">
        {CURATED_PERMISSIONS.map(permission => (
          <CheckRow
            key={permission.id}
            checked={checked.has(permission.id)}
            onToggle={() => {
              setChecked(prev => {
                const next = new Set(prev)
                if (next.has(permission.id)) next.delete(permission.id)
                else next.add(permission.id)
                return next
              })
              invalidate()
            }}
            disabled={busy}
            title={permission.title}
            blurb={permission.blurb}
          />
        ))}
      </div>

      {review ? (
        <div className="callout callout-warning mt-3 text-xs">
          <p className="font-semibold">
            Saving replaces everything{' '}
            <span className="font-mono">
              {truncateAddress(review.operator)}
            </span>{' '}
            can do for this project with exactly this list.
          </p>
          {review.finalIds.length === 0 ? (
            <p className="mt-1">
              The list is empty — every permission this operator holds is
              removed.
            </p>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {review.finalIds.map(id => (
                <span
                  key={id}
                  className="chip bg-white font-mono text-[11px] text-smoke-700"
                >
                  {permissionName(id)}
                </span>
              ))}
            </div>
          )}
          {review.keptIds.length > 0 ? (
            <p className="mt-1.5">
              Includes {review.keptIds.length} permission
              {review.keptIds.length === 1 ? '' : 's'} granted outside this page
              ({review.keptIds.map(permissionName).join(', ')}) — kept as-is.
            </p>
          ) : null}
          {review.removedIds.length > 0 ? (
            <p className="mt-1.5">
              Removes {review.removedIds.map(permissionName).join(', ')}.
            </p>
          ) : null}
        </div>
      ) : null}

      <button
        onClick={review ? handleConfirm : handleReview}
        disabled={busy || !opAddr.trim()}
        className="btn-primary mt-3 min-h-[44px] w-full text-sm"
      >
        {actionLabel({
          checking,
          phase: tx.phase,
          hasReview: !!review,
          idle: 'Review permissions',
          confirm: 'Save permissions',
        })}
      </button>

      {tx.phase === 'pending' ? (
        <PendingNote chainId={chainId} hash={tx.hash} />
      ) : null}
      {flowError || tx.error ? (
        <ErrorNote message={flowError ?? tx.error!} />
      ) : null}
    </div>
  )
}

// -------------------------------------------------------------- token card --

/** Txs 35 + 34: deploy the project's ERC-20 (no token yet) or rename it
 *  (token deployed), via the project's RESOLVED controller — custom
 *  controllers are gated out just like OwnerPanel. Owner-only; revnets skip
 *  this card entirely (REVDeployer deployed theirs at launch). */
function TokenCard({
  chainId,
  projectId,
  isOwner,
}: {
  chainId: JBChainId
  projectId: number
  isOwner: boolean
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined

  const { data: controller } = useReadContract({
    abi: jbDirectoryAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBDirectory][chainId],
    functionName: 'controllerOf',
    args: [BigInt(projectId)],
    chainId,
    query: { enabled: isOwner, staleTime: 60_000 },
  })

  const {
    data: token,
    isLoading: tokenLoading,
    refetch: refetchToken,
  } = useQuery({
    queryKey: ['backOfficeToken', chainId, projectId],
    enabled: isOwner && !!publicClient,
    staleTime: 30_000,
    retry: 1,
    queryFn: () =>
      getTokenAddress(publicClient!, { chainId, projectId: BigInt(projectId) }),
  })

  if (!isOwner) return null

  const knownController = isKnownController(chainId, controller)

  return (
    <section className="card p-5">
      <span className="field-label">Token</span>
      {controller === undefined || tokenLoading ? (
        <p className="mt-2 text-sm text-smoke-500">Loading…</p>
      ) : !knownController ? (
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          This project uses a custom controller — token tools aren&apos;t
          available here.
        </p>
      ) : token ? (
        <RenameTokenFlow
          chainId={chainId}
          projectId={projectId}
          controller={controller as Address}
          token={token}
        />
      ) : (
        <DeployTokenFlow
          chainId={chainId}
          projectId={projectId}
          controller={controller as Address}
          onDeployed={() => refetchToken()}
        />
      )}
    </section>
  )
}

/** Tx 35: JBController.deployERC20For(projectId, name, symbol, zero salt). */
function DeployTokenFlow({
  chainId,
  projectId,
  controller,
  onDeployed,
}: {
  chainId: JBChainId
  projectId: number
  controller: Address
  onDeployed: () => void
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { address } = useWallet()
  const tx = useSafeTx(chainId)

  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [checking, setChecking] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [review, setReview] = useState<{
    name: string
    symbol: string
    account: Address
  } | null>(null)

  const busy = checking || txBusy(tx.phase)
  const symbolOk = TOKEN_SYMBOL_RE.test(symbol)

  useEffect(() => {
    if (tx.phase === 'success') onDeployed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase])

  const handleReview = async () => {
    if (!publicClient || !address || busy) return
    setFlowError(null)
    if (!name.trim()) {
      setFlowError('Give your token a name.')
      return
    }
    if (!symbolOk) {
      setFlowError('Symbols are 1 to 8 uppercase letters or digits.')
      return
    }
    setChecking(true)
    try {
      // LIVE re-read: someone with DEPLOY_ERC20 may have beaten us to it.
      const liveToken = await getTokenAddress(publicClient, {
        chainId,
        projectId: BigInt(projectId),
      })
      if (liveToken) {
        throw new FlowError('This project already has its ERC-20 deployed.')
      }
      setReview({ name: name.trim(), symbol, account: address })
    } catch (e) {
      setFlowError(shortError(e))
    } finally {
      setChecking(false)
    }
  }

  const handleConfirm = () => {
    if (!review || busy) return
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      setReview(null)
      setFlowError('Your connected account changed — review again.')
      return
    }
    // Zero salt per spec item 35 (non-deterministic address); the resolved
    // controller is the frozen target.
    const request = buildDeployTokenRequest({
      chainId,
      projectId: BigInt(projectId),
      name: review.name,
      symbol: review.symbol,
      salt: zeroHash,
      controller,
    })
    tx.send(request)
  }

  if (tx.phase === 'success') {
    return (
      <div className="mt-3">
        <TxDone
          chainId={chainId}
          hash={tx.hash}
          message="Token deployed — supporters can now claim their tokens."
          onDone={() => tx.reset()}
        />
      </div>
    )
  }

  return (
    <div>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        No ERC-20 yet — supporters&apos; balances are internal credits. Deploy
        one and they become a real token holders can claim and move.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-[1fr_9rem]">
        <label className="block">
          <span className="field-label">Token name</span>
          <input
            type="text"
            value={name}
            onChange={e => {
              setName(e.target.value.slice(0, 100))
              setReview(null)
              setFlowError(null)
            }}
            disabled={busy}
            className="input-well mt-1.5 min-h-[44px] w-full px-4 text-sm font-medium disabled:opacity-60"
          />
        </label>
        <label className="block">
          <span className="field-label">Symbol</span>
          <input
            type="text"
            value={symbol}
            onChange={e => {
              setSymbol(
                e.target.value
                  .toUpperCase()
                  .replace(/[^A-Z0-9]/g, '')
                  .slice(0, 8),
              )
              setReview(null)
              setFlowError(null)
            }}
            disabled={busy}
            placeholder="JUICE"
            aria-label="Token symbol, 1 to 8 uppercase characters"
            className="input-well mt-1.5 min-h-[44px] w-full px-4 text-sm font-medium uppercase tracking-wider disabled:opacity-60"
          />
        </label>
      </div>

      {review ? (
        <div className="callout callout-info mt-3 text-xs">
          <p>
            Deploys <span className="font-medium">{review.name}</span> (
            {review.symbol}). Existing balances carry over — nothing changes
            for supporters until they choose to claim.
          </p>
        </div>
      ) : null}

      <button
        onClick={review ? handleConfirm : handleReview}
        disabled={busy || !symbolOk || !name.trim()}
        className="btn-primary mt-3 min-h-[44px] w-full text-sm"
      >
        {actionLabel({
          checking,
          phase: tx.phase,
          hasReview: !!review,
          idle: 'Review deploy',
          confirm: symbol ? `Deploy ${symbol}` : 'Deploy token',
        })}
      </button>

      {tx.phase === 'pending' ? (
        <PendingNote chainId={chainId} hash={tx.hash} />
      ) : null}
      {flowError || tx.error ? (
        <ErrorNote message={flowError ?? tx.error!} />
      ) : null}
    </div>
  )
}

/** Tx 34: JBController.setTokenMetadataOf(projectId, name, symbol) — rename
 *  the deployed ERC-20 (verified against jbControllerAbi). */
function RenameTokenFlow({
  chainId,
  projectId,
  controller,
  token,
}: {
  chainId: JBChainId
  projectId: number
  controller: Address
  token: Address
}) {
  const { address } = useWallet()
  const tx = useSafeTx(chainId)

  const { data: currentName } = useReadContract({
    abi: erc20Abi,
    address: token,
    functionName: 'name',
    chainId,
    query: { staleTime: 60_000 },
  })
  const { data: currentSymbol } = useReadContract({
    abi: erc20Abi,
    address: token,
    functionName: 'symbol',
    chainId,
    query: { staleTime: 60_000 },
  })

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [flowError, setFlowError] = useState<string | null>(null)
  const [review, setReview] = useState<{
    name: string
    symbol: string
    account: Address
  } | null>(null)

  const busy = txBusy(tx.phase)
  const symbolOk = TOKEN_SYMBOL_RE.test(symbol)

  const openForm = () => {
    setName(currentName ?? '')
    setSymbol(currentSymbol ?? '')
    setOpen(true)
  }

  const closeAndReset = () => {
    setOpen(false)
    setReview(null)
    setFlowError(null)
    tx.reset()
  }

  const handleReview = () => {
    if (!address || busy) return
    setFlowError(null)
    if (!name.trim()) {
      setFlowError('Give your token a name.')
      return
    }
    if (!symbolOk) {
      setFlowError('Symbols are 1 to 8 uppercase letters or digits.')
      return
    }
    setReview({ name: name.trim(), symbol, account: address })
  }

  const handleConfirm = () => {
    if (!review || busy) return
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      setReview(null)
      setFlowError('Your connected account changed — review again.')
      return
    }
    tx.send({
      chainId,
      address: controller,
      abi: jbControllerAbi,
      functionName: 'setTokenMetadataOf',
      args: [BigInt(projectId), review.name, review.symbol],
    })
  }

  return (
    <div>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        {currentSymbol ? (
          <span className="mr-2 font-medium text-melon-700">
            {currentSymbol}
          </span>
        ) : null}
        Supporters&apos; tokens are a claimable ERC-20:{' '}
        <EtherscanAddress
          chainId={chainId}
          address={token}
          className="font-mono text-sm text-ink hover:underline"
        />
      </p>

      {!open ? (
        <button
          onClick={openForm}
          className="btn-secondary mt-3 min-h-[40px] px-4 text-sm"
        >
          Rename token
        </button>
      ) : tx.phase === 'success' ? (
        <div className="mt-3">
          <TxDone
            chainId={chainId}
            hash={tx.hash}
            message="Token renamed. Wallets and explorers pick it up on their own schedules."
            onDone={closeAndReset}
          />
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-smoke-200 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-ink">Rename token</span>
            <button
              onClick={closeAndReset}
              disabled={busy}
              className="text-xs font-medium text-smoke-700 hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-[1fr_9rem]">
            <label className="block">
              <span className="field-label">Token name</span>
              <input
                type="text"
                value={name}
                onChange={e => {
                  setName(e.target.value.slice(0, 100))
                  setReview(null)
                  setFlowError(null)
                }}
                disabled={busy}
                className="input-well mt-1.5 min-h-[44px] w-full px-4 text-sm font-medium disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="field-label">Symbol</span>
              <input
                type="text"
                value={symbol}
                onChange={e => {
                  setSymbol(
                    e.target.value
                      .toUpperCase()
                      .replace(/[^A-Z0-9]/g, '')
                      .slice(0, 8),
                  )
                  setReview(null)
                  setFlowError(null)
                }}
                disabled={busy}
                aria-label="Token symbol, 1 to 8 uppercase characters"
                className="input-well mt-1.5 min-h-[44px] w-full px-4 text-sm font-medium uppercase tracking-wider disabled:opacity-60"
              />
            </label>
          </div>

          {review ? (
            <div className="callout callout-info mt-3 text-xs">
              <p>
                The token becomes{' '}
                <span className="font-medium">{review.name}</span> (
                {review.symbol}). The contract address and every balance stay
                exactly the same.
              </p>
            </div>
          ) : null}

          <button
            onClick={review ? handleConfirm : handleReview}
            disabled={busy || !symbolOk || !name.trim()}
            className="btn-primary mt-3 min-h-[44px] w-full text-sm"
          >
            {actionLabel({
              checking: false,
              phase: tx.phase,
              hasReview: !!review,
              idle: 'Review rename',
              confirm: 'Rename token',
            })}
          </button>

          {tx.phase === 'pending' ? (
            <PendingNote chainId={chainId} hash={tx.hash} />
          ) : null}
          {flowError || tx.error ? (
            <ErrorNote message={flowError ?? tx.error!} />
          ) : null}
        </div>
      )}
    </div>
  )
}
