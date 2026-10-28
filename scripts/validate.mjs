#!/usr/bin/env node
// Check an edition against docs/DESK.md and its day's pool.
// Usage: node scripts/validate.mjs content/editions/YYYY-MM-DD.json [--not-today]
// --not-today skips the "edition is today's IST date" check, for dry runs on an older pool only.
import { basename } from 'node:path';
import { readdir } from 'node:fs/promises';
import { path, istDate, readJson, normUrl, numbersIn, wordCount } from './lib.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node scripts/validate.mjs content/editions/YYYY-MM-DD.json [--not-today]');
  process.exit(2);
}

const EVENT_KINDS = ['race', 'festival', 'ride', 'track-day', 'training', 'expo', 'meetup', 'launch', 'other'];
const GEAR = ['helmet', 'riding-gear', 'luggage', 'protection', 'electronics', 'performance', 'styling', 'care', 'other'];
const TYPES = ['launch', 'price', 'recall', 'sales', 'ev', 'policy', 'upcoming', 'spy', 'rumour', 'racing', 'other'];
const HYPE = ['game-changer', 'game changer', 'stunning', 'eagerly awaited', 'eagerly-awaited', 'much-awaited', 'much awaited', 'highly anticipated', 'breathtaking', 'jaw-dropping', 'mind-blowing', 'revolutionary', 'groundbreaking', 'ground-breaking', 'unveils the future', 'all-new avatar'];

const config = await readJson(path('config/sources.json'));
const LIMITS = config.limits;

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

function checkSources(where, sources, lookup, used = allUrls) {
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
    if (used.has(key)) err(at, `URL is already used by ${used.get(key)}`);
    else used.set(key, where);
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

  const found = checkSources(where, it.sources, poolByUrl);
  // Every story carries the time it was published, copied from one of its sources, so the feed can sort by it.
  if (typeof it.published_at !== 'string' || Number.isNaN(Date.parse(it.published_at))) err(`${where}.published_at`, 'is missing; copy the pool item\'s published_at');
  else if (found.length && found.some((src) => src.published_at) && !found.some((src) => Date.parse(src.published_at) === Date.parse(it.published_at))) {
    err(`${where}.published_at`, 'must be the published_at of one of its sources in the pool');
  }

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
if (total < LIMITS.stories_min || total > LIMITS.stories_max) err('edition', `has ${total} items; it needs ${LIMITS.stories_min} to ${LIMITS.stories_max} (lead + subs + headlines)`);
if (subs.length > LIMITS.subs_max) err('subs', `has ${subs.length}; at most ${LIMITS.subs_max}`);
if (trending.length > 5) err('trending', `has ${trending.length}; at most 5`);

// What is trending and why. A term must come from the day's Google Trends data (daily trends, or the Explore
// searches), its signal must be the value Google gave, and the "why" must cite a story that explains it.
const signals = new Map();
const addSignal = (term, value) => {
  const k = String(term).toLowerCase();
  if (!signals.has(k)) signals.set(k, new Set());
  if (value != null && value !== '') signals.get(k).add(String(value));
};
for (const t of pool.trends || []) addSignal(t.term, t.traffic);
for (const r of pool.explore?.related || []) {
  for (const q of r.top) addSignal(q.q, q.value);
  for (const q of r.rising) addSignal(q.q, q.value);
}
const exploreNumbers = new Set();
for (const v of [
  ...(pool.explore?.averages || []),
  ...(pool.explore?.related || []).flatMap((r) => [...r.top, ...r.rising].map((q) => q.value)),
  ...(pool.explore?.states || []).map((x) => x.value),
  ...(pool.trends || []).map((t) => t.traffic),
]) for (const n of numbersIn(String(v))) exploreNumbers.add(n);

const trendUsed = new Map();
const trendFound = [];
if (Array.isArray(trending)) {
  trending.forEach((t, i) => {
    const where = `trending[${i}]`;
    const known = typeof t?.term === 'string' ? signals.get(t.term.toLowerCase()) : null;
    if (typeof t?.term !== 'string' || !t.term) err(`${where}.term`, 'is missing');
    else if (!known) err(`${where}.term`, `"${t.term}" is not in today's Google Trends data`);
    else if (t.traffic != null && t.traffic !== '' && !known.has(String(t.traffic))) err(`${where}.traffic`, `"${t.traffic}" is not Google's value for this term (${[...known].join(', ') || 'none'})`);
    checkText(`${where}.why`, t?.why, { max: 30 });
    // A trend is explained by its own news links (daily trends) or by the day's pool stories about it.
    // It may cite a story the edition also runs.
    const found = checkSources(where, t?.sources, new Map([...poolByUrl, ...trendUrls]), trendUsed);
    trendFound.push(...found);
    if (found.length && t.why) {
      const have = new Set([...exploreNumbers]);
      for (const it of found) for (const n of numbersIn(`${it.title} ${it.summary ?? ''} ${it.text ?? ''}`)) have.add(n);
      for (const n of numbersIn(t.why)) if (!have.has(n)) err(`${where}.why`, `the number ${n} is not in Google's data or this trend's sources`);
    }
  });
}
const ts = ed.trends_summary;
if (ts != null) {
  checkText('trends_summary.headline', ts.headline, { max: 16 });
  checkText('trends_summary.text', ts.text, { max: 70 });
  if (!trending.length) err('trends_summary', 'needs the trending items it sums up');
  const have = new Set([...exploreNumbers]);
  for (const it of trendFound) for (const n of numbersIn(`${it.title} ${it.summary ?? ''} ${it.text ?? ''}`)) have.add(n);
  for (const n of numbersIn(`${ts.headline ?? ''} ${ts.text ?? ''}`)) if (!have.has(n)) err('trends_summary', `the number ${n} is not in Google's data or the trending items' sources`);
}

// ---------- Events and aftermarket accessories ----------

const sectionPool = (key) => new Map([...(pool[key] ?? []), ...pool.items].map((it) => [normUrl(it.url), it]));
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(d));

