# juicebox.money design system — "juice terminal"

The site should feel like juicy.vision's sibling: an arcade terminal, not
another SaaS landing page. Dark, monospace, neon-framed panels, dense color.
Unique and a little loud — but everything still legible and mainstream-usable.
Reference: juicy.vision (dark mosaic of colored chips, orange-framed bento
panels, live activity rail, bold statement copy).

## Foundations
- **Single dark theme.** Background `#141217` (near-black plum-charcoal) with a
  very subtle radial glow (juice orange at ~6% opacity, top-right). No light mode.
- **Three-voice type system** (the Elektron trick — the contrast IS the look):
  1. **Display**: big, heavy, tight neo-grotesque for page/section headlines
     ("Other fun stuff" scale — text-5xl+ with -0.03em tracking). System sans
     stack (`-apple-system, "Helvetica Neue", Inter, Arial`).
  2. **Data/body**: system mono (`ui-monospace, "SF Mono", "Cascadia Mono",
     Menlo, monospace`) for everything informational — stats, activity rows,
     addresses, inputs, labels, paragraphs.
  3. **Pixel/bitmap**: buttons, badges, and tiny controls use the Silkscreen
     bitmap face (OFL) — the ONE font asset we ship (self-hosted woff2 subset,
     ~10KB, license file in-repo). "WATCH VIDEO"-style: uppercase pixel text
     in a 1px-outlined box. If the asset can't be sourced cleanly, fall back
     to uppercase mono + letterspacing — but the pixel face is the identity.
- **Pixel motifs**: small dash/blip glyph fragments above section headlines
  (like a loading bar stub), chunky 8-bit chevrons for carousel/steppers —
  CSS box-shadow pixel art or the pixel font's glyphs.
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
4. **CTAs**: FLAT solid juice blocks, dark pixel text, radius 2px. Hover:
   darken to juice-600. No shadows, no translate — precision, not stickers.
   Focus: cyan 2px outline. (Owner feedback: skeuomorphic shadows read goofy.)
5. **Inputs**: dark wells (#0f0d12), 2px cyan border on focus, mono
   placeholder in dim.
6. **Serious first.** The playfulness lives in the pixel type, the chips, and
   the live data — never in decorative effects (no confetti, no burst marks,
   no mascot substitutes). Pro/serious is the register; Elektron restraint
   wins every tie.

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
- **Headline accent = restraint.** Headlines are plain ink grotesque; the only
  accent is a juice-colored terminal period ("Fund your thing·"). NO highlight
  marks, skews, or painted effects — the owner rejected them as goofy. The
  loudness budget goes to the data (orange/lime amounts, chips), never to
  decoration.
- **Hero restraint.** The home hero is a near-empty dark band: the statement,
  one line of copy, two buttons (one solid, one pixel-outline). Let the
  activity rail and trending mosaic below carry the color density.
- **Two-up media bands.** Content sections (future: featured projects,
  stories) use Elektron's edge-to-edge two-up grid: full-bleed media, caption +
  pixel-outline button below, chunky pixel chevrons if it scrolls.

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
