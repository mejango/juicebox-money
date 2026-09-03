"use client";

import {
  JB_CHAINS,
  JBCoreContracts,
  jbContractAddress,
  jbPermissionsAbi,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { zeroAddress, type Address } from "viem";
import { AddressField } from "@/components/create/AddressField";
import { CheckRow } from "@/components/create/ui";
import { ChainIcon } from "@/components/ChainIcon";
import {
  AccountGroupsSkeleton,
  ActionRowsSkeleton,
} from "@/components/LoadingSkeletons";
import {
  SafeQueueCard,
  type SafeQueueChain,
} from "@/components/project/SafeQueueCard";
import { AddressLink } from "@/components/ui/AddressLink";
import { ChainPicker } from "@/components/ui/ChainPicker";
import { TxConfirmDialog } from "@/components/ui/TxConfirmDialog";
import { ErrorNote } from "@/components/ui/TxError";
import {
  clientFor,
  readAuthorityOf,
  runAuthorityCalls,
  toggleInSet,
  type AuthorityCall,
} from "@/lib/authority";
import {
  getPermissionHoldersAcrossDeployments,
  type BsPermissionHolder,
} from "@/lib/bendystraw";
import { resolvedAddress } from "@/lib/ens";
import {
  decodePermissionBitmap,
  isKnownPermissionId,
  permissionDefinition,
  V6_PERMISSIONS,
} from "@/lib/permissions";
import {
  deploySafeSameAddress,
  fetchSafeCreation,
  fetchSafeInfo,
  type SafeInfo,
} from "@/lib/safe";
import { readMatchingAuthorityIdentities } from "@/lib/cross-chain-authority";
import {
  buildPermissionsAuthorityCall,
  buildProjectOwnershipAuthorityCall,
  buildRevnetOperatorAuthorityCall,
} from "@/lib/transaction-builders";
import { chainName } from "@/lib/urn";

export type AuthorityDeployment = {
  chainId: JBChainId;
  projectId: number;
  indexedAuthority: Address | null;
};

type AuthorityRow = AuthorityDeployment & {
  name: string;
  authority: Address | null;
  safe: SafeInfo | null;
  accountType: "Safe Multisig" | "EOA" | "Contract" | "Unknown";
};

type AuthorityGroup = {
  key: string;
  authority: Address | null;
  safe: SafeInfo | null;
  accountType: AuthorityRow["accountType"];
  rows: AuthorityRow[];
};

async function readAuthorityRows(
  deployments: AuthorityDeployment[],
  isRevnet: boolean,
): Promise<AuthorityRow[]> {
  return Promise.all(
    deployments.map(async (deployment) => {
      const client = clientFor(deployment.chainId);
      const authority = await readAuthorityOf(client, deployment, {
        indexedOnly: isRevnet,
      });

      let safe: SafeInfo | null = null;
      let accountType: AuthorityRow["accountType"] = "Unknown";
      if (authority) {
        safe = await fetchSafeInfo(deployment.chainId, authority);
        if (safe) accountType = "Safe Multisig";
        else {
          // "This owner is an EOA" is a trust statement, not a default. An
          // absent result legitimately MEANS no code, so the read failure
          // needs its own sentinel — swallowing it to null turned an RPC blip
          // into a confident (and possibly wrong) claim that a Safe-controlled
          // project is controlled by one key.
          const code = await client
            .getBytecode({ address: authority })
            .catch(() => "unreadable" as const);
          accountType =
            code === "unreadable"
              ? "Unknown"
              : !code || code === "0x"
                ? "EOA"
                : "Contract";
        }
      }
      return {
        ...deployment,
        name: chainName(deployment.chainId),
        authority,
        safe,
        accountType,
      };
    }),
  );
}

function groupAuthorityRows(rows: AuthorityRow[]): AuthorityGroup[] {
  const groups = new Map<string, AuthorityGroup>();
  for (const row of rows) {
    const safeKey = row.safe
      ? `${row.safe.threshold}/${[...row.safe.owners]
          .map((owner) => owner.toLowerCase())
          .sort()
          .join(",")}`
      : "";
    const key = `${row.authority?.toLowerCase() ?? "unknown"}:${row.accountType}:${safeKey}`;
    const group = groups.get(key) ?? {
      key,
      authority: row.authority,
      safe: row.safe,
      accountType: row.accountType,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function samePermissionSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const aa = [...a].sort((x, y) => x - y);
  const bb = [...b].sort((x, y) => x - y);
  return aa.every((value, index) => value === bb[index]);
}

type OperatorGrant = {
  operator: Address;
  account: Address;
  isRevnetOperator: boolean;
  rows: BsPermissionHolder[];
  union: number[];
  differs: boolean;
  live: boolean;
  wildcard: boolean;
};

/** The ids an operator holds on one chain — the honest seed for an edit that writes that chain. */
export function permissionIdsOnChain(
  grant: OperatorGrant | null,
  chainId: number,
): number[] {
  const row = grant?.rows.find((item) => item.chainId === chainId);
  return [...(row?.permissions ?? [])].sort((a, b) => a - b);
}

export function aggregateGrants(
  holders: BsPermissionHolder[],
  deployments: AuthorityDeployment[],
  authorityRows: AuthorityRow[],
): OperatorGrant[] {
  // A grant is keyed by (operator, GRANTOR, project) and only confers anything while the grantor is
  // still that chain's project authority. Grants written by a former owner stay indexed but are dead.
  const authorityByChain = new Map(
    authorityRows.map((row) => [row.chainId, row.authority?.toLowerCase()]),
  );
  const groups = new Map<string, OperatorGrant>();
  for (const holder of holders) {
    // Wildcard (projectId 0) grants stay a SEPARATE entry from project-scoped ones: they're distinct
    // grants with a wider blast radius, and editing one is a different write from editing the other.
    const key = `${holder.operator.toLowerCase()}|${holder.wildcard ? "w" : "p"}`;
    const current = groups.get(key) ?? {
      operator: holder.operator as Address,
      account: holder.account as Address,
      isRevnetOperator: false,
      rows: [],
      union: [],
      differs: false,
      live: false,
      wildcard: !!holder.wildcard,
    };
    const authority = authorityByChain.get(holder.chainId as JBChainId);
    current.live ||= !authority || authority === holder.account.toLowerCase();
    current.rows.push(holder);
    current.isRevnetOperator ||= !!holder.isRevnetOperator;
    current.union = [
      ...new Set([...current.union, ...holder.permissions]),
    ].sort((a, b) => a - b);
    groups.set(key, current);
  }
  for (const group of groups.values()) {
    const first = group.rows[0]?.permissions ?? [];
    const coveredChains = new Set(group.rows.map((row) => row.chainId));
    group.differs =
      deployments.some((row) => !coveredChains.has(row.chainId)) ||
      group.rows.some((row) => !samePermissionSet(first, row.permissions));
  }
  return [...groups.values()];
}

export function AuthorityOverview({
  deployments,
  isRevnet,
  beforePermissions,
}: {
  deployments: AuthorityDeployment[];
  isRevnet: boolean;
  /** Website-order cards rendered after the Safe queue and before permissions. */
  beforePermissions?: React.ReactNode;
}) {
  const authorityLabel = isRevnet ? "Revnet operator" : "Project owner";
  const authorityQuery = useQuery({
    queryKey: [
      "authorityRows",
      isRevnet,
      deployments
        .map(
          (row) =>
            `${row.chainId}:${row.projectId}:${row.indexedAuthority ?? ""}`,
        )
        .join(","),
    ],
    staleTime: 30_000,
    queryFn: () => readAuthorityRows(deployments, isRevnet),
  });
  // `rows` intentionally falls back to a fresh empty array only while the
  // query has no data; no derived group can be observed in that state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = authorityQuery.data ?? [];
  const groups = useMemo(() => groupAuthorityRows(rows), [rows]);
  const known = rows.filter((row) => !!row.authority);
  const differs =
    known.length > 1 &&
    known.some(
      (row) =>
        row.authority!.toLowerCase() !== known[0].authority!.toLowerCase(),
    );
  const safeGroups = useMemo(() => {
    const byAddress = new Map<
      string,
      { safe: Address; rows: AuthorityRow[] }
    >();
    for (const row of rows) {
      if (!row.authority || !row.safe) continue;
      const key = row.authority.toLowerCase();
      const group = byAddress.get(key) ?? { safe: row.authority, rows: [] };
      group.rows.push(row);
      byAddress.set(key, group);
    }
    return [...byAddress.values()];
  }, [rows]);

  return (
    <>
      <section className="card p-5">
        <div>
          <span className="field-label">Account</span>
          <p className="mt-2 text-sm leading-relaxed text-smoke-700">
            {isRevnet
              ? "Revnets have no project owner. The revnet operator holds only the permissions granted at launch, and can pass that role on."
              : "The project NFT is ownership. Its project owner controls owner-only actions, either directly or through a Safe."}
          </p>
        </div>
        {authorityQuery.isLoading ? (
          <AccountGroupsSkeleton />
        ) : authorityQuery.isError ? (
          <p className="mt-4 text-sm text-red-700">
            Could not read project control.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            {differs ? (
              <div className="callout callout-warning text-sm">
                {authorityLabel} differs by chain. Actions below are scoped to
                each matching account group so a change cannot silently target
                the wrong controller.
              </div>
            ) : null}
            {groups.map((group) => {
              const safeElsewhere =
                !group.safe &&
                !!group.authority &&
                rows.some(
                  (row) =>
                    !!row.safe &&
                    row.authority?.toLowerCase() ===
                      group.authority!.toLowerCase(),
                );
              return (
                <div
                  key={group.key}
                  className="rounded-xl border border-smoke-200 p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {group.rows.map((row) => (
                      <span
                        key={row.chainId}
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-smoke-700"
                      >
                        <ChainIcon chainId={row.chainId} size={20} />
                        {row.name}
                      </span>
                    ))}
                  </div>
                  <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[7rem_1fr]">
                    <dt className="text-smoke-500">{authorityLabel}</dt>
                    <dd>
                      {group.authority ? (
                        <AddressLink
                          address={group.authority}
                          chainId={group.rows[0].chainId}
                          className="font-mono text-sm text-ink"
                          title={group.authority}
                        />
                      ) : (
                        <span className="text-smoke-500">Unknown</span>
                      )}
                    </dd>
                    <dt className="text-smoke-500">Type</dt>
                    <dd className="font-medium text-ink">
                      {safeElsewhere
                        ? "Safe Multisig (not deployed here yet)"
                        : group.accountType}
                    </dd>
                    {group.safe ? (
                      <>
                        <dt className="text-smoke-500">Policy</dt>
                        <dd className="font-medium text-ink">
                          Requires {group.safe.threshold} of{" "}
                          {group.safe.owners.length} signatures
                        </dd>
                        <dt className="text-smoke-500">Signers</dt>
                        <dd className="flex flex-wrap gap-x-2 gap-y-1">
                          {group.safe.owners.map((owner) => (
                            <AddressLink
                              key={owner}
                              address={owner}
                              chainId={group.rows[0].chainId}
                              className="font-mono text-sm text-ink"
                              title={owner}
                            />
                          ))}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                  {safeElsewhere && group.authority ? (
                    <DeploySafeButtons
                      safe={group.authority}
                      rows={group.rows}
                      sourceRows={rows.filter(
                        (row) =>
                          !!row.safe &&
                          row.authority?.toLowerCase() ===
                            group.authority!.toLowerCase(),
                      )}
                      isRevnet={isRevnet}
                      onDone={() => authorityQuery.refetch()}
                    />
                  ) : null}
                  {group.authority &&
                  !safeElsewhere &&
                  (group.safe || group.accountType === "EOA") ? (
                    <TransferAuthorityFlow
                      rows={group.rows}
                      authority={group.authority}
                      isRevnet={isRevnet}
                      onDone={() => authorityQuery.refetch()}
                    />
                  ) : null}
                  {group.authority &&
                  !group.safe &&
                  !safeElsewhere &&
                  group.accountType === "Contract" ? (
                    <p className="mt-3 text-xs leading-relaxed text-smoke-500">
                      This authority is a non-Safe contract. Submit owner
                      actions through that contract’s governance or wallet
                      interface.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {safeGroups.map((group) => (
        <SafeQueueCard
          key={group.safe}
          safe={group.safe}
          chains={[
            ...group.rows.map((row) => ({
              chainId: row.chainId,
              name: row.name,
              projectId: row.projectId,
              isRevnet,
              handleTuples: group.rows.map((source) => ({
                chainId: source.chainId,
                projectId: source.projectId,
              })),
            })),
            ...(group.rows.some((row) => row.chainId === 1)
              ? []
              : [{
                  chainId: 1 as JBChainId,
                  name: JB_CHAINS[1].name,
                  projectId: group.rows[0].projectId,
                  isRevnet,
                  handleOnly: true,
                  handleTuples: group.rows.map((source) => ({
                    chainId: source.chainId,
                    projectId: source.projectId,
                  })),
                }]),
          ] satisfies SafeQueueChain[]}
          authorityLabel={authorityLabel}
        />
      ))}

      {beforePermissions}

      <PermissionsAcrossChains
        deployments={deployments}
        authorityRows={rows}
        isRevnet={isRevnet}
      />
    </>
  );
}

function DeploySafeButtons({
  safe,
  rows,
  sourceRows,
  isRevnet,
  onDone,
}: {
  safe: Address;
  rows: AuthorityRow[];
  sourceRows: AuthorityRow[];
  isRevnet: boolean;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const deploy = async (row: AuthorityRow) => {
    setBusy(row.chainId);
    setMessage("Reading the Safe’s original deployment…");
    try {
      const source = sourceRows[0];
      if (!source) {
        throw new Error("Could not identify a live source-chain Safe.");
      }
      const reverifyAuthority = async () => {
        const current = await readAuthorityOf(
          clientFor(source.chainId),
          source,
          {
            indexedOnly: isRevnet,
            indexedCandidates: [safe],
            strict: true,
            detectRevnet: isRevnet,
          },
        );
        if (!current || current.toLowerCase() !== safe.toLowerCase()) {
          throw new Error(
            `This Safe is no longer the ${isRevnet ? "revnet operator" : "project owner"} on ${source.name}.`,
          );
        }
        for (const candidate of sourceRows.slice(1)) {
          const identities = await readMatchingAuthorityIdentities({
            sourceClient: clientFor(source.chainId),
            destinationClient: clientFor(candidate.chainId),
            authority: safe,
          });
          if (!identities?.matches) {
            throw new Error(
              "This Safe has different policies across source chains. Choose and deploy the intended policy in the Safe app instead.",
            );
          }
        }
      };
      await reverifyAuthority();
      const creation = await fetchSafeCreation(safe, source.chainId);
      if (!creation)
        throw new Error("Could not read the Safe’s creation config.");
      setMessage(`Deploying the same Safe address on ${row.name}…`);
      await deploySafeSameAddress(row.chainId, creation, safe, {
        sourceChainId: source.chainId,
        reverifyAuthority,
      });
      setMessage(`Safe deployed on ${row.name}.`);
      onDone();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not deploy the Safe.",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3">
      <p className="text-xs leading-relaxed text-smoke-700">
        This is the same Safe address used on another chain, but its proxy is
        not deployed here yet. Replay its canonical creation to activate it.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {rows.map((row) => (
          <button
            key={row.chainId}
            type="button"
            onClick={() => deploy(row)}
            disabled={busy !== null}
            className="btn-secondary min-h-[36px] px-3 text-xs"
          >
            {busy === row.chainId ? "Deploying…" : `Deploy Safe on ${row.name}`}
          </button>
        ))}
      </div>
      {message ? (
        <p className="mt-2 text-xs text-smoke-700">{message}</p>
      ) : null}
    </div>
  );
}

function TransferAuthorityFlow({
  rows,
  authority,
  isRevnet,
  onDone,
}: {
  rows: AuthorityRow[];
  authority: Address;
  isRevnet: boolean;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<{
    to: Address;
    calls: AuthorityCall[];
  } | null>(null);
  const [step, setStep] = useState(-1);
  const [done, setDone] = useState(false);

  const title = isRevnet ? "Transfer revnet operator" : "Transfer project ownership";

  const review = () => {
    const to = resolvedAddress(destination);
    if (!to) {
      setError("Enter a valid destination address or ENS name.");
      return;
    }
    if (!ack) return;
    setError(null);
    setStatus(null);
    setPlan({
      to,
      calls: rows.map((row) => {
        if (isRevnet) {
          return buildRevnetOperatorAuthorityCall({
            chainId: row.chainId,
            authority,
            revnetId: BigInt(row.projectId),
            operator: to,
          });
        }
        return buildProjectOwnershipAuthorityCall({
          chainId: row.chainId,
          authority,
          projectId: BigInt(row.projectId),
          destination: to,
        });
      }),
    });
  };

  const submit = async () => {
    if (!plan || busy) return;
    setBusy(true);
    setError(null);
    setStep(0);
    try {
      const result = await runAuthorityCalls({
        calls: plan.calls,
        onProgress: (progress) => {
          setStatus(progress.message);
          // Progress names the chain it is on (JB_CHAINS name); that names the step.
          const index = plan.calls.findIndex((call) =>
            progress.message.includes(JB_CHAINS[call.chainId]?.name ?? `chain ${call.chainId}`),
          );
          if (index >= 0) setStep(index);
        },
      });
      const queued = result.safeResults.filter(
        (item) => item.status === "queued",
      ).length;
      const waiting = result.safeResults.filter(
        (item) => item.status === "waiting",
      ).length;
      setStatus(
        queued || waiting
          ? `Your Safe action is recorded${queued ? `; ${queued} queued` : ""}${waiting ? `; ${waiting} awaiting more onchain approvals` : ""}.`
          : `${isRevnet ? "Revnet operator" : "Project ownership"} transferred on ${rows.length} chain${rows.length === 1 ? "" : "s"}.`,
      );
      setDone(true);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Could not transfer.",
      );
    } finally {
      setBusy(false);
    }
  };

  const closeReview = () => {
    if (busy) return;
    const finished = done;
    setPlan(null);
    setStep(-1);
    setDone(false);
    setError(null);
    if (finished) onDone();
  };

  const relinquish = isRevnet && plan?.to === zeroAddress;
  const dialog = plan ? (
    <TxConfirmDialog
      open
      title={
        done
          ? relinquish
            ? "Operator relinquished"
            : "Transferred"
          : `Confirm ${isRevnet ? "operator" : "ownership"} transfer`
      }
      rows={[
        {
          label: isRevnet ? "New operator" : "New owner",
          value: relinquish ? "None (relinquish)" : plan.to,
          mono: !relinquish,
          strong: true,
        },
        {
          label: "Project",
          value: [...new Set(rows.map((row) => `#${row.projectId}`))].join(", "),
        },
        { label: "On", value: rows.map((row) => row.name).join(", ") },
      ]}
      steps={rows.map((row) => ({
        key: String(row.chainId),
        title: `${isRevnet ? "Set operator" : "Transfer ownership"} on ${row.name}`,
      }))}
      activeIndex={step}
      status={status}
      error={error}
      busy={busy}
      complete={done}
      action={error ? "Retry" : `Confirm & ${isRevnet ? "set operator" : "transfer"}`}
      onConfirm={() => void submit()}
      onClose={closeReview}
    />
  ) : null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-secondary mt-4 min-h-[38px] px-4 text-sm"
      >
        {title}
      </button>
    );
  }

  return (
    <div className="mt-4 rounded-xl border border-smoke-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink">{title}</p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="text-xs text-smoke-700 hover:text-ink"
        >
          Cancel
        </button>
      </div>
      <div className="mt-3">
        <AddressField
          value={destination}
          onChange={(value) => {
            setDestination(value);
            setError(null);
          }}
          disabled={busy}
          placeholder={
            isRevnet
              ? "0x… new revnet operator (zero address relinquishes)"
              : "0x… new project owner"
          }
          ariaLabel={isRevnet ? "New revnet operator" : "New project owner"}
        />
      </div>
      <p className="mt-2 text-xs text-smoke-500">
        Applies on {rows.map((row) => row.name).join(", ")}.
      </p>
      <label className="mt-3 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3">
        <input
          type="checkbox"
          checked={ack}
          onChange={(event) => setAck(event.target.checked)}
          disabled={busy}
          className="mt-0.5 accent-red-600"
        />
        <span className="text-xs leading-relaxed text-red-700">
          {isRevnet
            ? destination.trim().toLowerCase() === zeroAddress
              ? "I understand that relinquishing the revnet operator role is permanent."
              : "I verified the new revnet operator. They receive every power attached to this role."
            : "I verified the new project owner. Transferring the project NFT hands over every owner-only power."}
        </span>
      </label>
      <button
        type="button"
        onClick={review}
        disabled={busy || !!plan || !ack || !destination.trim()}
        className="btn-primary mt-3 min-h-[42px] w-full text-sm"
      >
        {title}
      </button>
      {status ? <p className="mt-2 text-xs text-smoke-700">{status}</p> : null}
      {error && !plan ? <ErrorNote message={error} /> : null}
      {dialog}
    </div>
  );
}

function PermissionsAcrossChains({
  deployments,
  authorityRows,
  isRevnet,
}: {
  deployments: AuthorityDeployment[];
  authorityRows: AuthorityRow[];
  isRevnet: boolean;
}) {
  const chainIds = deployments.map((row) => row.chainId);
  const deploymentKey = deployments
    .map((row) => `${row.chainId}:${row.projectId}`)
    .join(",");
  // Wildcard grants are scoped to the granting ACCOUNT, so the authority has to be known per chain
  // before they can be fetched.
  const withAuthority = useMemo(
    () =>
      deployments.map((row) => ({
        ...row,
        authority:
          authorityRows.find((item) => item.chainId === row.chainId)?.authority ??
          null,
      })),
    [authorityRows, deployments],
  );
  const authorityKey = withAuthority
    .map((row) => `${row.chainId}:${row.authority ?? ""}`)
    .join(",");
  const query = useQuery({
    queryKey: ["permissionHoldersAcrossDeployments", deploymentKey, authorityKey],
    enabled: deployments.some((row) => row.projectId > 0),
    staleTime: 30_000,
    queryFn: () => getPermissionHoldersAcrossDeployments(withAuthority),
  });
  const grants = useMemo(
    () => aggregateGrants(query.data ?? [], deployments, authorityRows),
    [authorityRows, deployments, query.data],
  );
  const [editing, setEditing] = useState<OperatorGrant | "new" | null>(null);
  const authorityLabel = isRevnet ? "Revnet operator" : "Project owner";
  // The owner never appears in the indexed grants: JBPermissioned._requirePermissionFrom passes on
  // `sender == account` before consulting JBPermissions at all, so the most powerful account on the
  // project holds every power with no grant to index. Listing delegates alone under-reports who can act.
  const owners = useMemo(() => {
    const seen = new Map<string, JBChainId[]>();
    for (const row of authorityRows) {
      if (!row.authority) continue;
      const key = row.authority.toLowerCase();
      seen.set(key, [...(seen.get(key) ?? []), row.chainId]);
    }
    return [...seen.entries()].map(([address, chains]) => ({
      address: address as Address,
      chains,
    }));
  }, [authorityRows]);

  return (
    <section className="card p-5">
      <span className="field-label">Permissions</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        {isRevnet
          ? "Every account that can act on this revnet, and what each one can do. The revnet operator’s powers come with the role, including any NFT powers granted at launch."
          : "Every account that can act on this project, and what each one can do — this is where shop managers get their power to add, mint, or reprice items. Each row shows exactly what is granted and on which chains."}
      </p>

      {owners.length ? (
        <div className="mt-4 border-b border-smoke-100 pb-4">
          {owners.map((owner) => (
            <div key={owner.address} className="flex flex-wrap items-center gap-2">
              <AddressLink
                address={owner.address}
                chainId={owner.chains[0]}
                className="font-mono text-sm text-ink"
                title={owner.address}
              />
              <span className="rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
                {authorityLabel}
              </span>
              <span className="flex items-center gap-1" title="On">
                {owner.chains.map((chainId) => (
                  <ChainIcon key={chainId} chainId={chainId} size={16} standalone />
                ))}
              </span>
            </div>
          ))}
          <p className="mt-2 text-xs leading-relaxed text-smoke-700">
            Every power. The {authorityLabel.toLowerCase()} acts directly and never
            needs a grant, so it holds all of the permissions below.
          </p>
        </div>
      ) : null}

      {query.isLoading ? (
        <ActionRowsSkeleton rows={4} label="Loading permissions" />
      ) : grants.length === 0 ? (
        <p className="mt-4 text-sm text-smoke-500">
          No other accounts have been granted permissions, according to the
          indexer. Grants are read from the index, so one made very recently may
          not appear yet.
        </p>
      ) : (
        <div className="mt-4 divide-y divide-smoke-100">
          {grants.map((grant) => (
            <div
              key={`${grant.operator}:${grant.wildcard ? "wildcard" : "project"}`}
              className="py-4 first:pt-0 last:pb-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <AddressLink
                  address={grant.operator}
                  chainId={chainIds[0]}
                  className="font-mono text-sm text-ink"
                  title={grant.operator}
                />
                {grant.wildcard ? (
                  <span
                    className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700"
                    title={`Granted on project 0 — the wildcard scope. This applies to EVERY project ${grant.account} owns, not just this one.`}
                  >
                    All projects
                  </span>
                ) : null}
                {grant.isRevnetOperator ? (
                  <span className="rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
                    Revnet operator
                  </span>
                ) : null}
                {grant.differs ? (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    Differs by chain
                  </span>
                ) : null}
                {!grant.live ? (
                  <span
                    className="rounded-full bg-smoke-100 px-2 py-0.5 text-[11px] font-medium text-smoke-700"
                    title={`Granted by ${grant.account}, who is no longer the project owner — these powers confer nothing. Re-grant them to make them effective.`}
                  >
                    Inactive
                  </span>
                ) : null}
              </div>
              <div className="mt-3 space-y-2">
                {grant.union.map((id) => {
                  const permission = permissionDefinition(id);
                  const onChains = grant.rows
                    .filter((row) => row.permissions.includes(id))
                    .map((row) => row.chainId as JBChainId);
                  return (
                    <div
                      key={id}
                      className="grid gap-1 sm:grid-cols-[1fr_auto] sm:gap-3"
                    >
                      <span>
                        <span className="block text-sm font-medium text-ink">
                          {permission.label}
                          <span className="ml-1 font-mono text-[10px] text-smoke-500">
                            #{id}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-smoke-700">
                          {permission.description}
                        </span>
                      </span>
                      <span
                        className="flex items-center gap-1"
                        title="Granted on"
                      >
                        {onChains.map((chainId) => (
                          <ChainIcon
                            key={chainId}
                            chainId={chainId}
                            size={16}
                            standalone
                          />
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
              {!isRevnet ? (
                <button
                  type="button"
                  onClick={() => setEditing(grant)}
                  className="btn-secondary mt-4 min-h-[36px] px-3 text-xs"
                >
                  Edit permissions
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {!isRevnet ? (
        editing ? (
          <PermissionEditor
            grant={editing === "new" ? null : editing}
            deployments={deployments}
            authorityRows={authorityRows}
            onCancel={() => setEditing(null)}
            onDone={() => {
              setEditing(null);
              query.refetch();
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="btn-secondary mt-4 min-h-[40px] px-4 text-sm"
          >
            + Add operator
          </button>
        )
      ) : null}
    </section>
  );
}

function PermissionEditor({
  grant,
  deployments,
  authorityRows,
  onCancel,
  onDone,
}: {
  grant: OperatorGrant | null;
  deployments: AuthorityDeployment[];
  authorityRows: AuthorityRow[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const [operatorInput, setOperatorInput] = useState(grant?.operator ?? "");
  // The granted set is PER CHAIN. Seeding from the cross-chain union and writing it back to every chain
  // silently widens the grant wherever it was narrower, so a non-uniform operator starts scoped to one
  // chain, seeded from what that chain actually holds.
  const perChain = !!grant?.differs && deployments.length > 1;
  const seedChainId = deployments[0]?.chainId;
  const [selected, setSelected] = useState<Set<number>>(() =>
    perChain
      ? new Set(permissionIdsOnChain(grant, seedChainId))
      : new Set(grant?.union ?? []),
  );
  const [selectedChains, setSelectedChains] = useState<Set<number>>(() =>
    perChain
      ? new Set([seedChainId])
      : new Set(
          grant?.rows.map((row) => row.chainId) ??
            deployments.map((row) => row.chainId),
        ),
  );
  // Re-seed from whatever scope the current chain selection represents: one chain → that chain's real
  // set; several → the union, now an explicit choice to level them up rather than a silent one.
  const reseed = (chains: Set<number>) => {
    if (!perChain) return;
    const only = chains.size === 1 ? [...chains][0] : null;
    setSelected(
      new Set(only == null ? (grant?.union ?? []) : permissionIdsOnChain(grant, only)),
    );
  };
  const [ack, setAck] = useState(false);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<{
    operator: Address;
    chosen: AuthorityDeployment[];
    permissions: string[];
    calls: AuthorityCall[];
  } | null>(null);
  const [step, setStep] = useState(-1);
  const [done, setDone] = useState(false);

  /** Re-read each chain's current bitmap and freeze the exact calls. */
  const review = async () => {
    const operator = resolvedAddress(operatorInput);
    if (!operator || operator === zeroAddress) {
      setError("Enter a valid non-zero operator address or ENS name.");
      return;
    }
    const chosen = deployments.filter((row) => selectedChains.has(row.chainId));
    if (!chosen.length) {
      setError("Choose at least one chain.");
      return;
    }
    setChecking(true);
    setError(null);
    setStatus(null);
    try {
      const calls: AuthorityCall[] = [];
      for (const deployment of chosen) {
        const authority = authorityRows.find(
          (row) => row.chainId === deployment.chainId,
        )?.authority;
        if (!authority)
          throw new Error(`Project owner is unknown on chain ${deployment.chainId}.`);
        // A wildcard grant lives on JBPermissions.WILDCARD_PROJECT_ID, not on this project.
        const scopeProjectId = grant?.wildcard ? 0n : BigInt(deployment.projectId);
        const bitmap = (await clientFor(deployment.chainId).readContract({
          address:
            jbContractAddress["6"][JBCoreContracts.JBPermissions][
              deployment.chainId
            ],
          abi: jbPermissionsAbi,
          functionName: "permissionsOf",
          args: [operator, authority, scopeProjectId],
        })) as bigint;
        const unknownIds = decodePermissionBitmap(bitmap).filter(
          (id) => !isKnownPermissionId(id),
        );
        const finalIds = [...new Set([...selected, ...unknownIds])].sort(
          (a, b) => a - b,
        );
        calls.push(
          buildPermissionsAuthorityCall({
            chainId: deployment.chainId,
            authority,
            account: authority,
            operator,
            projectId: scopeProjectId,
            permissionIds: finalIds,
            label: grant ? "Edit permissions" : "Add operator",
          }),
        );
      }
      setPlan({
        operator,
        chosen,
        permissions: V6_PERMISSIONS.filter((permission) =>
          selected.has(permission.id),
        ).map((permission) => `${permission.label} #${permission.id}`),
        calls,
      });
    } catch (reviewError) {
      setError(
        reviewError instanceof Error
          ? reviewError.message
          : "Could not read the current permissions.",
      );
    } finally {
      setChecking(false);
    }
  };

  const submit = async () => {
    if (!plan || busy) return;
    setBusy(true);
    setError(null);
    setStep(0);
    try {
      const result = await runAuthorityCalls({
        calls: plan.calls,
        onProgress: (progress) => {
          setStatus(progress.message);
          // Progress names the chain it is on (JB_CHAINS name); that names the step.
          const index = plan.calls.findIndex((call) =>
            progress.message.includes(JB_CHAINS[call.chainId]?.name ?? `chain ${call.chainId}`),
          );
          if (index >= 0) setStep(index);
        },
      });
      const queued = result.safeResults.filter(
        (item) => item.status === "queued",
      ).length;
      setStatus(
        queued
          ? `Queued on ${queued} Safe chain${queued === 1 ? "" : "s"}; co-sign and execute above.`
          : `Permissions updated on ${plan.chosen.length} chain${plan.chosen.length === 1 ? "" : "s"}.`,
      );
      setDone(true);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Could not update permissions.",
      );
    } finally {
      setBusy(false);
    }
  };

  const closeReview = () => {
    if (busy) return;
    const finished = done;
    setPlan(null);
    setStep(-1);
    setDone(false);
    setError(null);
    if (finished) onDone();
  };

  const dialog = plan || checking ? (
    <TxConfirmDialog
      open
      preparing={!plan}
      title={
        done
          ? grant
            ? "Permissions updated"
            : "Operator added"
          : grant
            ? "Confirm permissions"
            : "Confirm operator"
      }
      rows={plan ? [
        { label: "Operator", value: plan.operator, mono: true, strong: true },
        {
          label: "Permissions",
          value: plan.permissions.length
            ? plan.permissions.join(", ")
            : "None (revokes every known permission)",
        },
        {
          label: "Project",
          value: grant?.wildcard
            ? "All projects"
            : [...new Set(plan.chosen.map((row) => `#${row.projectId}`))].join(", "),
        },
        {
          label: "On",
          value: plan.chosen.map((row) => chainName(row.chainId)).join(", "),
        },
      ] : []}
      steps={(plan?.chosen ?? []).map((row) => ({
        key: String(row.chainId),
        title: `${grant ? "Set permissions" : "Add operator"} on ${chainName(row.chainId)}`,
      }))}
      activeIndex={step}
      status={!plan ? "Reading the current permissions…" : status}
      error={error}
      busy={checking || busy}
      complete={done}
      action={error ? "Retry" : grant ? "Confirm & update" : "Confirm & add"}
      onConfirm={() => void submit()}
      onClose={closeReview}
    />
  ) : null;

  return (
    <div className="mt-5 rounded-xl border border-smoke-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink">
          {grant ? "Edit permissions" : "Add operator"}
        </p>
        <button
          type="button"
          onClick={onCancel}
          disabled={checking || busy}
          className="text-xs text-smoke-700 hover:text-ink"
        >
          Cancel
        </button>
      </div>

      {grant?.wildcard ? (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium leading-relaxed text-amber-800">
          This is a wildcard grant on project 0 — it applies to EVERY project this
          owner owns, not just this one. Editing it here changes the operator’s
          powers on all of them.
        </p>
      ) : null}

      <label className="mt-4 block">
        <span className="field-label">Operator</span>
        <div className="mt-1.5">
          <AddressField
            value={operatorInput}
            onChange={(value) => {
              setOperatorInput(value);
              setError(null);
            }}
            disabled={busy || !!grant}
            ariaLabel="Operator address"
          />
        </div>
        {grant ? (
          <span className="mt-1.5 block text-xs text-smoke-700">
            This address is fixed for this grant. To move these powers elsewhere, add the new
            address as its own operator, then clear every box here to remove this one.
          </span>
        ) : null}
      </label>

      <ChainPicker
        className="mt-4"
        label="Set on"
        rows={deployments.map((deployment) => ({
          chainId: deployment.chainId,
          name: JB_CHAINS[deployment.chainId]?.name ?? deployment.chainId,
        }))}
        selected={selectedChains}
        onChange={(chains) => {
          setSelectedChains(chains);
          reseed(chains);
        }}
        disabled={checking || busy}
        rowClassName={() =>
          "flex cursor-pointer items-center gap-2 rounded-lg border border-smoke-200 px-3 py-2 text-sm"
        }
      />

      <div className="mt-4">
        <span className="field-label">All V6 permissions</span>
        <p className="mt-1 text-xs leading-relaxed text-smoke-500">
          Saving replaces this operator’s known permission set on every selected
          chain. Unrecognized future permission bits are preserved.
        </p>
        {perChain ? (
          <p className="mt-1 text-xs leading-relaxed text-amber-700">
            {selectedChains.size === 1
              ? `This operator’s powers differ by chain, so this shows what they hold on ${
                  JB_CHAINS[[...selectedChains][0] as JBChainId]?.name ??
                  [...selectedChains][0]
                } only. Select one chain at a time to edit each set on its own.`
              : "Showing the union across the selected chains. Saving grants this same set on every one of them, including chains where the operator currently holds less."}
          </p>
        ) : null}
        <div className="mt-3 max-h-[34rem] space-y-2 overflow-y-auto pr-1">
          {V6_PERMISSIONS.map((permission) => (
            <CheckRow
              key={permission.id}
              checked={selected.has(permission.id)}
              onToggle={() =>
                setSelected((current) => toggleInSet(current, permission.id))
              }
              disabled={checking || busy}
              title={`${permission.label} #${permission.id}`}
              blurb={permission.description}
            />
          ))}
        </div>
      </div>

      <label className="mt-4 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3">
        <input
          type="checkbox"
          checked={ack}
          onChange={(event) => setAck(event.target.checked)}
          disabled={checking || busy}
          className="mt-0.5 accent-red-600"
        />
        <span className="text-xs leading-relaxed text-red-700">
          I verified the operator address and every checked power. A malicious
          operator can use these permissions against the project.
        </span>
      </label>

      <button
        type="button"
        onClick={() => void review()}
        disabled={
          checking || busy || !!plan || !ack || !operatorInput.trim() || !selectedChains.size
        }
        className="btn-primary mt-3 min-h-[44px] w-full text-sm"
      >
        {grant ? "Update permissions" : "Add operator"}
      </button>
      {status ? <p className="mt-2 text-xs text-smoke-700">{status}</p> : null}
      {error && !plan ? <ErrorNote message={error} /> : null}
      {dialog}
    </div>
  );
}
