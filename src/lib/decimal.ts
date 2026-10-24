/** Nonnegative decimal syntax accepted by parseUnits, without exponent/hex notation. */
export function decimalOk(value: string, max = Infinity): boolean {
  const n = Number(value)
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number.isFinite(n) && n >= 0 && n <= max
}
