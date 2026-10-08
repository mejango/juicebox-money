/** Presentation only: retain SDK errors and saved recovery records verbatim. */
export function transactionMessage(message: string): string {
  if (!/\bRelayr\b/i.test(message)) return message
  const text = message
    .replace(/\bRelayr HTTP \d+: (?:SimulationReverted|FailedToSimulateTransaction)\b/gi, 'Transaction simulation failed')
    .replace(/\bRelayr HTTP (\d+)/gi, 'Transaction request failed (HTTP $1)')
    .replace(/\bRelayr-reported\b/gi, 'Reported')
    .replace(/\bRelayr['’]s\b/gi, "the execution service's")
    .replace(/\bRelayr (?=(?:quotes?|payments?|bundles?|funding|authorizations?|requests?|actions?|launch|destinations?|entries|entry|options?|calls?|sessions?|Safe)\b)/gi, '')
    .replace(/\bRelayr\b/gi, 'the execution service')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
