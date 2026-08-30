const SKILLS_URL = 'https://github.com/mejango/juicebox-skills'

/** The one line for readers learning with an agent: the skills library it should answer from. */
export function AgentSkillsNote({ className = '' }: { className?: string }) {
  return (
    <p className={className}>
      Reading with an agent? Give it the{' '}
      <a
        href={SKILLS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="font-agrandir font-medium text-bluebs-700 underline decoration-bluebs-300 underline-offset-4 hover:text-bluebs-800"
      >
        Juicebox V6 skills
      </a>{' '}
      so it answers from the deployed addresses, ABIs, and fee math rather than from memory.
    </p>
  )
}