// The last day of the events page: today plus events_ahead_months.
const horizon = (() => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + LIMITS.events_ahead_months);
  return d.toISOString().slice(0, 10);
})();
const events = ed.events ?? [];
if (!Array.isArray(events)) err('events', 'must be a list');
else {
  if (events.length > 8) err('events', `has ${events.length}; at most 8 a day`);
  const eventPool = sectionPool('events');
  events.forEach((ev, i) => {
    const where = `events[${i}]`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(ev?.id || '')) err(`${where}.id`, 'must be a short kebab-case id');
    if (typeof ev?.name !== 'string' || !ev.name || wordCount(ev.name) > 10) err(`${where}.name`, 'needs a name of at most 10 words');
    if (!EVENT_KINDS.includes(ev?.kind)) err(`${where}.kind`, `must be one of ${EVENT_KINDS.join(', ')}`);
    if (!isDate(ev?.start_date)) err(`${where}.start_date`, 'must be a YYYY-MM-DD date');
    if (ev?.end_date != null && (!isDate(ev.end_date) || ev.end_date < ev.start_date)) err(`${where}.end_date`, 'must be a date on or after start_date, or null');
    if (isDate(ev?.start_date) && (ev.end_date || ev.start_date) < date) err(where, 'is already over; the events page lists only events still to come');
    if (isDate(ev?.start_date) && ev.start_date > horizon) err(`${where}.start_date`, `is after ${horizon}; the events page lists the next ${LIMITS.events_ahead_months} months only`);
    if (typeof ev?.city !== 'string' || !ev.city) err(`${where}.city`, 'is missing');
    checkText(`${where}.text`, ev?.text, { max: 40 });
    if (ev?.register != null && !String(ev.register).startsWith('https://')) err(`${where}.register`, 'must be an https URL or null');
    if (!(ev?.tag == null || ev.tag === 'update')) err(`${where}.tag`, 'must be null or "update"');
    const found = checkSources(where, ev?.sources, eventPool);
    if (found.length) {
      checkNumbers(`${where}.text`, ev.text, found);
      // The day of the month must be in a source, so dates are never guessed.
      const days = numbersIn(found.map((it) => `${it.title} ${it.summary} ${it.text}`).join(' '));
      if (isDate(ev.start_date) && !days.has(String(Number(ev.start_date.slice(8))))) err(`${where}.start_date`, `day ${Number(ev.start_date.slice(8))} is not in its sources`);
    }
  });
}

// Accessories already shown in the last few editions do not come back unless tagged "update".
const recentFiles = (await readdir(path('content/editions')).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < date).sort().slice(-5);
const recentGear = new Set();
for (const f of recentFiles) for (const a of (await readJson(path('content/editions', f), {})).accessories ?? []) for (const src of a.sources ?? []) recentGear.add(normUrl(src.url));

