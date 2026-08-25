/**
 * A prompt a supporter can paste into their own AI to audit ONE project's
 * configuration before paying, holding, or trusting it. Complements the
 * protocol-wide AUDIT_PROMPT in ./audit-prompt.ts.
 */
export function projectAuditPrompt(urn: string): string {
  const url = `https://juicebox.money/${urn}`
  return [
    `Audit the Juicebox V6 project at ${url} on my behalf. I am considering paying it, holding its token, or trusting its owner, and I want to know exactly what I would be agreeing to. Be skeptical, precise, and concrete — cite the specific rule or on-chain value behind every claim, and say clearly when something can't be verified.`,
    '',
    'Read every tab of the project page (Overview, Rulesets, Funds, Tokens, Shop, Extras) and treat the live on-chain state shown there as authoritative over the project\'s own description. If you can run code, prefer reading the contracts directly: the protocol and web app are fully open source at https://github.com/Bananapus/version-6 (clone with --recursive), and the page\'s DATA tab exposes the raw queries it uses.',
    '',
    'Cover, in this order:',
    '',
    '1. Who controls it. Owner or revnet operator address per chain, whether it is an EOA, multisig, or contract, and any operators with delegated permissions. Do the authorities match across every chain the project is deployed on?',
    '2. What the owner can do unilaterally. Mint tokens, change the ruleset (and when it takes effect — duration, approval hook, queued rulesets), migrate terminals or controller, set a custom token, add accounting contexts or price feeds, pause payments, or pause credit transfers. Say plainly whether the owner can change the rules with no notice.',
    '3. Where money goes. Payout limits and their recipients, surplus allowance, reserved issuance and its recipients, split hooks, fees, and whether payouts must be sent by the owner or by anyone. Show what fraction of a payment is claimable by the owner versus locked for token holders.',
    '4. What I get for paying. Issuance rate per unit of accepted token, issuance decay, reserved share deducted from payers, any data hook (721 shop, buyback, custom) that changes the amount or adds conditions, and whether an ERC-20 exists or only internal credits.',
    '5. Whether I can get out. Cash-out tax rate (100% = redemptions disabled), whether cash-outs use total or local surplus, what the current redemption value per token would be, and whether a data hook intercepts cash-outs.',
    '6. Cross-chain. Which chains it lives on, whether the deployments are linked by suckers, and whether balances, rules, and authorities are consistent between them.',
    '7. Red flags. Anything unusual relative to a plain, honest fundraise: an owner who can mint freely while cash-outs are disabled, reserved recipients that route to unknown addresses, hooks or approval hooks at unverified contracts, a shop whose items don\'t match the description, or rules that are queued to change soon.',
    '',
    'Finish with a one-paragraph plain-English verdict for a non-technical supporter: what happens to their money, what they own afterward, what the owner can do to them, and the single most important risk. Then list open questions I should ask the project directly.',
  ].join('\n')
}
