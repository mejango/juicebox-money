const IDENT_COLORS = [
  '#1A8A8A',
  '#3D7A5A',
  '#C43550',
  '#2C2018',
  '#B8602E',
  '#6EC4C4',
  '#82B89E',
]

/** The deterministic two-color identity bubbles used by activity surfaces. */
export function identityGradient(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0
  }
  const a = IDENT_COLORS[Math.abs(hash) % IDENT_COLORS.length]
  const b = IDENT_COLORS[Math.abs(hash >> 3) % IDENT_COLORS.length]
  return `linear-gradient(135deg, ${a}, ${b})`
}
