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

## Components (the guideline language)
1. **Pill buttons & labels** — the brand's signature: rounded-lg/xl bone or
   white fill, thin (1.5px) near-black border, SMALL black offset shadow
   (~2px 2px 0, no blur), Agrandir label. Primary action variant: Split-400
   fill, black text, same border+shadow. Keep the shadow SMALL and precise —
   refined stationery, not stickers. Hover: fill shifts one scale stop;
   active: shadow collapses 1px.
2. **Cards/panels**: white or Bone surface, 1px Smoke-200/300 border,
   rounded-xl, generous padding. No heavy frames.
3. **Chips/badges**: soft tints of the fruit scales (e.g. Melon-100 bg with
   Melon-700 text; chain badges use per-chain tints) with rounded-full shape,
   Beatrice 12-14px. Version chips: Smoke-100 bg / Smoke-700 text.
4. **Icons**: fun, playful & modern line icons in colored circular tiles
   (Split/Crush/Grape/Bluebs/Peel/Melon 400s) — inline SVG, 1.5px strokes.
5. **Amount coloring**: data stays legible on light — ETH amounts Ink bold,
   positive/receive values Melon-700, project-token amounts Bluebs-600.
6. **Logo**: /public/brand/logo-full.svg (main) in the nav; logo-icon.svg
   (bolt carton) for favicon/compact contexts.
7. **Activity rail**: stays a signature element — white panel, Beatrice rows,
   Bluebs links, relative times in Smoke-500; calm on light.
8. **Inputs**: white wells, 1.5px Smoke-300 border, focus border Bluebs-500;
   Beatrice.

## Rules
- Responsive mobile/tablet/desktop; touch targets ≥44px.
- Contrast ≥4.5:1 for text (fruit tints as backgrounds only with their 700+
  text stops; Split-400 with black text passes).
- Lean: self-hosted brand fonts + logo SVGs are the only assets; no icon
  libraries; CSS-only effects; reduced-motion respected.
- The playfulness budget: color tiles, chips, pill shadows, friendly copy.
  Never: skewed marks, confetti, pixel fonts, chunky sticker shadows.
