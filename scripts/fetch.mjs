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

// Bike News is motorcycles only: electric motorcycles count, scooters only when they are performance scooters.
// A headline about cars, trucks or buses, or about commuter scooters, is dropped everywhere unless it also names
// motorcycles. Trending searches are kept only when they name a motorcycle, a brand or a model.
const carTitle = new RegExp(config.title_filters.cars, 'i');
const bikeTitle = new RegExp(config.title_filters.bikes, 'i');
const bikeName = new RegExp(config.title_filters.bike_names, 'i');
const notRiders = new RegExp(config.title_filters.not_riders, 'i');
const scooterTitle = new RegExp(config.title_filters.scooters, 'i');
const performanceScooter = new RegExp(config.title_filters.performance_scooters, 'i');
const motorcycleTitle = new RegExp(config.title_filters.motorcycles, 'i');
const isCar = (t) => carTitle.test(t) && !bikeTitle.test(t);
const isScooter = (t) => scooterTitle.test(t) && !performanceScooter.test(t) && !motorcycleTitle.test(t);
const offTopic = (t) => isCar(t) || isScooter(t);

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

// retryOn: further statuses worth another try for this request (YouTube's feeds answer 404 or 500 now and then for
// channels that exist).
async function get(url, { retryOn = [], ...opts } = {}) {
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
    if (res.ok) return { url: res.url, headers: res.headers, body: await res.text() };
    if ((res.status === 429 || res.status === 503 || retryOn.includes(res.status)) && attempt < config.retries) {
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
      // Section searches cover many publishers: name each item after the publisher Google News gives.
      source: src.publisher_from_feed ? clean(textOf(it.source)) || src.name : src.name,
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
  // Keep bike searches only: a search must name a bike, brand or model (in English or Hindi). The Autos & Vehicles
  // category alone is not enough: it is mostly cars, often written in Hindi. Share prices are about companies.
  return list
    .filter((r) => {
      const words = [r[0], ...(r[9] ?? [])].join(' · ');
      return bikeName.test(words) && !offTopic(String(r[0])) && !notRiders.test(words);
    })
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

// ---------- Sections: events and aftermarket accessories ----------

const gnSearch = (q, days) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${days}d`)}&hl=en-IN&gl=IN&ceid=IN:en`;

// Readable text of a whole page (an organiser's site), not just its paragraphs.
function pageText(html) {
  return clean(String(html || '').replace(/<(script|style|noscript|svg|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, ' · '))
    .replace(/(\s·\s*)+/g, ' · ');
}

// Section stories stay relevant for weeks (an event announced in September is still on in December), so the same
// Google News links come back every day. Links resolved in the last few pools are reused instead of fetched again.
const resolvedCache = new Map();
for (const f of (await readdir(path('pool')).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) <= today)) {
  const old = await readJson(path('pool', f), null);
  for (const it of [...(old?.items ?? []), ...(old?.events ?? []), ...(old?.accessories ?? [])]) if (it.gn_link && it.url) resolvedCache.set(it.gn_link, it);
}

async function readSection(key, sec, known) {
  const src = { id: key, name: sec.name, kind: 'gnews', publisher_from_feed: true, max_items: sec.max_per_query };
  const status = { id: key, name: sec.name, status: 'ok' };
  const exclude = sec.exclude_title ? new RegExp(sec.exclude_title, 'i') : null;
  const raws = [];
  const titles = new Set();
  for (const q of sec.queries) {
    try {
      for (const it of await readFeed({ ...src, url: gnSearch(q, sec.window_days) })) {
        const t = it.title.toLowerCase();
        if (titles.has(t) || (exclude && exclude.test(it.title)) || offTopic(it.title)) continue;
        if (it.published_at && now - Date.parse(it.published_at) > sec.window_days * 86_400_000) continue;
        titles.add(t);
        raws.push(it);
      }
    } catch (err) {
      status.error = String(err.message || err);
    }
  }
  const done = await mapLimit(raws, config.concurrency, async (it) => {
    const hit = resolvedCache.get(it.link);
    if (hit) return { ...hit, published_at: it.published_at };
    return { ...(await complete(it, src)), gn_link: it.link };
  });
  const out = [];
  for (const item of done) {
    if (!item.url) continue;
    const k = normUrl(item.url);
    if (known.has(k)) continue;
    known.add(k);
    const { id: _old, ...rest } = item;
    out.push({ id: `${key}-${itemId(item.url)}`, ...rest });
  }
  const pages = [];
  for (const pg of sec.pages ?? []) {
    try {
      const res = await get(pg.url);
      pages.push({ id: `${key}-page-${itemId(pg.url)}`, source: pg.name, url: res.url, title: pg.name, summary: '', text: clip(pageText(res.body), sec.page_chars) });
    } catch (err) {
      pages.push({ id: `${key}-page-${itemId(pg.url)}`, source: pg.name, url: pg.url, title: pg.name, summary: '', text: '', text_error: String(err.message || err) });
    }
  }
  status.in_pool = out.length + pages.filter((p) => p.text).length;
  if (!out.length && status.error) status.status = 'failed';
  return { items: [...out, ...pages], status };
}

// Brands that run their own online store publish its product list, with the date each product was added. A product
// added in the last few days is a new product, straight from the maker; spares and merchandise are left out.
async function readStores(sec, known) {
  const status = { id: 'brand-stores', name: 'Brand stores', status: 'ok', in_pool: 0 };
  const exclude = new RegExp(sec.store_exclude, 'i');
  const failed = [];
  const out = [];
  const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  for (const b of sec.brands.filter((b) => b.store === 'shopify')) {
    try {
      const res = await get(`${b.site}/products.json?limit=250`, { headers: { Accept: 'application/json' } });
      const found = [];
      for (const p of JSON.parse(res.body).products ?? []) {
        const added = Date.parse(p.created_at);
        if (!p.published_at || !(now - added <= sec.store_window_days * 86_400_000)) continue;
        if (exclude.test(`${p.title} ${p.product_type}`) || offTopic(p.title)) continue;
        const prices = (p.variants ?? []).map((v) => Number(v.price)).filter((n) => n > 0);
        const price = prices.length ? `Price on the brand's store: ${inr(Math.min(...prices))}${Math.max(...prices) > Math.min(...prices) ? ` to ${inr(Math.max(...prices))}` : ''}.` : '';
        const url = `${b.site}/products/${p.handle}`;
        if (known.has(normUrl(url))) continue;
        known.add(normUrl(url));
        found.push({
          id: `store-${itemId(url)}`,
          source: b.name,
          source_id: 'brand-stores',
          from_store: true,
          title: clean(p.title).toLowerCase().startsWith(b.name.toLowerCase()) ? clean(p.title) : `${b.name}: ${clean(p.title)}`,
          published_at: new Date(added).toISOString(),
          summary: clean([p.product_type, price].filter(Boolean).join('. ')),
          url,
          text: clip(clean(`${price} ${p.body_html ?? ''}`), config.text_chars),
        });
      }
      out.push(...found.sort((x, y) => y.published_at.localeCompare(x.published_at)).slice(0, sec.store_max_per_brand));
    } catch (err) {
      failed.push(`${b.name} (${String(err.message || err)})`);
    }
  }
  status.in_pool = out.length;
  if (failed.length) status.error = `no list from ${failed.join(', ')}`;
  if (failed.length && failed.length === sec.brands.filter((b) => b.store === 'shopify').length) status.status = 'failed';
  return { items: out, status };
}

// ---------- Every bike maker, every run ----------

// One Google News search per bike maker over the last window_hours, so no maker's news is missed because no bike
// site wrote it up. A headline counts only when it names the maker or one of its models and is about bikes.
// (The aftermarket brands each have their own search in sections.accessories.)
const termsRe = (terms) => new RegExp(`(^|[^\\p{L}\\p{N}])(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
async function readMakerNews(cfg, makers, known) {
  const status = { id: cfg.id, name: cfg.name, status: 'ok', in_pool: 0 };
  const src = { id: cfg.id, name: cfg.name, kind: 'gnews', publisher_from_feed: true, max_items: 20 };
  const failed = [];
  const raws = [];
  // Dealer price pages, comparisons, reviews, race reports and stock tips are not news about the maker.
  const noise = cfg.exclude_title ? new RegExp(cfg.exclude_title, 'i') : null;
  for (const m of makers) {
    const brandRe = termsRe([m.name, ...(m.match ?? [])]);
    const modelRe = (m.match ?? []).length ? termsRe(m.match.filter((t) => t.toLowerCase() !== m.name.toLowerCase())) : null;
    try {
      const found = (await readFeed({ ...src, url: gnSearch(m.news_query ? `"${m.news_query}"` : `"${m.name}"`, 1) }))
        .filter((it) => it.published_at && now - Date.parse(it.published_at) <= cfg.window_hours * 3_600_000)
        .filter((it) => brandRe.test(it.title) && !offTopic(it.title) && !noise?.test(it.title) && !notRiders.test(it.title) && (bikeTitle.test(it.title) || bikeName.test(it.title) || modelRe?.test(it.title)))
        .slice(0, cfg.max_per_brand);
      for (const it of found) raws.push({ ...it, brand_check: m.name });
    } catch (err) {
      failed.push(`${m.name} (${String(err.message || err)})`);
    }
  }
  const out = [];
  for (const item of await mapLimit(raws, config.concurrency, (it) => complete(it, src))) {
    if (!item.url || known.has(normUrl(item.url))) continue;
    known.add(normUrl(item.url));
    out.push({ id: `${cfg.id}-${itemId(item.url)}`, ...item });
  }
  status.in_pool = out.length;
  if (failed.length) status.error = `no search for ${failed.join(', ')}`;
  if (failed.length === makers.length) status.status = 'failed';
  return { items: out, status };
}

// The checklist: for every brand we follow, what this run found about it (news, its own videos, its store, gear),
// and anything that could not be read, so a brand is never skipped without anyone knowing.
function brandChecklist(pool, report) {
  const ytFailed = new Set(report.find((r) => r.id === config.youtube?.id)?.failed_channels ?? []);
  const storeErr = report.find((r) => r.id === 'brand-stores')?.error ?? '';
  const brands = [
    ...(config.makers ?? []).map((m) => ({ name: m.name, kind: 'maker', re: termsRe([m.name, ...(m.match ?? [])]), channels: config.youtube?.channels.filter((c) => c.channel_id === m.youtube).map((c) => c.name) ?? [] })),
    ...(config.sections.accessories?.brands ?? []).map((b) => ({ name: b.name, kind: 'gear', re: termsRe([b.name, ...(b.aka ?? [])]), channels: config.youtube?.channels.filter((c) => c.name === b.name).map((c) => c.name) ?? [], store: b.store })),
  ];
  return brands.map((b) => {
    const news = pool.items.filter((it) => !it.from_youtube && b.re.test(it.title)).length;
    const videos = pool.items.filter((it) => it.from_youtube && b.re.test(`${it.source} ${it.title}`)).length;
    const store = pool.accessories.filter((it) => it.from_store && it.source === b.name).length;
    const gear = pool.accessories.filter((it) => !it.from_store && b.re.test(it.title)).length;
    const errors = [
      ...b.channels.filter((c) => ytFailed.has(c)).map((c) => `YouTube channel ${c} could not be read`),
      ...(b.store && storeErr.includes(b.name) ? ['store could not be read'] : []),
    ];
    return { brand: b.name, kind: b.kind, news, videos, store, gear, errors };
  });
}

// ---------- Brand channels on YouTube ----------

// Every YouTube channel has a public feed of its latest videos. Brands often post teasers and launch films there
// before the press writes about them. Videos from the last window_hours become pool items like any story.
async function readYouTube(yt) {
  const status = { id: yt.id, name: yt.name, status: 'ok', in_pool: 0 };
  const failed = [];
  const out = [];
  const list = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  // A channel whose feed fails is tried again at the end, after the others, before it counts as failed.
  const readChannel = async (ch, retry = true) => {
      const res = await get(`${yt.url}${ch.channel_id}`, { retryOn: retry ? yt.retry_statuses ?? [] : [] });
      for (const e of list(xml.parse(res.body).feed?.entry)) {
        const published = e.published;
        if (!published || now - Date.parse(published) > yt.window_hours * 3_600_000) continue;
        const title = clean(e.title?.['#text'] ?? e.title);
        if (offTopic(title)) continue;
        const url = `https://www.youtube.com/watch?v=${e['yt:videoId']}`;
        const desc = clean(e['media:group']?.['media:description']?.['#text'] ?? e['media:group']?.['media:description'] ?? '');
        out.push({
          id: `${yt.id}-${itemId(url)}`,
          source: `${ch.name} on YouTube`,
          source_id: yt.id,
          from_youtube: true,
          channel_kind: ch.kind,
          title,
          published_at: new Date(published).toISOString(),
          summary: clip(desc, config.summary_chars),
          url,
          text: clip(desc, yt.text_chars),
        });
      }
  };
  // When YouTube is failing for everyone (three channels in a row), the first pass stops retrying and leaves the
  // rest to the second pass, so a bad moment does not hold the run up for minutes.
  const pending = [];
  let inRow = 0;
  for (const ch of yt.channels) {
    try { await readChannel(ch, inRow < 3); inRow = 0; } catch { pending.push(ch); inRow++; }
  }
  if (pending.length) {
    await sleep(yt.second_pass_wait_ms ?? 20_000);
    for (const ch of pending) {
      try { await readChannel(ch); } catch (err) { failed.push({ name: ch.name, error: String(err.message || err) }); }
    }
  }
  status.in_pool = out.length;
  status.failed_channels = failed.map((f) => f.name);
  if (failed.length) status.error = `no feed from ${failed.map((f) => `${f.name} (${f.error})`).join(', ')}`;
  if (failed.length === yt.channels.length) status.status = 'failed';
  return { items: out, status };
}

