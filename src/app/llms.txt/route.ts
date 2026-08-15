import { publicReadHeaders } from '@/lib/api-cache'

const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001'

/**
 * llmstxt.org index: the URL grammar and JSON endpoints an agent needs to read this
 * site without scraping rendered markup or guessing route shapes.
 */
const LLMS_TXT = `# Juicebox

> Juicebox is an onchain funding protocol. This site reads and writes Juicebox V6
> projects across Ethereum, Optimism, Base and Arbitrum. Every number shown is
> derived from onchain state or the Bendystraw indexer, never from a private
> database.

## URL grammar

- \`/<chain>:<projectId>\` — a project by its chain-scoped id, e.g. \`/base:10\`.
  Chain slugs: \`eth\`, \`op\`, \`base\`, \`arb\`, plus \`sep\`, \`opsep\`, \`basesep\`, \`arbsep\` for testnets.
- \`/@<handle>\` — the same project by its verified ENS handle, e.g. \`/@slopshop\`.
  A handle is only served when ENS and the JBProjectHandles registry agree that the
  project's current owner or operator claimed it, so it names exactly one project.
- \`/account/<address-or-ens>\` — holdings and activity for one account. Not indexed.

Each project page carries schema.org Organization JSON-LD with its canonical URL,
identifier, description and logo.

## Pages

- [Home](${siteOrigin}/): projects ranked by treasury balance.
- [Learn](${siteOrigin}/learn): what the protocol does and the vocabulary it uses.
- [Build](${siteOrigin}/build): integration guide, contract addresses, SDK pointers.
- [Create](${siteOrigin}/create): the project launch flow.
- [Audit](${siteOrigin}/audit): audits and security posture.

## JSON endpoints

Read-only, no key required, cached at the edge.

- \`GET /api/search?q=<text>\` — projects matching a name, handle or id.
- \`GET /api/top-projects?limit=<1-32>&offset=<n>\` — treasury-ranked projects.
- \`GET /api/project-name?chainId=<id>&projectId=<id>\` — canonical name and sucker group.
- \`GET /api/project-ready?chainId=<id>&projectId=<id>\` — whether a launched project is indexed yet.
- \`GET /api/participants?suckerGroupId=<id>\` — token holders across chains.
- \`GET /api/movements?suckerGroupId=<id>\` — payments and cash outs.
- \`GET /api/price-history?suckerGroupId=<id>&chainId=<id>\` — issuance price over time.
- \`GET /api/loans?...\` — loans taken against project tokens.
- \`GET /api/project-og/<chainId>/<projectId>\` — 1200x630 PNG link-preview card.

## Source

- Protocol contracts: https://github.com/Bananapus/version-6
- This client: https://github.com/mejango/juicebox-money
- Contract explorer: https://juicescan.io
`

export const revalidate = 3600

export function GET() {
  return new Response(LLMS_TXT, {
    headers: { ...publicReadHeaders, 'content-type': 'text/plain; charset=utf-8' },
  })
}
