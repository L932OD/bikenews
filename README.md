# Bike News

India's motorcycle news, refreshed once a day at about 09:00 IST. A script gathers the news, Claude chooses and
writes the edition, and Vercel serves a static page from `main`.

```
npm ci
node scripts/fetch.mjs                                     # pool/YYYY-MM-DD.json
node scripts/validate.mjs content/editions/YYYY-MM-DD.json # check an edition
node scripts/publish.mjs content/editions/YYYY-MM-DD.json  # latest.json + archive.json
node scripts/serve.mjs                                     # preview at http://localhost:8080
```

The daily steps are in `docs/RUNBOOK.md`, the editorial brief in `docs/DESK.md`, and the rules for daily runs versus
build sessions in `CLAUDE.md`. Fonts (Barlow, Source Serif 4) are self-hosted under the SIL Open Font License.
