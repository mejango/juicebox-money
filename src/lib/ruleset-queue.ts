export const APPROVAL_STATUS = {
  Empty: 0,
  Upcoming: 1,
  Active: 2,
  ApprovalExpected: 3,
  Approved: 4,
  Failed: 5,
} as const;

export type QueueAction = "current" | "replace" | "after";

export type QueueRulesetRef = {
  id: bigint | number;
  cycleNumber: bigint | number;
  start: bigint | number;
  duration: bigint | number;
};

export type QueueActionOption = {
  action: QueueAction;
  source: QueueRulesetRef;
  mustStartAtOrAfter: number | null;
  requiresStartDate: boolean;
};

export type RulesetQueuePlan = {
  defaultAction: QueueAction;
  options: QueueActionOption[];
  hasQueuedRuleset: boolean;
  hasMultipleQueuedRulesets: boolean;
};

function sameRuleset(a: QueueRulesetRef | null, b: QueueRulesetRef | null): boolean {
  return !!a && !!b && BigInt(a.id) === BigInt(b.id);
}

/**
 * Translate JBRulesets' approval lifecycle into the choices an owner can safely
 * make. `upcoming` is the next stored configuration (simulated auto-cycles must
 * be filtered by the caller); `latest` is the tail returned by
 * latestQueuedRulesetOf.
 */
export function planRulesetQueue({
  current,
  upcoming,
  latest,
  latestApprovalStatus,
}: {
  current: QueueRulesetRef;
  upcoming: QueueRulesetRef | null;
  latest: QueueRulesetRef | null;
  latestApprovalStatus: number | null;
}): RulesetQueuePlan {
  const distinctUpcoming = upcoming && !sameRuleset(upcoming, current) ? upcoming : null;
  const distinctLatest = latest && !sameRuleset(latest, current) ? latest : null;
  if (!distinctLatest) {
    return {
      defaultAction: "current",
      options: [
        {
          action: "current",
          source: current,
          mustStartAtOrAfter: 0,
          requiresStartDate: false,
        },
      ],
      hasQueuedRuleset: false,
      hasMultipleQueuedRulesets: false,
    };
  }

  const options: QueueActionOption[] = [];
  const latestIsReplaceable =
    latestApprovalStatus !== APPROVAL_STATUS.Approved &&
    latestApprovalStatus !== APPROVAL_STATUS.Active;
  const replaceTarget = latestIsReplaceable ? distinctLatest : null;

  // Approved means the queued cycle is final. Active is not a replaceable
  // future configuration either. Every other queued state falls back to the
  // queued ruleset's parent when another configuration targets its cycle.
  if (replaceTarget) {
    options.push({
      action: "replace",
      source: replaceTarget,
      mustStartAtOrAfter: Number(replaceTarget.start),
      requiresStartDate: false,
    });
  }

  // Only a configuration which is already final, expected to become final, or
  // has no approval hook can safely parent another queued configuration.
  if (
    latestApprovalStatus === APPROVAL_STATUS.Approved ||
    latestApprovalStatus === APPROVAL_STATUS.ApprovalExpected ||
    latestApprovalStatus === APPROVAL_STATUS.Empty
  ) {
    const duration = Number(distinctLatest.duration);
    options.push({
      action: "after",
      source: distinctLatest,
      mustStartAtOrAfter:
        duration > 0 ? Number(distinctLatest.start) + duration : null,
      requiresStartDate: duration === 0,
    });
  }

  return {
    // Preserve an existing queued configuration unless the owner explicitly
    // chooses to replace it.
    defaultAction: options.some((option) => option.action === "after")
      ? "after"
      : options[0]?.action ?? "current",
    options,
    hasQueuedRuleset: true,
    hasMultipleQueuedRulesets:
      !!distinctUpcoming && !sameRuleset(distinctUpcoming, distinctLatest),
  };
}

export function approvalStatusLabel(status: number | null): string {
  switch (status) {
    case APPROVAL_STATUS.Empty:
      return "No approval hook";
    case APPROVAL_STATUS.Upcoming:
      return "Approval not available yet";
    case APPROVAL_STATUS.Active:
      return "Active";
    case APPROVAL_STATUS.ApprovalExpected:
      return "Approval expected";
    case APPROVAL_STATUS.Approved:
      return "Approved";
    case APPROVAL_STATUS.Failed:
      return "Approval failed";
    default:
      return "Unknown approval status";
  }
}