const gear = ed.accessories ?? [];
if (!Array.isArray(gear)) err('accessories', 'must be a list');
else {
  if (gear.length > LIMITS.accessories_max) err('accessories', `has ${gear.length}; at most ${LIMITS.accessories_max} a day`);
  const gearPool = sectionPool('accessories');
  gear.forEach((a, i) => {
    const where = `accessories[${i}]`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a?.id || '')) err(`${where}.id`, 'must be a short kebab-case id');
    else if (ids.has(a.id)) err(`${where}.id`, `"${a.id}" is used twice`);
    else ids.add(a.id);
    if (typeof a?.brand !== 'string' || !a.brand) err(`${where}.brand`, 'is missing');
    if (typeof a?.product !== 'string' || !a.product) err(`${where}.product`, 'is missing');
    if (!GEAR.includes(a?.category)) err(`${where}.category`, `must be one of ${GEAR.join(', ')}`);
    if (!Array.isArray(a?.for_bikes) || !a.for_bikes.length) err(`${where}.for_bikes`, 'must list the bikes it is for, or ["Universal"]');
    checkText(`${where}.headline`, a?.headline, { max: 16 });
    checkText(`${where}.text`, a?.text, { max: 40 });
    if (a?.price != null && (typeof a.price?.value !== 'string' || !a.price.value)) err(`${where}.price`, 'needs a value and a label, or null');
    if (!(a?.tag == null || a.tag === 'update')) err(`${where}.tag`, 'must be null or "update"');
    if (a?.teased != null && typeof a.teased !== 'boolean') err(`${where}.teased`, 'must be true, false or left out');
    const found = checkSources(where, a?.sources, gearPool);
    if (found.length) {
      checkNumbers(`${where}.text`, a.text, found);
      if (a.price?.value) checkNumbers(`${where}.price`, a.price.value, found);
    }
    if ((a?.sources ?? []).some((src) => recentGear.has(normUrl(src?.url))) && a.tag !== 'update') err(where, 'was in one of the last 5 editions; leave it out, or tag it "update"');
  });
}

// ---------- Upcoming launches ----------

// A bike or product the brand has teased or announced, with when it is expected. The date (or the month) must be in
// its sources, as for events. Its sources may also back a story in the same edition.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const UP_STATUS = ['teased', 'confirmed', 'expected'];
const upcomingHorizon = (() => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + LIMITS.upcoming_ahead_months);
  return d.toISOString().slice(0, 10);
})();
const upcoming = ed.upcoming ?? [];
if (!Array.isArray(upcoming)) err('upcoming', 'must be a list');
else {
  if (upcoming.length > LIMITS.upcoming_max) err('upcoming', `has ${upcoming.length}; at most ${LIMITS.upcoming_max} a day`);
  const upPool = sectionPool('accessories');
  const upIds = new Set();
  upcoming.forEach((u, i) => {
    const where = `upcoming[${i}]`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(u?.id || '')) err(`${where}.id`, 'must be a short kebab-case id, stable across days');
    else if (upIds.has(u.id)) err(`${where}.id`, `"${u.id}" is used twice`);
    else upIds.add(u.id);
    if (u?.launched === true) {
      if (!Array.isArray(u.sources) || !u.sources.length) err(where, 'a launched item needs the source that reports the launch');
      else checkSources(where, u.sources, upPool, new Map());
      return;
    }
    if (typeof u?.name !== 'string' || !u.name || wordCount(u.name) > 8) err(`${where}.name`, 'needs a name of at most 8 words');
    if (typeof u?.brand !== 'string' || !u.brand) err(`${where}.brand`, 'is missing');
    if (!['bike', 'gear'].includes(u?.kind)) err(`${where}.kind`, 'must be "bike" or "gear"');
    if (!UP_STATUS.includes(u?.status)) err(`${where}.status`, `must be one of ${UP_STATUS.join(', ')}`);
    const w = u?.when ?? {};
    const hasDate = w.date != null;
    if (hasDate && !isDate(w.date)) err(`${where}.when.date`, 'must be a YYYY-MM-DD date or null');
    if (!hasDate && !/^\d{4}-(0[1-9]|1[0-2])$/.test(w.month || '')) err(`${where}.when`, 'needs a date (YYYY-MM-DD) or a month (YYYY-MM)');
    if (typeof w.label !== 'string' || !w.label || wordCount(w.label) > 6) err(`${where}.when.label`, 'needs a short label of at most 6 words ("EICMA, 3 to 8 Nov", "March 2027")');
    const first = hasDate ? w.date : `${w.month}-01`;
    if (isDate(first) && first > upcomingHorizon) err(`${where}.when`, `is after ${upcomingHorizon}; list launches expected in the next ${LIMITS.upcoming_ahead_months} months`);
    if (hasDate && isDate(w.date) && w.date < date) err(`${where}.when.date`, 'has passed');
    checkText(`${where}.text`, u?.text, { max: 30 });
    const found = checkSources(where, u?.sources, upPool, new Map());
    if (found.length) {
      checkNumbers(`${where}.text`, u.text, found);
      const said = found.map((it) => `${it.title} ${it.summary} ${it.text}`).join(' ');
      const month = MONTH_NAMES[Number((hasDate ? w.date : w.month || '').slice(5, 7)) - 1];
      if (month && !new RegExp(`\\b${month.slice(0, 3)}`, 'i').test(said)) err(`${where}.when`, `${month} is not in its sources; cite the source that gives the date`);
      if (hasDate && isDate(w.date) && !numbersIn(said).has(String(Number(w.date.slice(8))))) err(`${where}.when.date`, `day ${Number(w.date.slice(8))} is not in its sources`);
    }
  });
}

