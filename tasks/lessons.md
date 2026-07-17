
## next build vs running dev server (2026-07-16)
`npm run build` and `next dev` share `.next/` — running a production build
while the dev server is up clobbers its chunk cache (pages 404 their JS/CSS,
render unstyled). If a build is needed while dev runs, restart the dev
server afterward (kill next-server + `npx next dev -p 3006`), or build in a
checkout/worktree copy.
