'use client'

import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import type { AuthorityDeployment } from '@/components/project/AuthorityOverview'
import { ErrorNote } from '@/components/ui/TxError'
import { useWallet } from '@/hooks/useWallet'
import {
  clientFor,
  readAuthorityOf,
  runAuthorityCalls,
  safeOutcomeMessage,
} from '@/lib/authority'
import {
  PROJECT_HANDLES_CHAIN_ID,
  PROJECT_HANDLE_RESOLVER_WRITE_GAS,
  PROJECT_HANDLE_TEXT_KEY,
  PROJECT_HANDLE_WRITE_GAS,
  buildSetEnsProjectRecordCall,
  buildSetProjectHandleCall,
  continueProjectHandleSetup,
  normalizeProjectHandle,
  navigateToProjectHandle,
  projectHandleRecord,
  projectHandleSetupPhase,
  readBoundedProjectHandle,
  readBoundedProjectHandleParts,
  readDirectEnsProjectRecord,
} from '@/lib/project-handles'
import { simulateStateChangingTransaction } from '@/lib/transaction-simulation'
import { revnetOperatorFromPermissionHistory } from '@/lib/project-fallback'
import {
  deploySafeSameAddress,
  fetchSafeCreation,
  safeQueueLink,
} from '@/lib/safe'
import {
  isDeployableSafeAuthority,
  readMatchingAuthorityIdentities,
  safeCreationMatchesAuthorityIdentity,
} from '@/lib/cross-chain-authority'

type ProjectHandleState = {
  authority: Address | null
  claimedHandle: string | null
  verifiedHandle: string | null
  textRecord: string | null
}

class EnsRecordCompletedExternally extends Error {}
class HandleClaimCompletedExternally extends Error {}

const DEFAULT_SITE_ORIGIN = (
  process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001'
).replace(/\/+$/u, '')

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Something went wrong.'
}

function hasUnexecutedSafeCall(
  result: Awaited<ReturnType<typeof runAuthorityCalls>>,
): boolean {
  return result.safeResults.some(row => row.status !== 'executed')
}

