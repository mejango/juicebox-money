import { publicReadHeaders } from '@/lib/api-cache'

const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001'

/**
 * llmstxt.org index: the URL grammar and JSON endpoints an agent needs to read this
 * site without scraping rendered markup or guessing route shapes.
 */
const LLMS_TXT = `# Juicebox

> Juicebox lets projects collect money, share tokens, and set rules for funds.
> This site uses the V6 contracts on Ethereum, Optimism, Base and Arbitrum.
> Project data comes from those chains and Bendystraw, a searchable index of
> chain records.

## URL grammar

- \`/<chain>:<projectId>\` — a project identified by its network and ID, e.g. \`/base:10\`.
  Chain slugs: \`eth\`, \`op\`, \`base\`, \`arb\`, plus \`sep\`, \`opsep\`, \`basesep\`, \`arbsep\` for testnets.
- \`/@<handle>\` — the same project by its verified ENS handle, e.g. \`/@slopshop\`.
  A handle is only served when ENS and the JBProjectHandles registry agree that the
  project's current owner or operator claimed it, so it names exactly one project.
- \`/account/<address-or-ens>\` — holdings and activity for one account. Not indexed.

Each project page carries schema.org Organization JSON-LD with its canonical URL,
identifier, description and logo.

## Pages

- [Home](${siteOrigin}/): projects ranked by funds held.
- [Learn](${siteOrigin}/learn): how Juicebox works.
- [Glossary](${siteOrigin}/learn#learn-glossary): definitions for terms used in the guides.
- [Fees](${siteOrigin}/learn#learn-fees): the full explanation of costs and the revnet tokens shared with payers.
- [Build](${siteOrigin}/build): launch a project, connect an app, or write contracts.
- [Your first test payment](${siteOrigin}/build/first-payment): read Base Sepolia project 1, preview a payment, then try it in the app and check the result.
- [Read example](${siteOrigin}/examples/read-project.mjs): complete working V6 example with exact package versions.
- [Simulation example](${siteOrigin}/examples/preview-payment.mjs): prepare, decode, and simulate a test payment using a public address. Never signs or broadcasts.
- [Create](${siteOrigin}/create): the project launch flow.
- [Audit](${siteOrigin}/audit): audits, source, and review prompts.

## JSON endpoints

Read-only, no key required, cached at the edge.

- \`GET /api/search?q=<text>\` — projects matching a name, handle or id.
- \`GET /api/top-projects?limit=<1-32>&offset=<n>\` — projects ranked by funds held.
- \`GET /api/project-name?chainId=<id>&projectId=<id>\` — project name and the group linking its chains (sucker group).
- \`GET /api/project-ready?chainId=<id>&projectId=<id>\` — whether a launched project is indexed yet.
- \`GET /api/participants?suckerGroupId=<id>\` — token holders across chains.
- \`GET /api/movements?suckerGroupId=<id>\` — payments and cash outs.
- \`GET /api/price-history?suckerGroupId=<id>&chainId=<id>\` — price of newly created tokens over time.
- \`GET /api/loans?...\` — loans taken against project tokens.
- \`GET /api/project-og/<chainId>/<projectId>\` — 1200x630 PNG link-preview card.

## Source

- Protocol contracts: https://github.com/Bananapus/version-6
- This client: https://github.com/mejango/juicebox-money
- Contract explorer: https://juicebox.center/#apps/juicescan
- Inspect the example: https://juicebox.center/inspect/basesep/1
`

export const revalidate = 3600

export function GET() {
  return new Response(LLMS_TXT, {
    headers: { ...publicReadHeaders, 'content-type': 'text/plain; charset=utf-8' },
  })
}
