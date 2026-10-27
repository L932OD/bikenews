#!/usr/bin/env node
// Make a validated edition the live one:
//   content/latest.json    the edition itself
//   content/archive.json   the editions kept (the last keep_days days)
//   content/events.json    every event still to come, built up day by day
//   content/trends.json    today's Google Trends data, plus a short history
// Editions older than keep_days are deleted. Events stay until they are over.
// Usage: node scripts/publish.mjs content/editions/YYYY-MM-DD.json
import { readdir, unlink } from 'node:fs/promises';
import { path, readJson, writeJson, addDays } from './lib.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/publish.mjs content/editions/YYYY-MM-DD.json');
  process.exit(2);
}

const config = await readJson(path('config/sources.json'));
const keep = config.keep_days;
const ed = await readJson(file);
const today = ed.edition;
const cutoff = addDays(today, -(keep - 1));
const count = (ed.lead ? 1 : 0) + (ed.subs?.length || 0) + (ed.headlines?.length || 0);
const pool = await readJson(path('pool', `${today}.json`), {});

await writeJson(path('content/latest.json'), ed);

// ---------- Archive: the last keep_days editions ----------

const archive = await readJson(path('content/archive.json'), { editions: [] });
const entry = {
  edition: ed.edition,
  published_at: ed.published_at,
  stories: count,
  events: ed.events?.length ?? 0,
  accessories: ed.accessories?.length ?? 0,
  lead: ed.lead?.headline ?? ed.subs?.[0]?.headline ?? ed.headlines?.[0]?.headline ?? null,
};
archive.editions = [entry, ...archive.editions.filter((e) => e.edition !== ed.edition)]
  .filter((e) => e.edition >= cutoff)
  .sort((a, b) => b.edition.localeCompare(a.edition));
await writeJson(path('content/archive.json'), archive);

let removed = 0;
for (const f of await readdir(path('content/editions'))) {
  const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
  if (m && m[1] < cutoff) {
    await unlink(path('content/editions', f));
    removed++;
  }
}

// ---------- Events: a calendar of everything still to come ----------

const calendar = await readJson(path('content/events.json'), { events: [] });
const byId = new Map(calendar.events.map((e) => [e.id, e]));
for (const ev of ed.events ?? []) {
  const old = byId.get(ev.id);
  byId.set(ev.id, { ...ev, first_seen: old?.first_seen ?? today, updated: today });
}
const events = [...byId.values()]
  .filter((e) => (e.end_date || e.start_date) >= today)
  .sort((a, b) => a.start_date.localeCompare(b.start_date));
await writeJson(path('content/events.json'), { updated: ed.published_at, events });

// ---------- Trends: today's Explore data and Autos trends, with a keep_days history ----------

const trends = await readJson(path('content/trends.json'), { days: [] });
const ex = pool.explore;
const autos = (pool.trends ?? []).filter((t) => t.category).map(({ term, traffic, related }) => ({ term, traffic, related }));
// Related-search scores are 0 to 100 within each keyword, so lists from different keywords cannot share a scale.
// Top searches come from the most-searched plain term (not the topic); rising ones are merged, Breakout first.
const kw = ex?.keywords ?? [];
const plain = kw.map((k, i) => ({ k, avg: ex.averages[i] ?? 0, q: config.explore.keywords[i]?.q ?? k })).filter((x) => !x.q.startsWith('/m/'));
const lead = plain.sort((a, b) => b.avg - a.avg)[0]?.k;
const trivial = new Set([...kw, 'motorcycle', 'motorbike'].map((k) => k.toLowerCase()));
const topList = (ex?.related ?? []).find((r) => r.keyword === lead)?.top.filter((q) => !trivial.has(q.q.toLowerCase())) ?? [];
const pct = (v) => (v === 'Breakout' ? Infinity : Number(String(v).replace(/[^\d]/g, '')) || 0);
const risingAll = new Map();
for (const r of ex?.related ?? []) for (const q of r.rising) if (!trivial.has(q.q.toLowerCase()) && !risingAll.has(q.q)) risingAll.set(q.q, q);
const risingList = [...risingAll.values()].sort((a, b) => pct(b.value) - pct(a.value));
const day = ex
  ? { date: today, keywords: ex.keywords, averages: ex.averages, top_from: lead ?? null, top: topList.slice(0, 10), rising: risingList.slice(0, 10), states: ex.states.slice(0, 8), autos, picks: ed.trending ?? [] }
  : { date: today, keywords: [], averages: [], top: [], rising: [], states: [], autos, picks: ed.trending ?? [] };
trends.days = [day, ...trends.days.filter((d) => d.date !== today)].filter((d) => d.date >= cutoff).sort((a, b) => b.date.localeCompare(a.date));
trends.updated = ed.published_at;
trends.timeline = ex ? { keywords: ex.keywords, points: ex.timeline } : trends.timeline ?? null;
await writeJson(path('content/trends.json'), trends);

console.log(
  `Published ${ed.edition}: ${count} stories, ${ed.events?.length ?? 0} events, ${ed.accessories?.length ?? 0} accessories. ` +
    `Archive keeps ${archive.editions.length} editions${removed ? ` (${removed} older removed)` : ''}; ${events.length} upcoming events; ` +
    `trends history ${trends.days.length} days.`,
);
