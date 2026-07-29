import { getRecentActivity } from '../src/lib/bendystraw'
import { getTrendingCards } from '../src/lib/trending'

async function main() {
  const [cards, activity] = await Promise.all([
    getTrendingCards(12),
    getRecentActivity(12),
  ])

  const names = new Set(cards.map(card => card.name))
  for (const required of ['Browser Fixture Project']) {
    if (!names.has(required)) {
      throw new Error(`Deterministic build data omitted ${required}`)
    }
  }

  if (!activity.some(event => event.id === 'browser-fixture-payment')) {
    throw new Error('Deterministic build data omitted browser-fixture-payment')
  }
}

void main()
