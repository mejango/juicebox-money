// Labels follow DefifaGamePhase in the protocol's src/enums/DefifaGamePhase.sol.
const phaseLabels: Readonly<Record<0 | 1 | 2 | 3 | 4 | 5, string>> = {
  0: 'Countdown', 1: 'Mint', 2: 'Refund', 3: 'Scoring', 4: 'Complete', 5: 'No contest',
}
export function defifaPhaseLabel(phase: number | undefined): string {
  return typeof phase === 'number' && Number.isInteger(phase) && Object.hasOwn(phaseLabels, phase)
    ? phaseLabels[phase as keyof typeof phaseLabels]
    : 'Unavailable'
}
