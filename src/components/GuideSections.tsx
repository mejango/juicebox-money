'use client'

import { useEffect } from 'react'

/**
 * Data-driven guide renderer. Uses the `.juicebox-guide` classes in globals.css so it reads the
 * same as the Learn tab's DOM renderer, and adds part groupings, audience tags, compare tables,
 * and per-section links.
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
  | { type: 'diagram'; label: string; lines: readonly string[] }
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
  part: string
  audience?: readonly GuideAudience[]
  title: string
  paragraphs?: readonly string[]
  blocks?: readonly GuideBlock[]
}

function Link({ href, label }: GuideLink) {
  const external = href.startsWith('http')
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {label}
    </a>
  )
}

function Block({ block }: { block: GuideBlock }) {
  switch (block.type) {
    case 'text':
      return <p className="guide-text">{block.text}</p>
    case 'code':
      return (
        <div className="guide-code">
          <div className="guide-code-title">{block.label}</div>
          <pre className="guide-code-pre" tabIndex={0}>
            {block.code}
          </pre>
        </div>
      )
    case 'diagram':
      return (
        <div className="guide-diagram">
          <div className="guide-diagram-title">{block.label}</div>
          <pre className="guide-diagram-pre">{block.lines.join('\n')}</pre>
        </div>
      )
    case 'table':
      return (
        <div className="guide-prop-table">
          <div className="guide-prop-title">{block.label}</div>
          {block.rows.map(([name, desc]) => (
            <div key={name} className="guide-prop-row">
              <div className="guide-prop-name">{name}</div>
              <div className="guide-prop-desc">{desc}</div>
            </div>
          ))}
        </div>
      )
    case 'compare':
      return (
        <div className="guide-prop-table">
          <div className="guide-prop-title">{block.label}</div>
          <div className="guide-prop-row bg-smoke-50">
            <div className="font-agrandir text-xs font-medium text-ink">{block.columns[0]}</div>
            <div className="font-agrandir text-xs font-medium text-ink">{block.columns[1]}</div>
          </div>
          {block.rows.map(([left, right]) => (
            <div key={left} className="guide-prop-row">
              <div className="guide-prop-desc">{left}</div>
              <div className="guide-prop-desc">{right}</div>
            </div>
          ))}
        </div>
      )
    case 'steps':
      return (
        <ol className="guide-steps">
          {block.items.map((item, i) => (
            <li key={item} className="guide-step">
              <span className="guide-step-num">{i + 1}</span>
              <span className="guide-text mb-0">{item}</span>
            </li>
          ))}
        </ol>
      )
    case 'points':
      return (
        <ul className="my-4 space-y-2">
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
        <p className="guide-text flex flex-wrap gap-x-5 gap-y-1">
          {block.items.map(item => (
            <Link key={item.href} {...item} />
          ))}
        </p>
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
  useEffect(() => {
    const target = window.location.hash
      ? document.getElementById(window.location.hash.slice(1))
      : null
    target?.scrollIntoView({ block: 'start' })
  }, [])

  const parts = sections.reduce<{ part: string; sections: GuideSection[] }[]>((acc, section) => {
    const last = acc[acc.length - 1]
    if (last && last.part === section.part) last.sections.push(section)
    else acc.push({ part: section.part, sections: [section] })
    return acc
  }, [])
  const numberOf = new Map(sections.map((section, i) => [section.id, i + 1]))

  return (
    <div className="juicebox-guide" aria-label={ariaLabel}>
      <div className="guide-wrap">
        <nav className="guide-toc" aria-label={`${ariaLabel} contents`}>
          <div className="guide-toc-title">Table of contents</div>
          {parts.map(group => (
            <div key={group.part}>
              <div className="guide-toc-group-label">{group.part}</div>
              {group.sections.map(section => (
                <a key={section.id} className="guide-toc-link" href={`#${section.id}`}>
                  {numberOf.get(section.id)}. {section.title}
                </a>
              ))}
            </div>
          ))}
        </nav>

        {parts.map(group => (
          <div key={group.part}>
            <div className="guide-part-header">{group.part}</div>
            {group.sections.map(section => (
              <section key={section.id} id={section.id} className="guide-section">
                <h2 className="guide-section-title">
                  {numberOf.get(section.id)}. {section.title}
                </h2>
                {section.audience?.length ? (
                  <p className="mb-4 flex flex-wrap gap-2">
                    {section.audience.map(audience => (
                      <span
                        key={audience}
                        className="rounded-full border border-bluebs-200 bg-bluebs-25 px-2.5 py-0.5 font-agrandir text-[11px] font-medium uppercase tracking-[0.08em] text-bluebs-700"
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
                  <Block key={i} block={block} />
                ))}
              </section>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