// ---------- Brand videos worth watching ----------

// Videos the editor picked from the brands' YouTube channels, each with a reason. They must be videos in the pool.
const VIDEO_KINDS = ['teaser', 'launch', 'product', 'feature', 'event'];
const videos = ed.videos ?? [];
if (!Array.isArray(videos)) err('videos', 'must be a list');
else {
  if (videos.length > LIMITS.videos_max) err('videos', `has ${videos.length}; at most ${LIMITS.videos_max} a day`);
  const vids = new Map(pool.items.filter((it) => it.from_youtube).map((it) => [normUrl(it.url), it]));
  videos.forEach((v, i) => {
    const where = `videos[${i}]`;
    const it = vids.get(normUrl(v?.url || ''));
    if (!it) return err(`${where}.url`, 'must be a video from the pool (an item with "from_youtube": true)');
    if (typeof v.brand !== 'string' || !v.brand) err(`${where}.brand`, 'is missing');
    if (!VIDEO_KINDS.includes(v.kind)) err(`${where}.kind`, `must be one of ${VIDEO_KINDS.join(', ')}`);
    checkText(`${where}.title`, v.title, { max: 12 });
    checkText(`${where}.why`, v.why, { max: 25 });
    checkNumbers(`${where}.why`, v.why, [it]);
    if (v.published_at !== it.published_at) err(`${where}.published_at`, 'must be copied from the pool item');
  });
}

// ---------- Motorcycles only (performance scooters allowed) ----------

const filters = config.title_filters;
const carRe = new RegExp(filters.cars, 'i');
const bikeRe = new RegExp(filters.bikes, 'i');
const scooterRe = new RegExp(filters.scooters, 'i');
const perfRe = new RegExp(filters.performance_scooters, 'i');
const motoRe = new RegExp(filters.motorcycles, 'i');
const titled = [
  ...[lead, ...subs, ...heads].filter(Boolean).map((it, i) => [it.id ?? `story ${i + 1}`, it.headline]),
  ...events.map((ev) => [`events: ${ev?.id}`, ev?.name]),
  ...gear.map((a) => [`accessories: ${a?.id}`, `${a?.headline ?? ''} ${a?.product ?? ''}`]),
  ...(Array.isArray(upcoming) ? upcoming : []).map((u) => [`upcoming: ${u?.id}`, u?.name ?? '']),
  ...(Array.isArray(videos) ? videos : []).map((v) => [`videos: ${v?.url}`, v?.title ?? '']),
  ...trending.map((t) => [`trending: ${t?.term}`, t?.term]),
  ['trends_summary', ed.trends_summary?.headline],
];
for (const [where, text] of titled) {
  if (text && carRe.test(text) && !bikeRe.test(text)) err(where, 'is about cars, trucks or buses; Bike News covers motorcycles only');
  else if (text && scooterRe.test(text) && !perfRe.test(text) && !motoRe.test(text)) err(where, 'is about commuter scooters; Bike News covers motorcycles, and scooters only when they are performance scooters');
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
console.log(`OK ${file}: ${total} items (${lead ? 'lead, ' : 'no lead, '}${subs.length} subs, ${heads.length} headlines, ${trending.length} trending), ${events.length} events, ${gear.length} accessories, ${Array.isArray(upcoming) ? upcoming.length : 0} upcoming, ${Array.isArray(videos) ? videos.length : 0} videos`);
