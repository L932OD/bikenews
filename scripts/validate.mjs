#!/usr/bin/env node
// Check an edition against docs/DESK.md and its day's pool.
// Usage: node scripts/validate.mjs content/editions/YYYY-MM-DD.json [--not-today]
// --not-today skips the "edition is today's IST date" check, for dry runs on an older pool only.
import { basename } from 'node:path';
import { path, istDate, readJson, normUrl, numbersIn, wordCount } from './lib.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node scripts/validate.mjs content/editions/YYYY-MM-DD.json [--not-today]');
  process.exit(2);
}

const TYPES = ['launch', 'price', 'recall', 'sales', 'ev', 'policy', 'upcoming', 'spy', 'rumour', 'racing', 'other'];
const HYPE = ['game-changer', 'game changer', 'stunning', 'eagerly awaited', 'eagerly-awaited', 'much-awaited', 'much awaited', 'highly anticipated', 'breathtaking', 'jaw-dropping', 'mind-blowing', 'revolutionary', 'groundbreaking', 'ground-breaking', 'unveils the future', 'all-new avatar'];

const errors = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);

let ed;
try {
  ed = await readJson(file);
} catch (e) {
  console.error(`FAIL ${file}: not readable JSON (${e.message})`);
  process.exit(1);
}

// ---------- Edition and pool ----------

const date = ed.edition;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) err('edition', 'must be a YYYY-MM-DD date');
if (basename(file) !== `${date}.json`) err('edition', `file name ${basename(file)} does not match edition ${date}`);
if (!args.includes('--not-today') && date !== istDate()) err('edition', `is ${date}, but today in India is ${istDate()}`);
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?\+05:30$/.test(ed.published_at || '')) err('published_at', 'must be an IST timestamp like 2026-10-27T09:12:00+05:30');

const pool = await readJson(path('pool', `${date}.json`), null);
if (!pool) {
  console.error(`FAIL: pool/${date}.json not found. Run node scripts/fetch.mjs first.`);
  process.exit(1);
}

const poolByUrl = new Map(pool.items.map((it) => [normUrl(it.url), it]));
const trendUrls = new Map();
for (const t of pool.trends || []) for (const n of t.news) trendUrls.set(normUrl(n.url), { ...n, term: t.term });

const prev = pool.previous_edition;
const prevItems = prev ? [prev.lead, ...(prev.subs || []), ...(prev.headlines || [])].filter(Boolean) : [];
const prevUrls = new Set(prevItems.flatMap((it) => (it.sources || []).map((s) => normUrl(s.url))));
const prevIds = new Set(prevItems.map((it) => it.id));

// ---------- Text checks used everywhere ----------

function checkText(where, value, { max, min, required = true } = {}) {
  if (value == null || value === '') {
    if (required) err(where, 'is missing');
    return;
  }
  if (typeof value !== 'string') return err(where, 'must be text');
  const n = wordCount(value);
  if (max && n > max) err(where, `${n} words, at most ${max}`);
  if (min && n < min) err(where, `${n} words, at least ${min}`);
  const low = value.toLowerCase();
  for (const h of HYPE) if (low.includes(h)) err(where, `uses hype ("${h}")`);
}

// No em dashes anywhere in the file.
(function walk(v, at) {
  if (typeof v === 'string') {
    if (v.includes('—')) err(at, 'contains an em dash');
  } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k);
})(ed, '');

// ---------- Stories ----------

const allUrls = new Map(); // normalised URL -> where it is used
const ids = new Set();

function checkSources(where, sources, lookup) {
  const found = [];
  if (!Array.isArray(sources) || sources.length === 0) {
    err(where, 'needs at least one source');
    return found;
  }
  sources.forEach((s, i) => {
    const at = `${where}.sources[${i}]`;
    if (!s || typeof s.name !== 'string' || !s.name) err(at, 'needs a name');
    if (typeof s?.url !== 'string' || !s.url.startsWith('https://')) return err(at, 'needs an https URL');
    const key = normUrl(s.url);
    const hit = lookup.get(key);
    if (!hit) return err(at, `URL is not in pool/${date}.json: ${s.url}`);
    found.push(hit);
    if (allUrls.has(key)) err(at, `URL is already used by ${allUrls.get(key)}`);
    else allUrls.set(key, where);
  });
  return found;
}

function checkNumbers(where, text, poolItems) {
  if (!text) return;
  const available = new Set();
  for (const it of poolItems) for (const n of numbersIn(`${it.title} ${it.summary} ${it.text}`)) available.add(n);
  for (const n of numbersIn(text)) {
    if (!available.has(n)) err(where, `the number ${n} is not in this item's source text`);
  }
}

