// Labels follow DefifaGamePhase in the protocol's src/enums/DefifaGamePhase.sol.
const phaseLabels: Readonly<Record<0 | 1 | 2 | 3 | 4 | 5, string>> = {
  0: 'Countdown', 1: 'Mint', 2: 'Refund', 3: 'Scoring', 4: 'Complete', 5: 'No contest',
}
export function defifaPhaseLabel(phase: number | undefined): string {
  return typeof phase === 'number' && Number.isInteger(phase) && Object.hasOwn(phaseLabels, phase)
    ? phaseLabels[phase as keyof typeof phaseLabels]
    : 'Unavailable'
}

/** DefifaGamePhase.NO_CONTEST: the game is voided with full refunds available. */
export function defifaPhaseNote(phase: number | undefined): string | null {
  return phase === 5 ? 'This game was voided. Full refunds are available.' : null
}
