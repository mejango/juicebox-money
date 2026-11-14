import { CHAIN_SLUGS, JUICEBOX_CENTER_API_URL, JUICEBOX_MCP_GUIDE_URL, JUICEBOX_MCP_URL, JUICEBOX_SKILLS_URL } from '@/lib/agent-guide'
import { publicReadHeaders } from '@/lib/api-cache'
import { JUICEBOX_ONE_LINER } from '@/lib/one-liner'

const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001'

/**
 * llmstxt.org index: the URL grammar and JSON endpoints an agent needs to read this
 * site without scraping rendered markup or guessing route shapes.
 */
const LLMS_TXT = `# Juicebox

> ${JUICEBOX_ONE_LINER}
> A Juicebox project takes payments, issues tokens as incentives, pays out on a
> schedule, and lets holders cash out, under rules its owner sets. This site runs Juicebox V6 on
> Ethereum, Base, Arbitrum, and Optimism, reading the contracts and Bendystraw, an
> index of their records.

## URL grammar

- \`/<chain>:<projectId>\`: a project identified by its network and ID, e.g. \`/base:10\`.
  Chain slugs: ${CHAIN_SLUGS}.
- \`/@<handle>\`: the same project by its verified ENS handle, e.g. \`/@slopshop\`.
  A handle is only served when ENS and the JBProjectHandles registry agree that the
  project's current owner or operator claimed it, so it names exactly one project.
- \`/account/<address-or-ens>\`: holdings and activity for one account. Not indexed.

Each project page carries schema.org Organization JSON-LD with its canonical URL,
identifier, description and logo.

## Pages

- [Home](${siteOrigin}/): projects ranked by balance.
- [Learn](${siteOrigin}/learn): how Juicebox works.
- [Glossary](${siteOrigin}/learn#learn-glossary): definitions for terms used in the guides.
- [Fees](${siteOrigin}/learn#learn-fees): the full explanation of costs and the revnet tokens shared with payers.
- [Build](${siteOrigin}/build): launch a project, connect an app, or write contracts.
- [Your first test payment](${siteOrigin}/build/first-payment): read Base Sepolia project 1, preview a payment, then try it in the app and check the result.
- [Read example](${siteOrigin}/examples/read-project.mjs): complete working V6 example with exact package versions.
- [Simulation example](${siteOrigin}/examples/preview-payment.mjs): prepare, decode, and simulate a test payment using a public address. Never signs or broadcasts.
- [Launch example](${siteOrigin}/examples/launch-project.mjs): build a project launch and simulate it on Base Sepolia for a public owner address. Never signs or broadcasts.
- [Hook example](${siteOrigin}/examples/MyPayHook.sol): a data hook and pay hook that builds with Foundry. Unaudited example code.
- [Create](${siteOrigin}/create): the project launch flow.
- [Audit](${siteOrigin}/audit): audits, source, and review prompts.

## For agents

- [Agent skill](${siteOrigin}/skill.md): how to launch, check, pay, cash out, and run projects here.
- [Learn as Markdown](${siteOrigin}/learn.md) and [Build as Markdown](${siteOrigin}/build.md): the full guides with section anchors.
- [Juicebox MCP](${JUICEBOX_MCP_URL}): reads, quotes, metadata pinning, and unsigned
  transaction plans. Holds no keys; the user signs.
- [MCP guide](${JUICEBOX_MCP_GUIDE_URL}): how to connect a client.
- [Contract addresses](https://juicebox.center/api/v1/catalog/contracts): every V6 contract per chain, keyless JSON.
- [Juicebox Center API](${JUICEBOX_CENTER_API_URL}): RPC, IPFS, and indexed data in one place.
- [Juicebox V6 skills](${JUICEBOX_SKILLS_URL}): instructions for launching,
  paying, cashing out, loans, and integrations.
- [Launch with an AI assistant](${siteOrigin}/build#founders-launch-with-an-agent): the MCP or a .jb draft.
- [Example .jb draft](${siteOrigin}/examples/project.jb): one project on Base that imports at ${siteOrigin}/create.
  Only \`v\`, \`kind\` and \`stages\` are required, and an unknown key refuses the file. Numbers are written
  as text. \`issuance\` is tokens per ETH, \`duration\` is seconds (\`0\` for no cycles), \`cutPercent\` and a
  split's \`share\` are 0 to 100, and \`cashOutTax\` runs 0 to 1 (\`"0.1"\`, with \`"1"\` for cash outs off).
- [Juicebox Center for apps](${siteOrigin}/build#apps-juicebox-center): one place for chain data, files, and indexed data.
- [Audit prompts](${siteOrigin}/audit): review the whole system or one transaction.

## JSON endpoints

Read-only, no key required, cached at the edge. Terms are not in the page HTML; read
\`/api/project-terms\`, or use \`jb_get_rulesets\` on the MCP.

- \`GET /api/search?q=<text>\`: projects matching a name, handle or id.
- \`GET /api/top-projects?limit=<1-32>&offset=<n>\`: projects ranked by balance.
- \`GET /api/project-name?chainId=<id>&projectId=<id>\`: project name and the group linking its chains (sucker group).
- \`GET /api/project-terms?chainId=<id>&projectId=<id>\`: what a payment gets under the current rules and any queued ones: tokens per unit paid, reserved percent, cash out tax, data hook. Its \`units\` field states each unit.
- \`GET /api/project-ready?chainId=<id>&projectId=<id>\`: whether a launched project is indexed yet.
- \`GET /api/participants?suckerGroupId=<id>\`: token holders across chains.
- \`GET /api/movements?suckerGroupId=<id>\`: token moves queued between chains. Empty when none are queued, which says nothing about payments.
- \`GET /api/price-history?suckerGroupId=<id>&chainId=<id>\`: price of newly created tokens over time.
- \`GET /api/loans?chainId=<id>&projectId=<id>\`: loans taken against project tokens.
- \`GET /api/project-og/<chainId>/<projectId>\`: 1200x630 PNG link-preview card.

## Source

- Protocol contracts: https://github.com/Bananapus/version-6
- This client: https://github.com/mejango/juicebox-money
- Contract explorer: https://juicebox.center/#apps/juicescan
- Inspect the example: https://juicebox.money/basesep:1
`

export const revalidate = 3600

export function GET() {
  return new Response(LLMS_TXT, {
    headers: { ...publicReadHeaders, 'content-type': 'text/plain; charset=utf-8' },
  })
}
