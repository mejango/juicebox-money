const SKILLS_URL = 'https://github.com/mejango/juicebox-skills'

export function AgentSkillsNote({ className = '' }: { className?: string }) {
  return (
    <details className={className}>
      <summary className="min-h-11 py-3 font-agrandir font-medium text-bluebs-700">
        Learn with an AI assistant
      </summary>
      <p className="mt-2 leading-relaxed">
        Give your assistant the{' '}
        <a
          href={SKILLS_URL}
          className="font-medium text-bluebs-700 underline underline-offset-4 hover:text-bluebs-800"
        >
          Juicebox V6 skills
        </a>{' '}
        to help it explain contract addresses, interfaces, and fee calculations. Ask it to cite
        the current contracts so you can check its answers.
      </p>
    </details>
  )
}
