// Held writes and saved-attempt recovery have one owner: the SDK (useHeldSend, useHeldWrite,
// useHeldWrites, HeldWritesNotice, useSavedAttempt, createSavedAttemptRecovery and their copy).
// No app copy of the hold's send gate, exit, follower, recovery rule or lines may come back.
const APP_HOLD_LOGIC = [
  [/\b(sendUnderHold|settleUnderHold|unprovenUnderHold|takeHeldExit)\b/, "an app send/settle loop around the hold (send through the SDK view or hold handle)"],
  [/(function|const)\s+(hidesShownExit|settledLine|offersExit|sameReservation|settledHashOf|withNotice)\b/, "an app copy of an SDK hold helper"],
  [
    /\b(recoverFromHold|holdOutcome|recoverSavedLaunch|launchResumeGate|exitLaunchHeld|discardUnreadableLaunchSession|recoverLaunchMultisigSetup|readLaunchForRetirement|keptSuccess)\b/,
    "app saved-attempt recovery (createSavedAttemptRecovery and useSavedAttempt)",
  ],
  [
    /\b(useWriteHoldWatch|held-writes-registry|showHeldWrite|heldWritesSnapshot|holdUntilResolved|followProposal|startFollowingProposal|recordProposal)\b/,
    "an app hold watcher, follower or registry",
  ],
  [/\bcreateHeldWriteView\s*\(/, "an app-made held-write view (useHeldSend or useHeldWrite make it)"],
  [/nana-sdk:(reviewed-write|saved-attempt)/, "direct storage access to the SDK's hold or recovery keys"],
  [
    /["'`](I checked my wallet|I checked it\.|This browser can't read its saved transactions|Released\. You can send it again|Confirming your transaction\.|This went through while you were away|Executed by your Safe\. Confirming it onchain\.|Your transaction went through\.|This transaction is no longer held here|Your earlier transaction went through)/,
    "a literal copy of an SDK hold line or label (import the constant)",
  ],
];

/** Every app-local hold or recovery pattern `source` contains, as messages. */
export function appHoldLogic(path, source) {
  return APP_HOLD_LOGIC.filter(([pattern]) => pattern.test(source)).map(([, what]) => `${path}: ${what}`);
}
