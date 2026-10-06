/** Overlap independent chain checks without an unbounded RPC burst. Every
 * started check settles before callers can retry or proceed to a payment. */
export async function mapConcurrentChecks<T, R>(
  values: readonly T[],
  check: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const outcomes: PromiseSettledResult<R>[] = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        try {
          outcomes[index] = {
            status: "fulfilled",
            value: await check(values[index], index),
          };
        } catch (reason) {
          outcomes[index] = { status: "rejected", reason };
        }
      }
    }),
  );
  return outcomes.map((outcome) => {
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  });
}
