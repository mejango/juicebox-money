import { createWriteHold } from '@bananapus/nana-sdk-core/review'

/**
 * The app's one SDK write hold: every wallet write is held through it
 * (storage or this tab's memory, one lock per exact call, the states, the
 * exits and the release rules).
 */
export const writeHolds = createWriteHold()
