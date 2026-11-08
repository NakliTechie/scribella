# Scribella

Write LaTeX papers in the browser. Your files stay on your machine, and TeX runs on your machine too.

## Use it

Open Scribella from the desktop at [naklios.dev](https://naklios.dev), in the Think & Research folder. The first compile downloads TeX Live once, about 680 MB, from Hugging Face. Later builds of a short paper take about 2 seconds.

The direct site, `scribella.naklitechie.com`, offers writing only, because the TeX engine lives in NakliOS. Projects there stay in this browser.

## Run it locally

```bash
python3 -m http.server 8000
```

```bash
npm test
```

```bash
node scripts/check-overleaf-sync.mjs
```

The last command needs `git` on your PATH. It runs the Overleaf sync against a local Git server.

## What it does

- **Write.** CodeMirror with LaTeX highlighting, completion of citations, labels and files, list items that continue on Enter, environment wrap and rename, go to definition, vim and emacs keys, spellcheck, and a Format command.
- **Build.** Compiles on save through the NakliOS TeX service, explains common errors in plain words with one-click fixes, and keeps the last good PDF on screen.
- **Move between source and PDF.** Show in PDF from the cursor, and double-click the PDF to land on the source line.
- **Start.** Article, slides, thesis, NeurIPS, ICML, ICLR, ACL, CVPR and IEEE starters.
- **Cite.** Add papers by arXiv id, DOI or title, find papers through OpenAlex, check references against Crossref with retraction notices, and save arXiv full text as searchable Markdown.
- **Review.** Notes and highlights anchored to quotes, saved versions, a changes PDF, and a review PDF that carries your notes as PDF annotations.
- **Revise with AI.** Proofread, Polish and revision rounds through NakliOS AI. An edit that would touch math, citations or labels is held back, and each edit waits for your Accept.
- **Submit.** A double-blind check of source and PDF, and an arXiv pack that is checked to build on its own.
- **Keep history.** Git commits with restore, and a three-way merge when a file changes outside the editor.
- **More.** Data sheets, whiteboards saved as figure PDFs, Markdown notes, and a paragraph preview with typeset math.
- **Experimental.** Two-way Overleaf sync through Overleaf's Git integration, and an agent panel that proposes edits.

## Limits

- AAAI, ACM and the Tsinghua and USTC thesis templates need fonts and classes the TeX packs do not hold.
- Overleaf sync is tested against a Git server, not yet against Overleaf.
- The whiteboard, sheets and Markdown notes are simple; Lattice uses tldraw, Univer and TipTap.

## Licence

MIT. Parts of `src/` derive from [Lattice](https://github.com/leo1oel/lattice) under Apache-2.0, and `templates/` holds venue files under their own terms; see `NOTICE`. The TeX engine is AGPL and lives in NakliOS, in [naklios-tex](https://github.com/NakliTechie/naklios-tex).
