# juicebox.money design system — "juice terminal"

The site should feel like juicy.vision's sibling: an arcade terminal, not
another SaaS landing page. Dark, monospace, neon-framed panels, dense color.
Unique and a little loud — but everything still legible and mainstream-usable.
Reference: juicy.vision (dark mosaic of colored chips, orange-framed bento
panels, live activity rail, bold statement copy).

## Foundations
- **Single dark theme.** Background `#141217` (near-black plum-charcoal) with a
  very subtle radial glow (juice orange at ~6% opacity, top-right). No light mode.
- **Monospace everywhere.** System mono stack: `ui-monospace, "SF Mono",
  "Cascadia Mono", "JetBrains Mono", Menlo, monospace`. No webfont dependency.
- **Panels, not cards.** Regions are hard-edged panels: `border: 2px solid` in
  a strong accent, radius 6px MAX, background `#1c1922` (panel surface), tiled
  bento-style with 12–16px gaps. The page is a composition of framed panels —
  like a tiling window manager.
- **Copy voice**: bold, direct, a little cheeky. "Fund your thing." /
  "Don't just stand there." No corporate fluff. Sentence case.

## Color
- `bg`: #141217 · `panel`: #1c1922 · `panel2`: #221e2a (nested)
- `ink`: #F2EFE6 (primary text) · `dim`: #9b95a8 (secondary)
- `juice`: #FFB32C (frames, primary CTAs, highlights) — the brand anchor
- `cyan`: #46E4D8 (inputs focus, interactive outlines)
- `lime`: #7DE858 (success, positive amounts, links-on-dark)
- `magenta`: #E85D9B (accents, event highlights)
- `teal`: #2A9D8F, `olive`: #8A8A1F, `navy`: #274690 (chip family, cycle for
  tags/chains) — chips are SOLID blocks with light text, tiny (11–12px), like
  keyboard keys.
- Amount coloring in data: ETH amounts in juice orange, token amounts in lime,
  addresses/timestamps in dim.

## Signature elements
1. **Framed bento layout**: the home page = tiled panels (hero statement panel,
   trending mosaic panel, live activity rail panel). Panel frames alternate
   juice orange (primary regions) and dim (#39333f) for secondary ones.
2. **Chip mosaic**: tags, chains, versions render as dense solid-color chips
   with 1-2 letter badges where useful. Chain chips: ETH=dim-gray, OP=red,
   BASE=navy blue, ARB=cyan-blue — solid blocks, white/light text, uppercase.
3. **Live activity rail** ("Fresh activity"): right column on desktop, below
   the fold on mobile. Monospace rows: `<who> paid 0.01 ETH → <project>` with
   colored amounts, relative time, chain chip. Auto-refreshing (poll ~15s).
4. **CTAs**: solid juice blocks, black mono text, subtle 2px hard shadow
   (offset 3px, no blur — printed-sticker feel). Hover: shadow collapses +
   translate(1px,1px). Focus: cyan 2px outline.
5. **Inputs**: dark wells (#0f0d12), 2px cyan border on focus, mono
   placeholder in dim.
6. **The juice character energy**: we don't have the mascot art in-repo; use
   the 🧃 mark + "JUICE!" burst-style headline accents (skewed juice-colored
   highlight behind key words) instead. No stock illustrations.

## Elektron synthesis (second reference: elektron.se)
juicy.vision brings the density and color; Elektron brings the restraint and
the hardware-instrument feel. The blend:
- **Bands + bento, not bento everywhere.** Pages are full-width horizontal
  bands (Elektron) separated by plain dark space; the juicy framed-panel bento
  lives INSIDE the bands that earn it (trending mosaic, activity rail). Not
  every region gets a frame — negative space is part of the design.
- **Pixel-outline buttons (secondary actions).** Uppercase mono label,
  1–2px light border, transparent background — like silkscreened hardware
  buttons ("FIND OUT MORE"). Primary CTAs stay solid juice blocks. ALL button
  labels uppercase.
- **Silkscreen labels.** Tiny uppercase dim labels over values everywhere
  (ETH RAISED / PAYMENTS / SUPPORTERS) — instrument-panel typography. Already
  in the stat rows; apply consistently (inputs, activity, chips).
- **One expressive headline moment per page.** Elektron's hand-painted
  "SYNTAKT 1.40" energy — ours is a heavy, slightly rotated juice-orange
  highlight mark behind the key headline words (CSS only, -1.5deg skew, rough
  edge via clip-path polygon). Body stays strict mono; the contrast between
  one loud element and an otherwise disciplined page IS the look.
- **Hero restraint.** The home hero is a near-empty dark band: the statement,
  one line of copy, two buttons (one solid, one pixel-outline). Let the
  activity rail and trending mosaic below carry the color density.

## Rules
- Responsive first: bento collapses to a single column on mobile; the activity
  rail stacks under trending; chips wrap; touch targets ≥44px.
- Accessibility: all text ≥ 4.5:1 on its surface (dim on panel passes; check
  chip text); focus outlines always visible; prefers-reduced-motion disables
  the hover translate + confetti.
- Lean: no new dependencies, no images except project logos, CSS-only effects.
- Every page (home, project, create, 404) speaks this language — no mixed
  light/dark leftovers. Para modal theme flips to dark (#1c1922 bg, juice
  foreground).
