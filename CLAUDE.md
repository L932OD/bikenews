# Bike Desk

India's two-wheeler news, once a day. Code fetches the news; Claude chooses and writes; Vercel serves a static page.

- `config/sources.json`: every source, URL, time window and limit. Never put these in code.
- `scripts/fetch.mjs` → `pool/YYYY-MM-DD.json`. `scripts/validate.mjs` checks an edition. `scripts/publish.mjs` writes
  `content/latest.json` and `content/archive.json`. `scripts/serve.mjs` previews the site locally.
- `index.html`, `styles.css`, `app.js`, `fonts/`: the site. No framework, no build step. `manifest.webmanifest`,
  `sw.js` and `icons/` make it a home-screen web app (offline reading of the last edition).
- `docs/RUNBOOK.md`: the daily steps. `docs/DESK.md`: the editorial brief.

## Two kinds of session

**A daily run** is any session started by the routine, or asked to "follow docs/RUNBOOK.md".

- It only writes `content/editions/`, `content/latest.json`, `content/archive.json` and `pool/`.
- It never touches code, styles, config, docs, `package.json` or `vercel.json`, even to fix a bug. If something is
  broken, stop and say what.
- It commits once (`Edition YYYY-MM-DD`) and pushes to `main`.

**A build session** is everything else: changing the code, the page, the sources or the brief. Build sessions work on
a branch, run `node scripts/fetch.mjs` and the validator to check their changes, and never publish an edition to
`main` by hand unless asked.

## Conventions

- Node 20 or later, ES modules, one dependency (`fast-xml-parser`).
- Dates are IST (`+05:30`); `scripts/lib.mjs` has `istDate()`.
- Some sites refuse automated readers (403). Mark them `"fetch_pages": false` in `config/sources.json` and use their
  feed summary; do not try to get around a block.
- Sources that cover cars too can set `"drop_car_titles": true`: headlines matching `title_filters.cars` (and not
  `title_filters.bikes`) are dropped before fetching. `url_must_contain` / `url_exclude` keep only article pages.
