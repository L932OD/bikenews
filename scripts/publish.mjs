#!/usr/bin/env node
// Make a validated edition the live one: copy it to content/latest.json and list it in content/archive.json.
// Usage: node scripts/publish.mjs content/editions/YYYY-MM-DD.json
import { path, readJson, writeJson } from './lib.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/publish.mjs content/editions/YYYY-MM-DD.json');
  process.exit(2);
}

const ed = await readJson(file);
const count = (ed.lead ? 1 : 0) + (ed.subs?.length || 0) + (ed.headlines?.length || 0);

await writeJson(path('content/latest.json'), ed);

const archive = await readJson(path('content/archive.json'), { editions: [] });
const entry = {
  edition: ed.edition,
  published_at: ed.published_at,
  stories: count,
  lead: ed.lead?.headline ?? ed.subs?.[0]?.headline ?? ed.headlines?.[0]?.headline ?? null,
};
archive.editions = [entry, ...archive.editions.filter((e) => e.edition !== ed.edition)].sort((a, b) => b.edition.localeCompare(a.edition));
await writeJson(path('content/archive.json'), archive);

console.log(`Published ${ed.edition}: ${count} stories. content/latest.json and content/archive.json (${archive.editions.length} editions) updated.`);