function checkStory(where, it, kind) {
  if (!it || typeof it !== 'object') return err(where, 'must be an object');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(it.id || '')) err(`${where}.id`, 'must be a short kebab-case id');
  else if (ids.has(it.id)) err(`${where}.id`, `"${it.id}" is used twice`);
  else ids.add(it.id);

  if (!TYPES.includes(it.type)) err(`${where}.type`, `must be one of ${TYPES.join(', ')}`);
  if (!(it.tag === null || it.tag === undefined || it.tag === 'update')) err(`${where}.tag`, 'must be null or "update"');
  checkText(`${where}.headline`, it.headline, { max: 16 });

  if (kind !== 'headline') {
    if (typeof it.kicker !== 'string' || !it.kicker || wordCount(it.kicker) > 4) err(`${where}.kicker`, 'needs a short kicker (at most 4 words)');
  }
  if (kind === 'lead') {
    checkText(`${where}.text`, it.text, { min: 60, max: 100 });
    checkText(`${where}.why`, it.why, { max: 25 });
  } else if (kind === 'sub') {
    checkText(`${where}.text`, it.text, { max: 50 });
    if (it.why) err(`${where}.why`, 'only the lead has "why it matters"');
  } else {
    for (const k of ['text', 'why', 'figure', 'specs']) if (it[k] != null) err(`${where}.${k}`, 'headline items have only a headline and sources');
  }

  if (it.figure != null) {
    if (typeof it.figure?.value !== 'string' || !it.figure.value || typeof it.figure?.label !== 'string' || !it.figure.label) err(`${where}.figure`, 'needs a value and a label');
  }
  if (it.specs != null) {
    if (!Array.isArray(it.specs) || it.specs.length > 3 || !it.specs.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'string' && x))) {
      err(`${where}.specs`, 'must be at most three [label, value] pairs');
    }
  }

  const found = checkSources(where, it.sources, poolByUrl);

  if (kind !== 'headline' && found.length) {
    checkNumbers(`${where}.text`, it.text, found);
    checkNumbers(`${where}.why`, it.why, found);
    if (it.figure?.value) checkNumbers(`${where}.figure`, it.figure.value, found);
    for (const [i, p] of (Array.isArray(it.specs) ? it.specs : []).entries()) if (Array.isArray(p)) checkNumbers(`${where}.specs[${i}]`, p[1], found);
  }

  const repeats = prevIds.has(it.id) || (it.sources || []).some((s) => prevUrls.has(normUrl(s?.url)));
  if (repeats && it.tag !== 'update') err(where, `repeats an item from the ${prev.edition} edition; leave it out, or tag it "update" if there is new information`);
}

const lead = ed.lead ?? null;
const subs = ed.subs ?? [];
const heads = ed.headlines ?? [];
const trending = ed.trending ?? [];
for (const [k, v] of Object.entries({ subs, headlines: heads, trending })) if (!Array.isArray(v)) err(k, 'must be a list');

if (lead !== null) checkStory('lead', lead, 'lead');
if (Array.isArray(subs)) subs.forEach((s, i) => checkStory(`subs[${i}]`, s, 'sub'));
if (Array.isArray(heads)) heads.forEach((s, i) => checkStory(`headlines[${i}]`, s, 'headline'));

const total = (lead ? 1 : 0) + (subs.length || 0) + (heads.length || 0);
if (total < 5 || total > 12) err('edition', `has ${total} items; it needs 5 to 12 (lead + subs + headlines)`);
if (subs.length > 3) err('subs', `has ${subs.length}; at most 3`);
if (trending.length > 2) err('trending', `has ${trending.length}; at most 2`);

if (Array.isArray(trending)) {
  trending.forEach((t, i) => {
    const where = `trending[${i}]`;
    if (typeof t?.term !== 'string' || !t.term) err(`${where}.term`, 'is missing');
    else if (!(pool.trends || []).some((p) => p.term.toLowerCase() === t.term.toLowerCase())) err(`${where}.term`, `"${t.term}" is not a trend in the pool`);
    checkText(`${where}.why`, t?.why, { max: 25 });
    checkSources(where, t?.sources, trendUrls);
  });
}

// ---------- Checks block ----------

const c = ed.checks;
if (!c || typeof c !== 'object') err('checks', 'is missing');
else {
  if (!Number.isInteger(c.pool_items)) err('checks.pool_items', 'must be a whole number');
  else if (c.pool_items !== pool.items.length) err('checks.pool_items', `is ${c.pool_items}, but the pool has ${pool.items.length} items`);
  if (!Array.isArray(c.sources_failed)) err('checks.sources_failed', 'must be a list');
  if (!Array.isArray(c.left_out)) err('checks.left_out', 'must be a list');
}

// ---------- Report ----------

if (errors.length) {
  console.log(`FAIL ${file}: ${errors.length} problem${errors.length > 1 ? 's' : ''}`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log(`OK ${file}: ${total} items (${lead ? 'lead, ' : 'no lead, '}${subs.length} subs, ${heads.length} headlines, ${trending.length} trending)`);
