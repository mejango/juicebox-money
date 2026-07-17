# juicebox.money design system — Juicebox Brand 2023

The site uses the OFFICIAL Juicebox Design System (2023 brand guidelines —
"inspired by tropical fruits and good times: playful nature while building
trust"). This is the system live on current juicebox.money; the new site
continues it faithfully. It replaces all prior experimental themes.

## Foundations
- **Light warm theme.** Page background **Bone `#FFF7E8`**. Surfaces white or
  Bone-tinted; borders thin near-black (`#201E1A`-family) or Smoke.
  (The Slate scale exists for a future dark theme — NOT used now.)
- **Type — the brand's three faces** (all self-hosted woff2 in /public/fonts,
  already licensed for juicebox.money):
  - **Display**: PP Agrandir Wide (Bold / Medium) — big statements only
    (Display 1–4: 72/60/48/36px → text-7xl…4xl).
  - **Headings**: PP Agrandir Medium — H1–H5 (48/36/30/24/20px).
  - **Body & UI**: Beatrice (Regular / Medium) — 18/16/14px. Numbers/data can
    use tabular figures via font-feature-settings where alignment matters.
  - Load via next/font/local with fallbacks (`Agrandir → system sans`,
    `Beatrice → system sans`); font-display swap.
- **Voice**: playful but trustworthy. Sentence case. "Fund anything" energy.
  Brand values: transparency, trust, fun & exciting, community-driven,
  customization, reliability.

## Color tokens (from the official scales; base marked)
- **Split** (primary yellow-orange): 25 #FFFCF5 · 50(Bone) #FFF7E8 ·
  100 #FFEECC · 200 #FFE1A6 · 300 #FFD27A · **400 #FFBB45 (base)** ·
  500 #F5A312 · 600 #D98909 · 700 #BD6800 · 800 #824100 · 900 #5C2C00 ·
  950 #2E1605
- **Bluebs** (primary blue): 25 #EEF1FD · 50 #DEE5FC · 100 #CFD9FA ·
  200 #BBC8F6 · 300 #9AAEF5 · 400 #748EED · **500 #5777EB (base)** ·
  600 #4864C8 · 700 #3A52A6 · 800 #233575 · 900 #152254 · 950 #0F193D
- **Melon** (green): base 500 #68CA8F (25 #F6FEF9, 400 #86D5A5, 600 #4FA270,
  700 #3D7955, 950 #15281D)
- **Peel** (orange): base 400 #EE6F3A (25 #FFF8F2, 100 #FFDAC9, 300 #F2936B,
  500 #E0561B, 600 #BD4513, 800 #69280C)
- **Grape** (purple): base 400 #A57AED (100 #EDE4FB, 300 #C9AFF4, 500 #8651E0,
  700 #461791)
- **Crush** (pink): base 500 #FF9FD5 (100 #FFECF7, 300 #FFC5E6, 400 #FFB2DD,
  600 #E47FB8, 700 #C85F9A)
- **Smoke** (warm neutral): 25 #FEFDFB · 75 #F5F4EF · 100 #EFECE6 ·
  200 #E7E3DC · 300 #D4D1C7 · 400 #C0BBAD · 500 #9C9580 · 700 #575344 ·
  900 #353026
- **Grey**: standard 25 #FCFCFC … 950 #0C0C03 (400 #A3A3A3, 700 #424242,
  900 #1A1A1A)
- **Ink** (text): Grey-900/950 family on Bone; secondary text Smoke-700 or
  Grey-600.

## Product UI components

The brand palette and the product-control palette have different jobs. Bone
stays the page canvas; fruit colors keep the broader site expressive. Inside
interactive components, **Bluebs is the consistent action, focus, and selected
state**. Split is reserved for brand punctuation, illustrations, and warning
surfaces—not the default submit-button color.

1. **Buttons**: rounded-lg, Beatrice Medium, and at least 44px high for primary
   touch actions. Primary uses Bluebs-500 with white text; hover is Bluebs-600.
   Secondary uses white, a Grey-300 border, and Ink text. Tertiary uses a pale
   Bluebs surface and Bluebs text; ghost/link buttons remove the frame. Shadows
   are soft and restrained. Disabled states lower contrast without relying on
   opacity alone.
2. **Cards/panels**: white or Bone surface, 1px Smoke-200/300 border,
   rounded-xl, generous padding. No heavy frames.
3. **Inputs and textareas**: sentence-case labels, white wells, 1px Grey-300
   border, and a Bluebs focus border with a soft Bluebs-50 halo. Hint text uses
   Grey-500. Errors pair Error-500 borders with Error-600 copy and an
   Error-100 focus halo. Disabled fields use a quiet Grey surface.
4. **Choice controls**: checkboxes, radios, toggles, segmented controls, and
   selected menu rows use Bluebs. Keep the selected state visible through both
   color and a mark (check, dot, or switch position). Chain selectors use a
   compact icon/name/caret trigger; their list rows show the chain icon and a
   Bluebs check/surface when selected.
5. **Chips/badges**: soft tints of the fruit scales (e.g. Melon-100 bg with
   Melon-700 text; chain badges use per-chain tints) with rounded-full shape,
   Beatrice 12-14px. Bluebs marks interactive/selected chips. Version chips use
   Smoke-100 bg / Smoke-700 text.
6. **Callouts**: neutral, info, warning, error, and success bars use Grey,
   Bluebs, Split, Error, and Melon respectively. Pair the tint with an icon and
   accessible text; color alone never carries the meaning.
7. **Navigation**: the full logo, Explore, Resources, and Create a project are
   visible on desktop. Search is an icon-triggered field and the account action
   is last. Mobile collapses to a 44px hamburger and a full-width menu rather
   than squeezing desktop links.
8. **Footer**: Slate-900 is allowed as a contained component on the otherwise
   light site. It includes the inverted logo, resource columns, copyright, and
   social links; columns stack on mobile.
9. **Icons**: playful modern line icons, usually 1.5–1.8px strokes. Icon-only
   actions have accessible names and 44px targets.
10. **Amount coloring**: data stays legible on light—ETH amounts Ink bold,
    positive/receive values Melon-700, project-token amounts Bluebs-600.
11. **Logo**: `/public/brand/logo-full.svg` (main) in navigation/footer;
    `logo-icon.svg` (bolt carton) for favicon/compact contexts.
12. **Activity rail**: white panel, Beatrice rows, Bluebs links, relative times
    in Smoke-500; calm on light.

The guide contains dark-theme component examples, but this site intentionally
ships the existing Bone light theme only. Do not add a theme toggle until a
complete dark token and QA pass exists.

## Rules
- Responsive mobile/tablet/desktop; touch targets ≥44px.
- Contrast ≥4.5:1 for text (fruit tints as backgrounds only with their 700+
  text stops).
- Lean: self-hosted brand fonts + logo SVGs are the only assets; no icon
  libraries; CSS-only effects; reduced-motion respected.
- The playfulness budget: color tiles, chips, friendly copy, and fruit accents.
  Never: skewed marks, confetti, pixel fonts, chunky sticker shadows.
