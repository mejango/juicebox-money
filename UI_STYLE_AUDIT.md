# UI style-guide audit

Audit date: 2026-07-17

## Scope

This audit compares the product UI to the supplied Juicebox component guide:
navigation, buttons, uploads, accordions, modals, callouts, footer, badges,
tooltips, inputs/textareas, choice controls, menus, and chain selectors.

The existing brand expression is explicitly out of scope for replacement. The
Bone `#FFF7E8` page background, Agrandir/Beatrice typography, fruit palette,
and warm playful feel remain the site foundation.

## Result

| Area | Before | Audit result |
| --- | --- | --- |
| Foundations | Bone background, brand fonts, fruit palette | **Pass; preserved** |
| Primary actions | Split fill with offset black shadow | **Fixed:** Bluebs primary, white label, soft shadow |
| Secondary/tertiary actions | One ad-hoc secondary treatment | **Fixed:** shared secondary, tertiary, ghost, link, and icon-button styles |
| Inputs | Neutral wells; limited state language | **Fixed:** sentence-case labels, hint/error helpers, Bluebs focus halo, Error state, disabled state |
| Choice and selected states | Mixed Ink, Split, native browser colors | **Fixed in core flows:** Bluebs selected rows, radios, chips, segmented controls, and native accent |
| Chain controls | Large isolated chain circles and native selects | **Fixed:** compact icon/name/caret selectors with accessible listboxes, Bluebs selected rows, checks, and multi-chain support |
| Navigation | Compressed logo/search/create/account row; no mobile menu | **Fixed:** reference anatomy on desktop and a 44px mobile menu with expanded search |
| Footer | Logo plus two links | **Fixed:** responsive Slate footer with identity, link columns, copyright, and socials |
| Mobile width | Home headline and create stepper could overflow/crop | **Fixed:** responsive display size and compact mobile stepper |
| Callout tokens | Repeated one-off Split notices | **Fixed:** shared neutral/info/warning/error/success bars with icons and explicit severity |
| Address validation | Visible notes without field relationships | **Fixed:** `aria-invalid` and described-by hint/error linkage |

## Component coverage

- **Buttons and icon buttons:** covered by shared CSS primitives and used by
  global actions, wallet, navigation, and create/project flows.
- **Inputs and textareas:** covered by shared field primitives. Address and
  project-ID fields expose validation state to assistive technology.
- **Badges/chips and chain selectors:** fruit-tinted badges remain expressive;
  interactive chips use Bluebs. Chain inputs now use compact icon/name/caret
  triggers and accessible single- or multi-select menus.
- **Menus:** navigation resources, mobile navigation, wallet, and search menus
  use the same neutral row and selected-state language.
- **Accordions:** current disclosure sections already use clear labels,
  chevrons, separators, and `aria-expanded`; no visual rewrite needed.
- **Upload actions:** file inputs use the shared secondary action treatment and
  retain preview, replacement, removal, constraints, and error copy. A large
  dropzone is not required for the compact project-logo/media contexts.
- **Modal:** authentication is owned by Para. Transaction and destructive flows
  currently use in-context confirmation panels; a generic app-modal primitive
  should only be added when a product flow needs it.
- **Tooltips:** native `title` is used for supplementary labels. A rich tooltip
  primitive is deferred until a real explanatory-content use case exists.

## Remaining migration debt

1. Consolidate remaining locally styled native checkboxes in advanced owner and
   back-office flows into the shared choice-control component.
2. Add Storybook or a small component-gallery route before expanding the
   primitive set; screenshots alone do not protect hover, focus, disabled,
   error, keyboard, or responsive states from regression.

Dark mode and localization controls are intentionally not faked. They require
complete product support, not decorative navigation icons.

## Verification

- TypeScript: `npm run ts:check` passes.
- Production build: passes with the existing optional `pino-pretty` and
  WalletConnect server-environment warnings.
- Visual checks: desktop home and project pages plus the create flow at an
  emulated 390px viewport. At 390px, both `documentElement.scrollWidth` and
  `body.scrollWidth` equal 390px (no horizontal overflow).
- Lint remains unavailable until the repository chooses an ESLint preset;
  `npm run lint` currently opens Next.js's interactive setup prompt.
