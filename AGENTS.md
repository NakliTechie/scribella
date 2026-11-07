# Agent notes for Scribella

Tier: **Product**, set on 2026-11-07 by the owner's "Yes" to full parity with Lattice, because the Overleaf link and the paper lookups need network routes. Projects stay on the person's disk. No account, no telemetry.

Unity sentence: a dense writing desk, source and PDF side by side, for a person who works in it for hours.

## Rules
- One page, native ES modules, no build step, no CDN at runtime. Vendored libraries are pinned in `vendor/` with licences; `vendor/codemirror.mjs` is one esbuild bundle listed in `vendor/README.md`.
- Compiling goes through `naklios.experimental_tex`, so the AGPL engine stays in the host. Writing works on the direct site; compiling needs NakliOS.
- AI is removable: every layer below revision works with no model.
- Every control has a `data-command`, and `commands.json` maps it in `parity`.
- `plan/parity-matrix.md` is the scope. A row turns to `built` only when a check ran.
- Code derived from Lattice stays listed in `NOTICE`.
- UI is light by default.

## Verification budget
- Build the whole batch, then check once at the batch boundary.
- All generated test data goes to one temp directory, capped at 5,000 files and 500 MB, and is deleted afterwards.
- One diagnostic batch per failure, each with a written hypothesis.
