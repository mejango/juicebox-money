import type { GuideAudience, GuideBlock, GuideSection } from '@/components/GuideSections'

export const GUIDE_AUDIENCE_LABEL: Record<GuideAudience, string> = {
  founders: 'Project builders',
  frontend: 'App builders',
  contracts: 'Contract builders',
}

/** The id of a table row that has a `rowIdPrefix`, and of a labelled block within its section. */
export function guideRowId(prefix: string, name: string) {
  return `${prefix}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

/**
 * A guide as Markdown, from the same sections the page renders. `pageUrl` is the
 * guide's absolute URL; every link leaves here absolute.
 */
export function guideMarkdown({
  title,
  intro,
  pageUrl,
  sections,
}: {
  title: string
  intro: string
  pageUrl: string
  sections: readonly GuideSection[]
}) {
  const origin = new URL(pageUrl).origin
  const absolute = (href: string) =>
    href.startsWith('#') ? `${pageUrl}${href}` : href.startsWith('/') ? `${origin}${href}` : href
  const inline = (text: string) =>
    text.replace(/\]\(([#/][^)\s]*)\)/g, (_, href: string) => `](${absolute(href)})`)
  const cell = (text: string) => inline(text).replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const table = (head: readonly string[], rows: readonly (readonly string[])[]) =>
    [head, head.map(() => '---'), ...rows].map(row => `| ${row.map(cell).join(' | ')} |`).join('\n')
  // A fence longer than any run of backticks inside the block.
  const fenced = (lang: string, body: string) => {
    const fence = '`'.repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map(run => run.length + 1)))
    return `${fence}${lang}\n${body}\n${fence}`
  }

  const block = (sectionId: string, b: GuideBlock): string => {
    switch (b.type) {
      case 'text':
        return inline(b.text)
      case 'info':
        return `> ${inline(b.text)}`
      case 'code':
        return `**${b.label}**\n\n${fenced(b.lang ?? '', b.code)}`
      case 'diagram':
        return [`**${b.label}**`, ...(b.description ? [b.description] : []), fenced('text', b.lines.join('\n'))].join('\n\n')
      case 'table':
        return `### ${b.label} {#${guideRowId(sectionId, b.label)}}\n\n${table(['Name', 'Description'], b.rows)}`
      case 'compare':
        return `**${b.label}**\n\n${table(b.columns, b.rows)}`
      case 'steps':
        return b.items.map((item, i) => `${i + 1}. ${inline(item)}`).join('\n')
      case 'points':
        return b.items.map(item => `- **${item.key}:** ${inline(item.text)}`).join('\n')
      case 'links':
        return b.items.map(item => `- [${item.label}](${absolute(item.href)})`).join('\n')
    }
  }

  return [
    `# ${title}`,
    intro,
    `Web version: ${pageUrl}`,
    ...sections.flatMap(section => [
      `## ${section.title} {#${section.id}}`,
      ...(section.audience?.length
        ? [`For: ${section.audience.map(audience => GUIDE_AUDIENCE_LABEL[audience]).join(', ')}`]
        : []),
      ...(section.paragraphs ?? []).map(inline),
      ...(section.blocks ?? []).map(b => block(section.id, b)),
    ]),
  ].join('\n\n') + '\n'
}
