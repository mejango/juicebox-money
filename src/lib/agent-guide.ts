/** Agent-facing facts shared by /llms.txt and /skill.md. */
export const JUICEBOX_MCP_URL = 'https://juicebox.center/mcp'
export const JUICEBOX_CENTER_API_URL = 'https://juicebox.center/api'
export const JUICEBOX_SKILLS_URL = 'https://github.com/mejango/juicebox-skills'
export const JUICEBOX_MCP_GUIDE_URL = 'https://github.com/mejango/jbcenter/blob/main/mcp/README.md'
export const JUICEBOX_MCP_CONNECT = `Connect: Streamable HTTP at ${JUICEBOX_MCP_URL}, POST only, no session (a GET returns 405). Client config: {"mcpServers":{"juicebox":{"url":"${JUICEBOX_MCP_URL}"}}}.`
export const CHAIN_SLUGS =
  '`eth` (1), `op` (10), `base` (8453), `arb` (42161), plus testnets `sep` (11155111), `opsep` (11155420), `basesep` (84532), `arbsep` (421614)'
