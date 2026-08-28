const SKILLS_URL = 'https://github.com/mejango/juicebox-skills'

/**
 * The one-line pointer to the skills library, for readers who are learning or building with an
 * agent. Reads fine to a person too: it names what the library is and where it lives.
 */
export function AgentSkillsNote({ className = '' }: { className?: string }) {
  return (
    <p className={className}>
      Working with an AI agent? Give it the{' '}
      <a
        href={SKILLS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="font-agrandir font-medium text-bluebs-700 underline decoration-bluebs-300 underline-offset-4 hover:text-bluebs-800"
      >
        Juicebox V6 skills
      </a>
      , a Claude Code plugin that carries the deployed addresses, ABIs, and fee math.
    </p>
  )
}
