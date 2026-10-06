/** Start independent checks together; the RPC transport paces request starts.
 * Every check settles before callers can retry or proceed to a payment. */
export async function mapConcurrentChecks<T, R>(
  values: readonly T[],
  check: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const outcomes = await Promise.allSettled(
    values.map(async (value, index) => check(value, index)),
  );
  return outcomes.map((outcome) => {
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  });
}
