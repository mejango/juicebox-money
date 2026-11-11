import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GET as llms } from '@/app/llms.txt/route'
import { GET as skill } from '@/app/skill.md/route'
import { stageCashOutTax, stageOk } from '@/components/create/stage-draft'
import { parseDraft } from '@/lib/draft'
import { cashOutTaxValue } from '@/lib/format'

describe('the published example draft', () => {
  // /skill.md and /llms.txt send agents to this file, so it has to keep importing.
  const source = readFileSync('public/examples/project.jb', 'utf8')

  it('imports every value it states into a stage the launch form accepts', () => {
    const file = JSON.parse(source)
    const draft = parseDraft(source)
    expect(draft).toMatchObject(file)
    expect(stageOk(draft.stages[0], true, 'project', false, draft.chains)).toBe(true)
    // The unit /llms.txt states beside the link.
    expect(cashOutTaxValue(stageCashOutTax(draft.stages[0]))).toBe('0.1')
  })

  it('is linked from both agent files, which map chain slugs to ids', async () => {
    const [map, instructions] = await Promise.all([llms().text(), skill().text()])
    for (const text of [map, instructions]) {
      expect(text).toContain('`base` (8453)')
      expect(text).toContain('/examples/project.jb')
      expect(text).toContain('https://github.com/mejango/jbcenter/blob/main/mcp/README.md')
      expect(text).not.toContain('·')
    }
    expect(instructions).toContain('POST only, no session (a GET returns 405)')
    expect(map).toContain('`GET /api/loans?chainId=<id>&projectId=<id>`')
  })
})
