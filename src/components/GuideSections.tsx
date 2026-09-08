import './GuideSections.css'

/**
 * Server-rendered Learn and Build documents with native section navigation.
 * Keep content readable before hydration and when JavaScript is unavailable.
 */

type GuideAudience = 'founders' | 'frontend' | 'contracts'

const AUDIENCE_LABEL: Record<GuideAudience, string> = {
  founders: 'Project builders',
  frontend: 'App builders',
  contracts: 'Contract builders',
}

type GuideLink = { href: string; label: string }

type GuideBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; label: string; code: string }
  | { type: 'diagram'; label: string; description?: string; lines: readonly string[] }
  | { type: 'table'; label: string; rows: readonly (readonly [string, string])[] }
  | {
      type: 'compare'
      label: string
      columns: readonly [string, string]
      rows: readonly (readonly [string, string])[]
    }
  | { type: 'steps'; items: readonly string[] }
  | { type: 'points'; items: readonly { key: string; text: string }[] }
  | { type: 'info'; text: string }
  | { type: 'links'; items: readonly GuideLink[] }

export type GuideSection = {
  id: string
  aliases?: readonly string[]
  part: string
  audience?: readonly GuideAudience[]
  title: string
  paragraphs?: readonly string[]
  blocks?: readonly GuideBlock[]
}

function Block({ block, id }: { block: GuideBlock; id: string }) {
  switch (block.type) {
    case 'text':
      return <p className="guide-text">{block.text}</p>
    case 'code':
      return (
        <figure className="guide-code">
          <figcaption id={`${id}-label`} className="guide-code-title">{block.label}</figcaption>
          <div className="guide-scroll" role="region" aria-labelledby={`${id}-label`} tabIndex={0}>
            <pre className="guide-code-pre"><code>{block.code}</code></pre>
          </div>
        </figure>
      )
    case 'diagram':
      return (
        <figure className="guide-diagram">
          <figcaption id={`${id}-label`} className="guide-diagram-title">{block.label}</figcaption>
          {block.description ? (
            <p id={`${id}-description`} className="guide-diagram-description">{block.description}</p>
          ) : null}
          <div
            className="guide-scroll"
            role="region"
            aria-labelledby={`${id}-label`}
            aria-describedby={block.description ? `${id}-description` : undefined}
            tabIndex={0}
          >
            <pre className="guide-diagram-pre" aria-hidden={block.description ? true : undefined}>
              {block.lines.join('\n')}
            </pre>
          </div>
        </figure>
      )
    case 'table':
      return (
        <div className="guide-prop-table">
          <h3 id={`${id}-label`} className="guide-prop-title">{block.label}</h3>
          <dl aria-labelledby={`${id}-label`}>
            {block.rows.map(([name, desc]) => (
              <div key={name} className="guide-prop-row">
                <dt className="guide-prop-name">{name}</dt>
                <dd className="guide-prop-desc">{desc}</dd>
              </div>
            ))}
          </dl>
        </div>
      )
    case 'compare':
      return (
        <div className="guide-prop-table guide-compare-wrap">
          <table className="guide-compare-table">
            <caption className="guide-prop-title">{block.label}</caption>
            <thead>
              <tr>
                {block.columns.map(column => <th key={column} scope="col">{column}</th>)}
              </tr>
            </thead>
            <tbody>
              {block.rows.map(([left, right]) => (
                <tr key={left}>
                  <td>{left}</td>
                  <td>{right}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'steps':
      return (
        <ol className="guide-steps" role="list">
          {block.items.map((item, i) => (
            <li key={item} className="guide-step">
              <span className="guide-step-num" aria-hidden="true">{i + 1}</span>
              <span className="guide-text mb-0">{item}</span>
            </li>
          ))}
        </ol>
      )
    case 'points':
      return (
        <ul className="my-4 space-y-2" role="list">
          {block.items.map(item => (
            <li key={item.key} className="guide-text mb-0 pl-4 -indent-4">
              <strong className="font-medium text-ink">{item.key}:</strong> {item.text}
            </li>
          ))}
        </ul>
      )
    case 'info':
      return <div className="guide-info">{block.text}</div>
    case 'links':
      return (
        <ul className="guide-resource-links guide-text" role="list">
          {block.items.map(item => (
            <li key={item.href}><a href={item.href}>{item.label}</a></li>
          ))}
        </ul>
      )
  }
}

export function GuideSections({
  sections,
  ariaLabel,
}: {
  sections: readonly GuideSection[]
  ariaLabel: string
}) {
  const parts = sections.reduce<{ part: string; sections: GuideSection[] }[]>((acc, section) => {
    const last = acc[acc.length - 1]
    if (last && last.part === section.part) last.sections.push(section)
    else acc.push({ part: section.part, sections: [section] })
    return acc
  }, [])
  const numberOf = new Map(sections.map((section, i) => [section.id, i + 1]))
  const contentsId = `${sections[0]?.id ?? 'guide'}-contents`

  const contents = (
    <div className="guide-toc-groups">
      {parts.map(group => (
        <div key={group.part} className="guide-toc-group">
          <p className="guide-toc-group-label">{group.part}</p>
          <ol role="list">
            {group.sections.map(section => (
              <li key={section.id}>
                <a className="guide-toc-link" href={`#${section.id}`}>
                  {numberOf.get(section.id)}. {section.title}
                </a>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  )

  return (
    <article className="juicebox-guide" aria-label={ariaLabel}>
      <div className="guide-wrap">
        <nav id={contentsId} className="guide-toc" aria-label={`${ariaLabel} contents`} tabIndex={-1}>
          <details className="guide-toc-mobile">
            <summary className="guide-toc-title">Table of contents ({sections.length} sections)</summary>
            {contents}
          </details>
          <div className="guide-toc-desktop">
            <h2 className="guide-toc-title">Table of contents</h2>
            {contents}
          </div>
        </nav>

        <div className="guide-content">
          {parts.map(group => (
            <div key={group.part}>
              <div className="guide-part-header">{group.part}</div>
              {group.sections.map(section => (
                <section key={section.id} id={section.id} className="guide-section" tabIndex={-1}>
                  {section.aliases?.map(alias => (
                    <span key={alias} id={alias} className="guide-section-alias sr-only" tabIndex={-1}>
                      {section.title}
                    </span>
                  ))}
                  <h2 className="guide-section-title">
                    <a className="guide-section-link" href={`#${section.id}`}>
                      <span>{numberOf.get(section.id)}. {section.title}</span>
                      <span className="guide-section-link-mark" aria-hidden="true">#</span>
                    </a>
                  </h2>
                  {section.audience?.length ? (
                    <p className="mb-4 flex flex-wrap gap-2">
                      <span className="sr-only">For: </span>
                      {section.audience.map(audience => (
                        <span
                          key={audience}
                          className="rounded-full border border-bluebs-200 bg-bluebs-25 px-2.5 py-1 font-agrandir text-xs font-medium text-bluebs-700"
                        >
                          {AUDIENCE_LABEL[audience]}
                        </span>
                      ))}
                    </p>
                  ) : null}
                  {section.paragraphs?.map(paragraph => (
                    <p key={paragraph} className="guide-text">
                      {paragraph}
                    </p>
                  ))}
                  {section.blocks?.map((block, i) => (
                    <Block key={i} block={block} id={`${section.id}-block-${i}`} />
                  ))}
                  <p className="guide-section-footer">
                    <a href={`#${contentsId}`}>Back to contents<span aria-hidden="true"> ↑</span></a>
                  </p>
                </section>
              ))}
            </div>
          ))}
        </div>
      </div>
    </article>
  )
}
