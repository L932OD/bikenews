# Bike News

India's motorcycle news, once a day. Code fetches the news; Claude chooses and writes; Vercel serves a static page.

- `config/sources.json`: every source, URL, time window and limit. Never put these in code.
- `scripts/fetch.mjs` → `pool/YYYY-MM-DD.json`. `scripts/validate.mjs` checks an edition. `scripts/publish.mjs` writes
  `content/latest.json` and `content/archive.json`. `scripts/serve.mjs` previews the site locally.
- `index.html`, `styles.css`, `app.js`, `fonts/`: the site. No framework, no build step. `manifest.webmanifest`,
  `sw.js` and `icons/` make it a home-screen web app (offline reading of the last edition).
- `docs/RUNBOOK.md`: the daily steps. `docs/DESK.md`: the editorial brief.
- The site has four sections: Feed (the editions' stories, newest first), Events (`content/events.json`, kept until each event is
  over), Trending now (`content/trends.json`, from Google Trends Explore) and Aftermarket (the editions'
  `accessories`, with the brands we follow in `config/sources.json` → `content/brands.json`). News, pools and trends history are kept for `keep_days` (5) days, then deleted.

## Two kinds of session

**A daily run** is any session started by the routine (09:00 and 21:00 IST, each with a retry at :29), or asked to
"follow docs/RUNBOOK.md". The morning run writes the day's edition; the evening run adds to it.

- It only writes `content/` (editions, `latest.json`, `archive.json`, `events.json`, `trends.json`, `brands.json`) and
  `pool/`.
- It never touches code, styles, config, docs, `package.json` or `vercel.json`, even to fix a bug. If something is
  broken, stop and say what.
- It commits once (`Edition YYYY-MM-DD`, or `Edition YYYY-MM-DD (evening)`) and pushes to `main`.

**A build session** is everything else: changing the code, the page, the sources or the brief. Build sessions work on
a branch, run `node scripts/fetch.mjs` and the validator to check their changes, and never publish an edition to
`main` by hand unless asked.

## Conventions

- Node 20 or later, ES modules, one dependency (`fast-xml-parser`).
- Dates are IST (`+05:30`); `scripts/lib.mjs` has `istDate()`.
- Some sites refuse automated readers (403). Mark them `"fetch_pages": false` in `config/sources.json` and use their
  feed summary; do not try to get around a block.
- Bike News is motorcycles only: petrol and electric motorcycles, and scooters only when they are performance
  scooters. Never cars, trucks, buses or commuter scooters. Headlines matching `title_filters.cars` (and not `bikes`),
  or `scooters` (and not `performance_scooters` or `motorcycles`), are dropped from every source, section and trend
  before fetching, and the validator rejects any that reach an edition. Trending searches are kept only when they
  match `title_filters.bike_names`, never share prices (`not_riders`). `url_must_contain` / `url_exclude` keep only
  article pages.