function dedupeAddresses(addresses: readonly Address[]): Address[] {
  const seen = new Set<string>()
  return addresses.filter(address => {
    const key = address.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function readHandleAuthorityIdentities(
  deployment: AuthorityDeployment,
  authority: Address,
) {
  if (deployment.chainId === PROJECT_HANDLES_CHAIN_ID) return null
  return readMatchingAuthorityIdentities({
    sourceClient: clientFor(deployment.chainId),
    destinationClient: clientFor(PROJECT_HANDLES_CHAIN_ID),
    authority,
  })
}

async function readProjectHandleState(
  deployment: AuthorityDeployment,
  revnetOperatorCandidates: readonly Address[],
): Promise<ProjectHandleState> {
  const authority = await readAuthorityOf(clientFor(deployment.chainId), deployment, {
    detectRevnet: true,
    indexedCandidates: revnetOperatorCandidates,
    strict: true,
  })
  if (!authority) {
    return {
      authority: null,
      claimedHandle: null,
      verifiedHandle: null,
      textRecord: null,
    }
  }

  const registry = clientFor(PROJECT_HANDLES_CHAIN_ID)
  const [parts, verified] = await Promise.all([
    readBoundedProjectHandleParts(registry, {
      chainId: deployment.chainId,
      projectId: deployment.projectId,
      setter: authority,
    }),
    readBoundedProjectHandle(registry, {
      chainId: deployment.chainId,
      projectId: deployment.projectId,
      setter: authority,
    }),
  ])
  const claimed = parts
    ? normalizeProjectHandle([...parts].reverse().join('.'))
    : null
  const verifiedHandle = verified
  const textRecord = claimed
    ? (await readDirectEnsProjectRecord(registry, claimed.ensName)).textRecord
    : null
  return {
    authority,
    claimedHandle: claimed?.handle ?? null,
    verifiedHandle,
    textRecord,
  }
}

async function readProjectHandleStateWithPermissionHistory(
  deployment: AuthorityDeployment,
  revnetOperatorCandidates: readonly Address[],
): Promise<ProjectHandleState> {
  const fast = await readProjectHandleState(
    deployment,
    revnetOperatorCandidates,
  )
  if (fast.authority) return fast
  const permissionOperator = await revnetOperatorFromPermissionHistory({
    chainId: deployment.chainId,
    projectId: deployment.projectId,
  })
  return permissionOperator
    ? readProjectHandleState(
        deployment,
        dedupeAddresses([...revnetOperatorCandidates, permissionOperator]),
      )
    : fast
}

/**
 * Owner/Operator handle editor. A user-chosen ENS record names exactly this
 * viewed chain/project tuple; sibling deployments are never silently batched.
 */
export function ProjectHandleCard({
  deployment,
  isRevnet,
  revnetOperatorCandidates = [],
}: {
  deployment: AuthorityDeployment
  isRevnet: boolean
  revnetOperatorCandidates?: readonly Address[]
}) {
  const { address, openSignIn } = useWallet()
  const liveOperatorCandidates = useMemo(
    () =>
      dedupeAddresses([
        ...revnetOperatorCandidates,
        ...(address ? [address] : []),
      ]),
    [address, revnetOperatorCandidates],
  )
  const stateQuery = useQuery({
    queryKey: [
      'projectHandle',
      deployment.chainId,
      deployment.projectId,
      deployment.indexedAuthority,
      liveOperatorCandidates.join(','),
      isRevnet,
    ],
    staleTime: 30_000,
    retry: 1,
    queryFn: () =>
      readProjectHandleStateWithPermissionHistory(
        deployment,
        liveOperatorCandidates,
      ),
  })
  const [editing, setEditing] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState<'ens' | 'claim' | 'safe' | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingSafe, setPendingSafe] = useState<Address | null>(null)
  const [siteOrigin, setSiteOrigin] = useState(DEFAULT_SITE_ORIGIN)
  const normalized = useMemo(() => normalizeProjectHandle(input), [input])
  const expectedRecord = projectHandleRecord(
    deployment.chainId,
    deployment.projectId,
  )

  const previewQuery = useQuery({
    queryKey: ['projectHandlePreview', normalized?.ensName, expectedRecord],
    enabled: editing && !!normalized,
    staleTime: 15_000,
    retry: 1,
    queryFn: async () => {
      const client = clientFor(PROJECT_HANDLES_CHAIN_ID)
      return readDirectEnsProjectRecord(client, normalized!.ensName)
    },
  })
  const safeDeploymentQuery = useQuery({
    queryKey: [
      'projectHandleSafeDeployment',
      deployment.chainId,
      stateQuery.data?.authority,
    ],
    enabled:
      editing &&
      deployment.chainId !== PROJECT_HANDLES_CHAIN_ID &&
      !!stateQuery.data?.authority,
    staleTime: 15_000,
    retry: 1,
    queryFn: async () => {
      const authority = stateQuery.data!.authority!
      const identities = await readHandleAuthorityIdentities(
        deployment,
        authority,
      )
      if (!identities) {
        throw new Error('Could not verify the cross-chain authority policy.')
      }
      return identities
    },
  })

  useEffect(() => {
    if (!editing) return
    setInput(stateQuery.data?.claimedHandle ?? '')
  }, [editing, stateQuery.data?.claimedHandle])

  useEffect(() => {
    if (typeof window !== 'undefined') setSiteOrigin(window.location.origin)
  }, [])

  const openEditor = () => {
    setError(null)
    setProgress(null)
    setInput(stateQuery.data?.claimedHandle ?? '')
    setEditing(true)
  }

  const setEnsRecord = async (): Promise<boolean> => {
    if (!normalized) {
      setError('Enter a valid ENS name ending in .eth.')
      return false
    }
    if (!address) {
      openSignIn()
      return false
    }
    setBusy('ens')
    setError(null)
    setProgress('Checking the ENS resolver…')
    try {
      const client = clientFor(PROJECT_HANDLES_CHAIN_ID)
      const currentState = await readDirectEnsProjectRecord(
        client,
        normalized.ensName,
      )
      const resolver = currentState.resolver
      if (!resolver) {
        throw new Error(
          `${normalized.ensName} has no resolver. Set one in the ENS manager before adding its Juicebox record.`,
        )
      }
      const current = currentState.textRecord
      if (current === expectedRecord) {
        setPendingSafe(null)
        setProgress('ENS record already matches this project.')
        await previewQuery.refetch()
        return true
      }

      const request = buildSetEnsProjectRecordCall({
        resolver,
        ensName: normalized.ensName,
        chainId: deployment.chainId,
        projectId: deployment.projectId,
      })
      // Registry/NameWrapper ownership is the Safe-aware default, but custom
      // resolvers can authorize delegates. Let the connected account prove
      // that exact permission with a setText simulation before falling back
      // to the nominal ENS controller.
      let writeAuthority = currentState.controller
      try {
        await simulateStateChangingTransaction(client, {
          from: address,
          to: request.target,
          data: request.data,
          gas: PROJECT_HANDLE_RESOLVER_WRITE_GAS,
        })
        writeAuthority = address
      } catch {
        // Not a direct resolver delegate; use the ENS controller path below.
      }
      if (!writeAuthority) {
        throw new Error(
          `Neither the connected account nor a readable owner can update ${normalized.ensName}. Use the ENS manager to review resolver permissions.`,
        )
      }
      const reverifyEnsAuthority = async () => {
        const latest = await readDirectEnsProjectRecord(
          client,
          normalized.ensName,
        )
        if (latest.textRecord === expectedRecord) {
          throw new EnsRecordCompletedExternally()
        }
        if (
          !latest.resolver ||
          latest.resolver.toLowerCase() !== request.target.toLowerCase()
        ) {
          throw new Error(
            'The ENS resolver changed. Review the record update again.',
          )
        }
        await simulateStateChangingTransaction(client, {
          from: writeAuthority,
          to: request.target,
          data: request.data,
          gas: PROJECT_HANDLE_RESOLVER_WRITE_GAS,
        })
      }
      const result = await runAuthorityCalls({
        calls: [
          {
            chainId: PROJECT_HANDLES_CHAIN_ID,
            authority: writeAuthority,
            target: request.target,
            data: request.data,
            gas: PROJECT_HANDLE_RESOLVER_WRITE_GAS,
            abi: request.abi,
            functionName: request.functionName,
            args: request.args,
            contractName: 'ENS resolver',
            label: `Set ${PROJECT_HANDLE_TEXT_KEY} record`,
            reverifyAuthority: reverifyEnsAuthority,
          },
        ],
        onProgress: update => setProgress(update.message),
      })
      if (hasUnexecutedSafeCall(result)) {
        setPendingSafe(writeAuthority)
        setProgress(
          safeOutcomeMessage(result, 'ENS record updated.', {
            instruction:
              'Complete it in Safe, then return here and use Resume handle setup.',
          }),
        )
        await previewQuery.refetch()
        return false
      }
      const confirmed = await readDirectEnsProjectRecord(
        client,
        normalized.ensName,
      )
      if (confirmed.textRecord !== expectedRecord) {
        throw new Error(
          `The transaction completed, but the exact resolver still does not return ${PROJECT_HANDLE_TEXT_KEY}=${expectedRecord}.`,
        )
      }
      setPendingSafe(null)
      setProgress('ENS record updated and verified onchain.')
      await previewQuery.refetch()
      return true
    } catch (reason) {
      if (reason instanceof EnsRecordCompletedExternally) {
        setPendingSafe(null)
        setProgress('ENS record was completed externally and is verified onchain.')
        await previewQuery.refetch()
        return true
      }
      setError(errorMessage(reason))
      return false
    } finally {
      setBusy(null)
    }
  }

  const publishHandle = async (): Promise<boolean> => {
    if (!normalized) {
      setError('Enter a valid ENS name ending in .eth.')
      return false
    }
    if (!address) {
      openSignIn()
      return false
    }
    setBusy('claim')
    setError(null)
    setProgress('Rechecking the ENS record and project authority…')
    try {
      const [live, textRecord] = await Promise.all([
        readProjectHandleStateWithPermissionHistory(
          deployment,
          liveOperatorCandidates,
        ),
        readDirectEnsProjectRecord(
          clientFor(PROJECT_HANDLES_CHAIN_ID),
          normalized.ensName,
        ).then(record => record.textRecord),
      ])
      if (textRecord !== expectedRecord) {
        throw new Error(
          `Set ${PROJECT_HANDLE_TEXT_KEY} to ${expectedRecord} on ${normalized.ensName} first.`,
        )
      }
      if (!live.authority) {
        throw new Error(
          `Could not verify the current ${isRevnet ? 'operator' : 'owner'}.`,
        )
      }

      if (live.verifiedHandle === normalized.handle) {
        const identities = await readHandleAuthorityIdentities(
          deployment,
          live.authority,
        )
        if (
          deployment.chainId !== PROJECT_HANDLES_CHAIN_ID &&
          (!identities || !identities.matches)
        ) {
          throw new Error(
            'The handle claim exists, but source-chain and Ethereum control of the authority no longer match.',
          )
        }
        setPendingSafe(null)
        setProgress(`@${normalized.handle} is already verified onchain.`)
        await Promise.all([stateQuery.refetch(), previewQuery.refetch()])
        return true
      }

      const request = buildSetProjectHandleCall({
        chainId: deployment.chainId,
        projectId: deployment.projectId,
        parts: normalized.parts,
      })
      const reverifyProjectHandleAuthority = async () => {
        const [current, currentRecord] = await Promise.all([
          readProjectHandleStateWithPermissionHistory(
            deployment,
            liveOperatorCandidates,
          ),
          readDirectEnsProjectRecord(
            clientFor(PROJECT_HANDLES_CHAIN_ID),
            normalized.ensName,
          ).then(record => record.textRecord),
        ])
        if (
          !current.authority ||
          current.authority.toLowerCase() !== live.authority!.toLowerCase()
        ) {
          throw new Error(
            `The current ${isRevnet ? 'operator' : 'owner'} changed. Review the handle claim again.`,
          )
        }
        if (currentRecord !== expectedRecord) {
          throw new Error(
            `The ENS ${PROJECT_HANDLE_TEXT_KEY} record changed. Review the handle claim again.`,
          )
        }
        if (current.verifiedHandle === normalized.handle) {
          const identities = await readHandleAuthorityIdentities(
            deployment,
            current.authority,
          )
          if (
            deployment.chainId !== PROJECT_HANDLES_CHAIN_ID &&
            (!identities || !identities.matches)
          ) {
            throw new Error(
              'The handle claim completed, but source-chain and Ethereum control of the authority no longer match.',
            )
          }
          throw new HandleClaimCompletedExternally()
        }
      }
      const result = await runAuthorityCalls({
        calls: [
          {
            chainId: PROJECT_HANDLES_CHAIN_ID,
            detectionChainId: deployment.chainId,
            authority: live.authority,
            target: request.target,
            data: request.data,
            gas: PROJECT_HANDLE_WRITE_GAS,
            abi: request.abi,
            functionName: request.functionName,
            args: request.args,
            contractName: 'JBProjectHandles',
            label: `Publish @${normalized.handle}`,
            reverifyAuthority: reverifyProjectHandleAuthority,
          },
        ],
        onProgress: update => setProgress(update.message),
      })
      if (hasUnexecutedSafeCall(result)) {
        setPendingSafe(live.authority)
        setProgress(
          safeOutcomeMessage(result, `@${normalized.handle} is now verified.`, {
            instruction:
              'Complete it in Safe, then return here and use Resume handle setup.',
          }),
        )
        await Promise.all([stateQuery.refetch(), previewQuery.refetch()])
        return false
      }
      setPendingSafe(null)
      const confirmed = await readProjectHandleStateWithPermissionHistory(
        deployment,
        liveOperatorCandidates,
      )
      if (confirmed.verifiedHandle !== normalized.handle) {
        throw new Error(
          `The transaction completed, but the current project authority's exact canonical handle is not @${normalized.handle}.`,
        )
      }
      if (confirmed.authority) {
        const identities = await readHandleAuthorityIdentities(
          deployment,
          confirmed.authority,
        )
        if (
          deployment.chainId !== PROJECT_HANDLES_CHAIN_ID &&
          (!identities || !identities.matches)
        ) {
          throw new Error(
            'The handle was published, but source-chain and Ethereum control of the authority no longer match.',
          )
        }
      }
      setProgress(`@${normalized.handle} is now verified onchain.`)
      await Promise.all([stateQuery.refetch(), previewQuery.refetch()])
      return true
    } catch (reason) {
      if (reason instanceof HandleClaimCompletedExternally) {
        setPendingSafe(null)
        setProgress(`@${normalized.handle} was completed externally and is verified onchain.`)
        await Promise.all([stateQuery.refetch(), previewQuery.refetch()])
        return true
      }
      setError(errorMessage(reason))
      return false
    } finally {
      setBusy(null)
    }
  }

  const saveHandle = async () => {
    // Re-read and complete the ENS half even when the preview is stale. Only a
    // confirmed exact record advances to the independently authorized project
    // claim. A queued Safe step returns false, so the same button can resume
    // after execution without submitting the second write prematurely.
    await continueProjectHandleSetup({
      ensureEnsRecord: setEnsRecord,
      ensureAuthorityClaim: publishHandle,
    })
  }

  const deployMainnetSafe = async () => {
    if (!address) {
      openSignIn()
      return
    }
    const authority = stateQuery.data?.authority
    if (!authority) {
      setError('Could not verify the current project authority.')
      return
    }
    setBusy('safe')
    setError(null)
    setProgress('Rechecking the project Safe…')
    try {
      const before = await readHandleAuthorityIdentities(deployment, authority)
      if (!before || before.source.kind !== 'safe') {
        throw new Error(
          'The current project authority is no longer readable as a Safe.',
        )
      }
      if (!isDeployableSafeAuthority(before.source)) {
        throw new Error(
          'This Safe cannot be replayed automatically: its owners must be EOAs and its guard and module list must be empty.',
        )
      }
      if (
        !before.source.owners.some(
          owner => owner.toLowerCase() === address.toLowerCase(),
        )
      ) {
        throw new Error(`Switch to a signer of the project Safe ${authority}.`)
      }
      if (before.destination.kind === 'safe' && before.matches) {
        setProgress('The same-address Safe is already deployed on Ethereum.')
        await safeDeploymentQuery.refetch()
        return
      }
      if (before.destination.kind !== 'eoa') {
        throw new Error(
          'The same address on Ethereum is already a different contract and cannot be deployed as this project Safe.',
        )
      }
      setProgress('Reading the Safe’s canonical creation…')
      const creation = await fetchSafeCreation(authority, deployment.chainId)
      if (!creation) {
        throw new Error('Could not read the Safe’s canonical creation config.')
      }
      if (!safeCreationMatchesAuthorityIdentity(creation, before.source)) {
        throw new Error(
          'This Safe’s original initializer no longer matches its current owners, threshold, fallback handler, or supported implementation. Deploy and align the Ethereum Safe in Safe before publishing.',
        )
      }
      setProgress('Deploying the same Safe address on Ethereum…')
      await deploySafeSameAddress(
        PROJECT_HANDLES_CHAIN_ID,
        creation,
        authority,
        {
          sourceChainId: deployment.chainId,
          reverifyAuthority: async () => {
            const current = await readProjectHandleStateWithPermissionHistory(
              deployment,
              liveOperatorCandidates,
            )
            if (
              !current.authority ||
              current.authority.toLowerCase() !== authority.toLowerCase()
            ) {
              throw new Error(
                'The project owner/operator changed. Review the Safe deployment again.',
              )
            }
          },
        },
      )
      const confirmed = await readHandleAuthorityIdentities(
        deployment,
        authority,
      )
      if (!confirmed || !confirmed.matches) {
        throw new Error(
          'The Safe was deployed, but its current Ethereum owners, threshold, or modules do not match the project-chain Safe. Align the policies before publishing.',
        )
      }
      setProgress('Same-address Safe deployed and verified on Ethereum.')
      await safeDeploymentQuery.refetch()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(null)
    }
  }

  const current = stateQuery.data
  const displayedHandle = editing
    ? normalized?.handle
    : (current?.verifiedHandle ?? current?.claimedHandle)
  const displayedProjectUrl = `${siteOrigin}/@${displayedHandle ?? '<handle>'}`
  const textMatches = previewQuery.data?.textRecord === expectedRecord
  const setupPhase = normalized
    ? projectHandleSetupPhase({
        expectedRecord,
        textRecord: previewQuery.data?.textRecord,
        requestedHandle: normalized.handle,
        verifiedHandle: current?.verifiedHandle,
      })
    : null
  const alreadyVerified = setupPhase === 'verified'
  const needsMainnetSafe =
    !!safeDeploymentQuery.data &&
    isDeployableSafeAuthority(safeDeploymentQuery.data.source) &&
    safeDeploymentQuery.data.destination.kind === 'eoa'
  const safePolicyMismatch =
    safeDeploymentQuery.data?.source.kind === 'safe' &&
    safeDeploymentQuery.data.destination.kind === 'safe' &&
    !safeDeploymentQuery.data.matches
  const unsupportedCrossChainAuthority =
    !!safeDeploymentQuery.data &&
    !safeDeploymentQuery.data.matches &&
    !needsMainnetSafe &&
    !safePolicyMismatch
  const crossChainAuthorityBlocked =
    deployment.chainId !== PROJECT_HANDLES_CHAIN_ID &&
    (safeDeploymentQuery.isLoading ||
      safeDeploymentQuery.isError ||
      !safeDeploymentQuery.data?.matches)
  const pendingSafeUrl = pendingSafe
    ? safeQueueLink(PROJECT_HANDLES_CHAIN_ID, pendingSafe)
    : null

  return (
    <section className="card p-5">
      <span className="field-label">Project handle</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        You&rsquo;ll be able to find your project at{' '}
        <span className="font-medium">{displayedProjectUrl}</span>
      </p>

      {stateQuery.isLoading ? (
        <p className="mt-4 text-sm text-smoke-500">Loading project handle…</p>
      ) : stateQuery.isError ? (
        <ErrorNote message="Could not read the project handle registry." />
      ) : (
        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-smoke-500">Current</p>
              {current?.verifiedHandle ? (
                <a
                  href={`/@${encodeURIComponent(current.verifiedHandle)}`}
                  onClick={event => {
                    event.preventDefault()
                    navigateToProjectHandle(
                      `/@${encodeURIComponent(current.verifiedHandle!)}`,
                    )
                  }}
                  className="mt-1 block truncate text-sm font-medium text-bluebs-600 hover:underline"
                >
                  @{current.verifiedHandle}
                </a>
              ) : current?.claimedHandle ? (
                <p className="mt-1 text-sm text-amber-700">
                  @{current.claimedHandle} (not verified)
                </p>
              ) : (
                <p className="mt-1 text-sm text-smoke-500">Not set</p>
              )}
            </div>
            {!editing ? (
              <button
                type="button"
                onClick={openEditor}
                className="btn-secondary min-h-[36px] px-3 text-xs"
              >
                {current?.claimedHandle ? 'Edit handle' : 'Set handle'}
              </button>
            ) : null}
          </div>

          {current?.claimedHandle && !current.verifiedHandle ? (
            <p className="mt-2 text-xs text-smoke-500">
              ENS currently returns{' '}
              <span className="font-mono">{current.textRecord ?? 'no record'}</span>;
              this project requires <span className="font-mono">{expectedRecord}</span>.
            </p>
          ) : null}

          {editing ? (
            <div className="mt-4 rounded-xl border border-smoke-200 bg-smoke-25 p-4">
              <label className="block">
                <span className="field-label">ENS name</span>
                <input
                  value={input}
                  onChange={event => {
                    setInput(event.target.value)
                    setError(null)
                    setProgress(null)
                    setPendingSafe(null)
                  }}
                  placeholder="banny.eth"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="input-well mt-2 min-h-[44px] w-full px-3 text-sm"
                />
              </label>
              {input && !normalized ? (
                <p className="mt-2 text-xs text-red-700">
                  Enter a valid ENSIP-15 name under .eth.
                </p>
              ) : normalized ? (
                <div className="mt-3 space-y-1 text-xs text-smoke-700">
                  <p>
                    ENS record: <span className="font-mono">{PROJECT_HANDLE_TEXT_KEY}</span>{' '}
                    = <span className="font-mono">{expectedRecord}</span>
                  </p>
                  <p>
                    Resolver preflight:{' '}
                    <span className={textMatches ? 'text-melon-700' : 'text-amber-700'}>
                      {previewQuery.isLoading
                        ? 'Checking…'
                        : (previewQuery.data?.textRecord ?? 'Not set')}
                    </span>
                  </p>
                  {!previewQuery.isLoading && !previewQuery.data?.resolver ? (
                    <p className="text-amber-700">
                      This name has no resolver. Set one in the ENS manager first;
                      this app will not replace it.
                    </p>
                  ) : null}
                  <p>
                    <a
                      href={`https://app.ens.domains/${encodeURIComponent(normalized.ensName)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-bluebs-600 hover:underline"
                    >
                      Open {normalized.ensName} in ENS manager ↗
                    </a>
                  </p>
                </div>
              ) : null}

              {needsMainnetSafe ? (
                <div className="callout callout-warning mt-3 text-xs leading-relaxed">
                  <p>
                    This project is controlled by a Safe on its project chain,
                    but that same address is not deployed on Ethereum. Deploy
                    it there before publishing the mainnet handle claim.
                  </p>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => void deployMainnetSafe()}
                    className="btn-secondary mt-2 min-h-[36px] px-3 text-xs disabled:opacity-50"
                  >
                    {!address
                      ? 'Connect to deploy Safe'
                      : busy === 'safe'
                        ? 'Deploying Safe…'
                        : 'Deploy same Safe on Ethereum'}
                  </button>
                </div>
              ) : null}

              {safePolicyMismatch ? (
                <div className="callout callout-warning mt-3 text-xs leading-relaxed">
                  The project-chain and Ethereum Safes do not have the same
                  current owners, threshold, and module-free policy. Align them
                  in Safe before publishing this handle.
                </div>
              ) : null}

              {unsupportedCrossChainAuthority ? (
                <div className="callout callout-warning mt-3 text-xs leading-relaxed">
                  Cross-chain handle claims support only the same EOA on both
                  chains or matching module-free Safes. This authority does not
                  meet that policy.
                </div>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={
                    !!busy ||
                    !normalized ||
                    previewQuery.isLoading ||
                    !previewQuery.data?.resolver ||
                    alreadyVerified ||
                    (setupPhase === 'authority-claim' &&
                      crossChainAuthorityBlocked)
                  }
                  onClick={() => void saveHandle()}
                  className="btn-primary min-h-[40px] px-3 text-xs disabled:opacity-50"
                >
                  {busy === 'ens'
                    ? 'Updating ENS…'
                    : busy === 'claim'
                    ? 'Publishing handle…'
                    : !address
                      ? 'Connect to set up handle'
                      : alreadyVerified
                        ? 'Handle verified'
                        : setupPhase === 'authority-claim'
                          ? 'Resume: publish handle'
                          : 'Set verified handle'}
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => setEditing(false)}
                  className="min-h-[40px] px-3 text-xs text-smoke-600 hover:text-ink disabled:opacity-50"
                >
                  Close
                </button>
              </div>
              {progress ? (
                <p className="mt-3 text-xs text-smoke-700">{progress}</p>
              ) : null}
              {pendingSafeUrl ? (
                <a
                  href={pendingSafeUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs text-bluebs-600 hover:underline"
                >
                  Open pending handle setup in Safe ↗
                </a>
              ) : null}
              <ErrorNote message={error ?? ''} />
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