// ---------- Google Trends Explore ----------

// The same data the Explore page draws: interest over time for each keyword, what people searched alongside
// them (top and rising), and where in India. Google's own page API; one session cookie, then widget calls.
async function readExplore(ex) {
  const home = await get(`https://trends.google.com/trends/?geo=${ex.geo}`);
  const cookie = (home.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const headers = cookie ? { Cookie: cookie } : {};
  const api = async (pathAndQuery) => {
    const res = await get(`https://trends.google.com/trends/api/${pathAndQuery}`, { headers });
    return JSON.parse(res.body.slice(res.body.indexOf('{')));
  };
  const req = {
    comparisonItem: ex.keywords.map((k) => ({ keyword: k.q, geo: ex.geo, time: ex.time })),
    category: ex.category,
    property: '',
  };
  const { widgets } = await api(`explore?hl=${ex.hl}&tz=${ex.tz}&req=${encodeURIComponent(JSON.stringify(req))}`);
  const widget = (id) => widgets.find((w) => w.id === id);
  const data = (endpoint, w) => api(`widgetdata/${endpoint}?hl=${ex.hl}&tz=${ex.tz}&req=${encodeURIComponent(JSON.stringify(w.request))}&token=${w.token}`);

  const ts = (await data('multiline', widget('TIMESERIES'))).default;
  const result = {
    keywords: ex.keywords.map((k) => k.label),
    time: ex.time,
    category: ex.category,
    averages: ts.averages ?? [],
    timeline: ts.timelineData.map((p) => ({ t: new Date(Number(p.time) * 1000).toISOString(), v: p.value })),
    related: [],
    states: [],
  };
  for (const [i, k] of ex.keywords.entries()) {
    const w = widget(`RELATED_QUERIES_${i}`);
    if (!w) continue;
    try {
      const [top, rising] = (await data('relatedsearches', w)).default.rankedList;
      result.related.push({
        keyword: k.label,
        top: top.rankedKeyword.filter((r) => !offTopic(r.query) && !notRiders.test(r.query)).slice(0, ex.related_per_keyword).map((r) => ({ q: r.query, value: r.value })),
        rising: rising.rankedKeyword.filter((r) => !offTopic(r.query) && !notRiders.test(r.query)).slice(0, ex.related_per_keyword).map((r) => ({ q: r.query, value: r.formattedValue })),
      });
    } catch {
      // A keyword with too little data has no related searches.
    }
  }
  const map = widget(`GEO_MAP_${ex.keywords.length - 1}`);
  if (map) {
    const geo = (await data('comparedgeo', map)).default.geoMapData;
    result.states = geo.filter((g) => g.hasData?.[0]).map((g) => ({ name: g.geoName, value: g.value[0] })).sort((a, b) => b.value - a.value);
  }
  return result;
}

// Turn a raw feed item into a pool item: publisher URL, summary and up to text_chars of article text.
async function complete(raw, src) {
  const item = { ...raw };
  delete item.feed_html;
  item.url = item.link;
  if (src.kind === 'gnews') {
    // A story already decoded in an earlier run (this morning's, or one of the last few days') is reused as it was,
    // so the evening run asks Google News for far less.
    const hit = resolvedCache.get(raw.link);
    if (hit?.url) {
      const { id: _id, ...kept } = hit;
      return { ...kept, source: raw.source, source_id: raw.source_id, title: raw.title, published_at: raw.published_at ?? hit.published_at, gn_link: raw.link };
    }
    item.gn_link = raw.link;
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
  // The all-topics daily feed: only the rare bike search in it is kept.
  trends = (await readTrends(config.trends)).filter((t) => {
    const words = [t.term, ...t.news.map((n) => n.title)].join(' · ');
    return bikeName.test(t.term) && !offTopic(t.term) && !notRiders.test(words);
  });
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

// Car, truck, bus and commuter-scooter headlines are dropped before any work is spent on them.
const carDrops = new Map();
chosen = chosen.filter(({ it, src }) => {
  if (!offTopic(it.title)) return true;
  carDrops.set(src.id, (carDrops.get(src.id) ?? 0) + 1);
  return false;
});

const order = new Map(config.sources.map((s, i) => [s.id, i]));
chosen.sort((a, b) => order.get(a.src.id) - order.get(b.src.id) || (b.it.published_at || '').localeCompare(a.it.published_at || ''));

const completed = await mapLimit(chosen, config.concurrency, ({ it, src }) => complete(it, src));

const seen = new Set();
const items = [];
const dropped = { off_topic: [...carDrops.values()].reduce((a, b) => a + b, 0), unresolved: 0, off_section: 0, duplicate: 0 };
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
  if (carDrops.has(r.id)) r.off_topic_dropped = carDrops.get(r.id);
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

// Brand videos join the news: a teaser on a brand's own channel is a source like any article.
if (config.youtube) {
  const yt = await readYouTube(config.youtube);
  for (const v of yt.items) {
    const key = normUrl(v.url);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(v);
  }
  report.push(yt.status);
}

// Every bike maker's own search, after the news so its stories are not counted twice.
if (config.brand_news) {
  const known = new Set(items.map((it) => normUrl(it.url)));
  const mk = await readMakerNews(config.brand_news, config.makers ?? [], known);
  items.push(...mk.items);
  report.push(mk.status);
}

// Section searches, after the news so their stories are not counted twice.
const knownUrls = new Set(items.map((it) => normUrl(it.url)));
const sections = {};
for (const [key, sec] of Object.entries(config.sections)) {
  const { items: found, status } = await readSection(key, sec, knownUrls);
  sections[key] = found;
  report.push(status);
  if (sec.brands) {
    const stores = await readStores(sec, knownUrls);
    sections[key].push(...stores.items);
    report.push(stores.status);
  }
}

let explore = null;
try {
  explore = await readExplore(config.explore);
  report.push({ id: config.explore.id, name: config.explore.name, status: 'ok', in_feed: explore.timeline.length });
} catch (err) {
  report.push({ id: config.explore.id, name: config.explore.name, status: 'failed', error: String(err.message || err) });
}

// Yesterday's edition (the most recent one before today), so nothing repeats without new information. When today's
// edition already exists (the morning run), the evening run adds to it: it is in the pool as this_morning.
let previous = null;
const latest = await readJson(path('content/latest.json'), null);
const thisMorning = latest && latest.edition === today ? latest : null;
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
  explore,
  events: sections.events ?? [],
  accessories: sections.accessories ?? [],
  brands: (config.sections.accessories?.brands ?? []).map(({ name, aka, made_in }) => ({ name, aka, made_in })),
  makers: (config.makers ?? []).map(({ name, made_in }) => ({ name, made_in })),
  events_calendar: (await readJson(path('content/events.json'), { events: [] })).events,
  upcoming_calendar: (await readJson(path('content/upcoming.json'), { items: [] })).items,
  previous_edition: previous,
  this_morning: thisMorning,
};
pool.brand_check = brandChecklist(pool, report);

const out = path('pool', `${today}.json`);
await writeJson(out, pool);

// Keep the last pool_keep_days days of pools.
const cutoff = addDays(today, -config.pool_keep_days);
for (const f of await readdir(path('pool'))) {
  const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
  if (m && m[1] < cutoff) await unlink(path('pool', f));
}

console.log(`pool/${today}.json: ${items.length} items (last ${windowHours} h), ${trends.length} trends, ${pool.events.length} event items, ${pool.accessories.length} accessory items`);
for (const r of report) {
  console.log(`  ${r.status === 'ok' ? 'ok    ' : 'FAILED'} ${r.name.padEnd(22)} ${r.status === 'ok' ? `${r.in_pool ?? r.in_feed} items${r.in_window === 0 ? ` (none in the last ${windowHours} h)` : ""}${r.unresolved ? `, ${r.unresolved} unresolved` : ''}${r.off_topic_dropped ? `, ${r.off_topic_dropped} car or scooter headlines dropped` : ''}` : r.error}`);
}
if (dropped.off_topic || dropped.duplicate || dropped.off_section || dropped.unresolved) console.log(`  dropped: ${JSON.stringify(dropped)}`);

// The brand checklist: every brand we follow, what was found, and anything that could not be read.
const found = (b) => [b.news && `${b.news} news`, b.videos && `${b.videos} videos`, b.store && `${b.store} store`, b.gear && `${b.gear} gear`].filter(Boolean).join(', ');
const withNews = pool.brand_check.filter((b) => found(b));
console.log(`Brand check: ${pool.brand_check.length} brands checked, ${withNews.length} with something in the pool${thisMorning ? ' (evening run: adds to this morning)' : ''}`);
for (const b of pool.brand_check) console.log(`  ${b.errors.length ? 'CHECK ' : '      '}${b.brand.padEnd(24)} ${found(b) || 'nothing new'}${b.errors.length ? ` · ${b.errors.join('; ')}` : ''}`);
