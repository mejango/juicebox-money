/**
 * Server-side Infura IPFS pinning. Credentials never reach the client — both
 * pin routes call through here. Same auth + endpoint mechanics as the classic
 * juicebox.money site.
 */

const INFURA_IPFS_API_BASE = 'https://ipfs.infura.io:5001'

export async function pinToIpfs(
  content: Blob | string,
  filename = 'file',
): Promise<string> {
  const projectId = process.env.INFURA_IPFS_PROJECT_ID
  const secret = process.env.INFURA_IPFS_API_SECRET
  if (!projectId || !secret) {
    throw new Error('IPFS pinning is not configured')
  }

  const form = new FormData()
  form.append(
    'file',
    typeof content === 'string'
      ? new Blob([content], { type: 'application/json' })
      : content,
    filename,
  )

  const res = await fetch(`${INFURA_IPFS_API_BASE}/api/v0/add?pin=true`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${projectId}:${secret}`).toString('base64')}`,
    },
    body: form,
  })
  if (!res.ok) throw new Error(`ipfs add failed: ${res.status}`)

  const json = (await res.json()) as { Hash?: string }
  if (!json.Hash) throw new Error('ipfs add returned no hash')
  return json.Hash
}
