#!/usr/bin/env node
// Fetch every source in config/sources.json and write pool/YYYY-MM-DD.json (IST date).
// A source that fails is listed as failed; the run carries on.
import { readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { path, istDate, istTimestamp, addDays, readJson, writeJson, normUrl } from './lib.mjs';

const config = await readJson(path('config/sources.json'));
const today = istDate();
const now = Date.now();
const UA = config.user_agent;

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ['item', 'ht:news_item'].includes(name),
});

// ---------- HTTP ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request at a time per host, a short gap between them, and a few patient retries when a site says
// "too many requests" or "unavailable". Sites that refuse us outright (403) are left alone.
const hostQueue = new Map();
function politely(host, fn) {
  const prev = hostQueue.get(host) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const gap = config.host_gap_ms[host] ?? config.host_gap_ms.default;
  hostQueue.set(host, run.then(() => sleep(gap), () => sleep(gap)));
  return run;
}

async function get(url, opts = {}) {
  const host = new URL(url).hostname;
  for (let attempt = 0; ; attempt++) {
    const res = await politely(host, () =>
      fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(config.timeout_ms),
        ...opts,
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-IN,en;q=0.9', ...(opts.headers || {}) },
      }),
    );
    if (res.ok) return { url: res.url, body: await res.text() };
    if ((res.status === 429 || res.status === 503) && attempt < config.retries) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Math.min(after > 0 ? after * 1000 : 2000 * 2 ** attempt, 15_000));
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${host}`);
  }
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- Text ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', rupee: '₹' };

function decode(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function clean(s) {
  return decode(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function clip(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.8 ? cut.slice(0, sp) : cut) + '…';
}

// The readable paragraphs of an article (or of a feed's content:encoded HTML).
function articleText(html) {
  let h = String(html || '').replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|figure|iframe)\b[\s\S]*?<\/\1>/gi, ' ');
  const art = h.match(/<article\b[\s\S]*<\/article>/i);
  if (art) h = art[0];
  const paras = [...h.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => clean(m[1]))
    .filter((p) => p.length >= 40 && !/^(also read|read more|click here|follow us|subscribe|disclaimer|copyright)/i.test(p));
  return paras.join(' ');
}

function metaDescription(html) {
  const m = String(html || '').match(/<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]*>/i);
  const c = m && m[0].match(/content=["']([^"']*)["']/i);
  return c ? clean(c[1]) : '';
}

function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'object') return String(node['#text'] ?? '');
  return String(node);
}

// ---------- Google News ----------

// Google News RSS links point at news.google.com, not the publisher. Read the article page once for its
// signature, then ask Google's own decoder for the publisher URL.
async function resolveGoogleNews(link) {
  const page = await get(link);
  const id = page.body.match(/data-n-a-id="([^"]+)"/)?.[1];
  const ts = page.body.match(/data-n-a-ts="([^"]+)"/)?.[1];
  const sg = page.body.match(/data-n-a-sg="([^"]+)"/)?.[1];
  if (!id || !ts || !sg) throw new Error('Google News page had no article signature');
  const inner = JSON.stringify([
    'garturlreq',
    [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    id, Number(ts), sg,
  ]);
  const body = new URLSearchParams({ 'f.req': JSON.stringify([[['Fbv4je', inner, null, 'generic']]]) });
  const res = await get('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  });
  const m = res.body.match(/\\"garturlres\\",\\"(https?:[^"\\]+)\\"/);
  if (!m) throw new Error('Google News did not return a publisher URL');
  return m[1];
}

// ---------- Sources ----------

async function readFeed(src) {
  const { body } = await get(src.url);
  const doc = xml.parse(body);
  const items = doc?.rss?.channel?.item ?? [];
  return items.slice(0, src.max_items).map((it) => {
    let title = clean(textOf(it.title));
    if (src.kind === 'gnews') title = title.replace(/\s+-\s+[^-]+$/, '');
    const published = it.pubDate ? new Date(textOf(it.pubDate)) : null;
    return {
      source: src.name,
      source_id: src.id,
      title,
      published_at: published && !isNaN(published) ? published.toISOString() : null,
      link: textOf(it.link).trim(),
      summary: src.kind === 'gnews' ? '' : clean(textOf(it.description)).replace(/\s*The post .* appeared first on .*$/i, ''),
      feed_html: textOf(it['content:encoded']),
    };
  });
}

async function readTrends(t) {
  const { body } = await get(t.url);
  const items = xml.parse(body)?.rss?.channel?.item ?? [];
  return items.slice(0, t.max_items).map((it) => ({
    term: clean(textOf(it.title)),
    traffic: textOf(it['ht:approx_traffic']).trim() || null,
    published_at: it.pubDate ? new Date(textOf(it.pubDate)).toISOString() : null,
    news: (it['ht:news_item'] ?? []).map((n) => ({
      title: clean(textOf(n['ht:news_item_title'])),
      url: textOf(n['ht:news_item_url']).trim(),
      source: clean(textOf(n['ht:news_item_source'])),
    })),
  }));
}

// The Trends page's own data call: every trend in the country for the last `hours`, each tagged with category
// ids. The RSS feed above ignores categories, so this is how we get Autos & Vehicles (category 1).
async function readCategoryTrends(t) {
  const inner = JSON.stringify([null, null, t.geo, 0, 'en-US', t.hours, 1]);
  const body = new URLSearchParams({ 'f.req': JSON.stringify([[['i0OFE', inner, null, 'generic']]]) });
  const res = await get(t.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  });
  const line = res.body.split('\n').find((l) => l.includes('"wrb.fr"'));
  const list = line && JSON.parse(JSON.parse(line)[0][2])?.[1];
  if (!Array.isArray(list)) throw new Error('Trends returned no list');
  return list
    .filter((r) => Array.isArray(r[10]) && r[10].includes(t.category))
    .sort((a, b) => (b[6] ?? 0) - (a[6] ?? 0))
    .slice(0, t.max_items)
    .map((r) => ({
      term: String(r[0]),
      traffic: r[6] ? `${r[6]}+` : null,
      published_at: r[3]?.[0] ? new Date(r[3][0] * 1000).toISOString() : null,
      category: t.category_name,
      related: (r[9] ?? []).slice(0, 6),
      news: [],
    }));
}

// Turn a raw feed item into a pool item: publisher URL, summary and up to text_chars of article text.
async function complete(raw, src) {
  const item = { ...raw };
  delete item.feed_html;
  item.url = item.link;
  if (src.kind === 'gnews') {
    try {
      item.url = await resolveGoogleNews(item.link);
    } catch (err) {
      item.url = null;
      item.error = String(err.message || err);
      return item;
    }
  }
  delete item.link;
  let text = articleText(raw.feed_html);
  // fetch_pages: false is for sites that refuse automated readers; their feed summary is all we use.
  if (text.length < 300 && src.fetch_pages !== false) {
    try {
      const page = await get(item.url);
      const fromPage = articleText(page.body);
      if (fromPage.length > text.length) text = fromPage;
      if (!item.summary) item.summary = metaDescription(page.body);
    } catch (err) {
      item.text_error = String(err.message || err);
    }
  }
  if (!item.summary) item.summary = clip(text, config.summary_chars);
  item.summary = clip(item.summary, config.summary_chars);
  item.text = clip(text, config.text_chars);
  return item;
}

function itemId(url) {
  return createHash('sha1').update(normUrl(url)).digest('hex').slice(0, 8);
}

// ---------- Run ----------

const report = [];
let raw = [];
await Promise.all(
  config.sources.map(async (src) => {
    try {
      const items = await readFeed(src);
      raw.push(...items.map((it) => ({ it, src })));
      report.push({ id: src.id, name: src.name, status: 'ok', in_feed: items.length });
    } catch (err) {
      report.push({ id: src.id, name: src.name, status: 'failed', error: String(err.message || err) });
    }
  }),
);

let trends = [];
let trendsStatus;
try {
  trends = await readTrends(config.trends);
  trendsStatus = { id: config.trends.id, name: config.trends.name, status: 'ok', in_feed: trends.length };
} catch (err) {
  trendsStatus = { id: config.trends.id, name: config.trends.name, status: 'failed', error: String(err.message || err) };
}
const ct = config.category_trends;
let categoryStatus;
try {
  const found = await readCategoryTrends(ct);
  const known = new Set(trends.map((t) => t.term.toLowerCase()));
  trends = [...found.filter((t) => !known.has(t.term.toLowerCase())), ...trends];
  categoryStatus = { id: ct.id, name: ct.name, status: 'ok', in_feed: found.length };
} catch (err) {
  categoryStatus = { id: ct.id, name: ct.name, status: 'failed', error: String(err.message || err) };
}

// Time window: 36 hours, widened to 48 if too little came back. Undated items are kept.
const within = (h) => raw.filter(({ it }) => !it.published_at || now - Date.parse(it.published_at) <= h * 3_600_000);
let windowHours = config.window_hours;
let chosen = within(windowHours);
if (chosen.length < config.min_items) {
  windowHours = config.fallback_window_hours;
  chosen = within(windowHours);
}

// Sources marked drop_car_titles (whole-auto sections such as NDTV Auto) lose headlines that are clearly about
// cars before any work is spent on them. A headline that also names bikes or scooters is kept.
const carTitle = new RegExp(config.title_filters.cars, 'i');
const bikeTitle = new RegExp(config.title_filters.bikes, 'i');
const carDrops = new Map();
chosen = chosen.filter(({ it, src }) => {
  if (!src.drop_car_titles || !carTitle.test(it.title) || bikeTitle.test(it.title)) return true;
  carDrops.set(src.id, (carDrops.get(src.id) ?? 0) + 1);
  return false;
});

const order = new Map(config.sources.map((s, i) => [s.id, i]));
chosen.sort((a, b) => order.get(a.src.id) - order.get(b.src.id) || (b.it.published_at || '').localeCompare(a.it.published_at || ''));

const completed = await mapLimit(chosen, config.concurrency, ({ it, src }) => complete(it, src));

const seen = new Set();
const items = [];
const dropped = { cars: [...carDrops.values()].reduce((a, b) => a + b, 0), unresolved: 0, off_section: 0, duplicate: 0 };
for (const [i, item] of completed.entries()) {
  const src = chosen[i].src;
  if (!item.url) { dropped.unresolved++; continue; }
  if (src.url_must_contain && !item.url.includes(src.url_must_contain)) { dropped.off_section++; continue; }
  if (src.url_exclude && new RegExp(src.url_exclude).test(item.url)) { dropped.off_section++; continue; }
  const key = normUrl(item.url);
  if (seen.has(key)) { dropped.duplicate++; continue; }
  seen.add(key);
  items.push({ id: `${src.id}-${itemId(item.url)}`, ...item });
}

for (const r of report) {
  if (r.status !== 'ok') continue;
  r.in_window = chosen.filter((c) => c.src.id === r.id).length;
  if (carDrops.has(r.id)) r.cars_dropped = carDrops.get(r.id);
  r.in_pool = items.filter((it) => it.source_id === r.id).length;
  const unresolved = completed.filter((it, i) => chosen[i].src.id === r.id && !it.url);
  if (unresolved.length) { r.unresolved = unresolved.length; r.unresolved_error = unresolved[0].error; }
  if (r.in_window > 0 && r.in_pool === 0 && unresolved.length === r.in_window) {
    r.status = 'failed';
    r.error = unresolved[0].error;
  }
}
report.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
report.push(trendsStatus, categoryStatus);

// Yesterday's edition (the most recent one before today), so nothing repeats without new information.
let previous = null;
const latest = await readJson(path('content/latest.json'), null);
if (latest && latest.edition < today) previous = latest;
else {
  const files = (await readdir(path('content/editions')).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < today).sort();
  if (files.length) previous = await readJson(path('content/editions', files.at(-1)));
}

const pool = {
  date: today,
  generated_at: istTimestamp(),
  window_hours: windowHours,
  sources: report,
  sources_failed: report.filter((r) => r.status === 'failed').map((r) => r.name),
  dropped,
  items,
  trends,
  previous_edition: previous,
};

const out = path('pool', `${today}.json`);
await writeJson(out, pool);

// Keep the last pool_keep_days days of pools.
const cutoff = addDays(today, -config.pool_keep_days);
for (const f of await readdir(path('pool'))) {
  const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
  if (m && m[1] < cutoff) await unlink(path('pool', f));
}

console.log(`pool/${today}.json: ${items.length} items (last ${windowHours} h), ${trends.length} trends`);
for (const r of report) {
  console.log(`  ${r.status === 'ok' ? 'ok    ' : 'FAILED'} ${r.name.padEnd(22)} ${r.status === 'ok' ? `${r.in_pool ?? r.in_feed} items${r.in_window === 0 ? ` (none in the last ${windowHours} h)` : ""}${r.unresolved ? `, ${r.unresolved} unresolved` : ''}${r.cars_dropped ? `, ${r.cars_dropped} car headlines dropped` : ''}` : r.error}`);
}
if (dropped.cars || dropped.duplicate || dropped.off_section || dropped.unresolved) console.log(`  dropped: ${JSON.stringify(dropped)}`);
