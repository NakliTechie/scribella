# Scribella

Write LaTeX papers in the browser. Your files stay on your machine, and TeX runs on your machine too.

## Use it

Open Scribella from the NakliOS desktop at [naklios.dev](https://naklios.dev). The first compile downloads TeX Live once, about 680 MB.

The direct site at `scribella.naklitechie.com` offers writing only, because the TeX engine lives in NakliOS.

## Run it locally

```bash
python3 -m http.server 8000
```

```bash
npm test
```

## What it does today

- Keeps projects in NakliOS storage, or in the browser's private storage on the direct site.
- Builds on save, one build at a time, and merges requests made during a build.
- Explains common TeX errors in plain words, with a one-click fix for a near-typo command.
- Checks the source as you type: unclosed environments, duplicate labels, missing references, citations and files.
- Keeps the last good PDF on screen after a failed build, and keeps your place across rebuilds.

Everything planned is in the parity matrix against Lattice, kept in the private plan folder.

## Licence

MIT. `src/explain.js` and the rules in `src/lint.js` derive from [Lattice](https://github.com/leo1oel/lattice) under Apache-2.0; see `NOTICE`.
