// Bike News: a home screen of four sections (Feed, Events, Trending now, Aftermarket), each opening a
// detail page. Reads content/latest.json, archive.json, events.json, trends.json, brands.json and the kept editions.
(() => {
  'use strict';

  const TYPE_LABEL = {
    launch: 'Launch', price: 'Price', recall: 'Recall', sales: 'Sales', ev: 'EV', policy: 'Policy',
    upcoming: 'Upcoming', spy: 'Spy shot', rumour: 'Rumour', racing: 'Racing', other: 'News',
  };
  const EVENT_KIND = {
    race: 'Race', festival: 'Festival', ride: 'Ride', 'track-day': 'Track day', training: 'Training', expo: 'Expo',
    meetup: 'Meetup', other: 'Event',
  };
  const GEAR_LABEL = {
    helmet: 'Helmet', 'riding-gear': 'Riding gear', luggage: 'Luggage', protection: 'Protection',
    electronics: 'Electronics', performance: 'Performance', styling: 'Styling', care: 'Care', other: 'Accessory',
  };
  // Filters on the Feed page: label -> the story types it shows.
  const LAUNCH_FILTERS = [
    ['All', null], ['Launches', ['launch', 'price']], ['Upcoming', ['upcoming']], ['Spy shots', ['spy', 'rumour']],
    ['EV', ['ev']], ['Business', ['sales', 'policy']], ['Racing', ['racing']], ['Other', ['other', 'recall']],
  ];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // ---------- Building blocks ----------

  // Tiny element builder. Text always goes in as text, never as HTML.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const SVG = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  // Replace a container's content; lists are flattened and empty slots skipped.
  const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

  // Dates are shown in India time whatever the reader's clock says.
  function ist(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    const d = new Date(t + 330 * 60000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
  }
  const ymdOf = (t) => `${t.y}-${pad2(t.m + 1)}-${pad2(t.d)}`;
  const parseYmd = (ymd) => new Date(ymd + 'T00:00:00Z');
  function dayLabel(ymd) {
    const d = parseYmd(ymd);
    return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  }
  // The date and time an item was published: "28 Oct, 14:19".
  function stamp(iso) {
    const t = ist(iso);
    return t ? `${t.d} ${MONTHS[t.m]}, ${pad2(t.hh)}:${pad2(t.mm)}` : '';
  }
  const stampTag = (iso) => (iso ? h('time', { class: 'stamp', datetime: iso }, stamp(iso)) : null);
  const byNewest = (a, b) => (Date.parse(b) || 0) - (Date.parse(a) || 0);
  // The last day the events page looks ahead to: today plus the months the archive says.
  function horizonOf(d, today) {
    const end = parseYmd(today);
    end.setUTCMonth(end.getUTCMonth() + (d.archive?.page?.events_ahead_months ?? 3));
    return end.toISOString().slice(0, 10);
  }
  const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
  function relDay(ymd, today) {
    const n = daysBetween(today, ymd);
    if (n === 0) return 'Today';
    if (n === -1) return 'Yesterday';
    if (n === 1) return 'Tomorrow';
    return n > 0 ? `In ${n} days` : dayLabel(ymd);
  }
  function eventDates(ev) {
    const a = parseYmd(ev.start_date);
    const b = ev.end_date ? parseYmd(ev.end_date) : null;
    const md = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    if (!b || ev.end_date === ev.start_date) return md(a);
    if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()) return `${a.getUTCDate()}–${md(b)}`;
    return `${md(a)} – ${md(b)}${a.getUTCFullYear() !== b.getUTCFullYear() ? ` ${b.getUTCFullYear()}` : ''}`;
  }

  const link = (src, cls) => h('a', { class: cls, href: src.url, target: '_blank', rel: 'noopener' }, src.name);
  const tag = (type) => h('span', { class: 'tag', 'data-type': type }, TYPE_LABEL[type] || 'News');
  const updateTag = (it) => (it.tag === 'update' ? h('span', { class: 'tag tag--update' }, 'Update') : null);
  // A product the brand has teased but not launched yet.
  const soonTag = (it) => (it.teased ? h('span', { class: 'tag tag--soon' }, 'Coming soon') : null);
  const stripes = () => h('span', { class: 'stripes', 'aria-hidden': 'true' });
  const sources = (list, label = 'Read at') =>
    h('div', { class: 'sources' }, h('span', { class: 'label' }, label), (list || []).map((x) => link(x, 'src')));

  function plate(fig) {
    if (!fig || !fig.value) return null;
    return h('div', { class: 'plate' }, h('span', { class: 'plate__value' }, fig.value), fig.label ? h('span', { class: 'plate__label' }, fig.label) : null);
  }
  function specs(list) {
    if (!Array.isArray(list) || !list.length) return null;
    return h('dl', { class: 'specs' }, list.slice(0, 3).map(([k, v]) => h('div', { class: 'spec' }, h('dt', null, k), h('dd', null, v))));
  }
  const pageHead = (section, title, sub) =>
    h('header', { class: 'page-head', 'data-section': section },
      h('a', { class: 'back', href: '#/' }, h('span', { 'aria-hidden': 'true' }, '←'), ' Home'),
      h('h1', { class: 'page-title' }, title),
      sub ? h('p', { class: 'page-sub' }, sub) : null);
  const empty = (text) => h('p', { class: 'empty' }, text);
  // The address of one item on its section page, e.g. #/launches/re-himalayan-750-teaser.
  const itemHref = (section, key) => `#/${section}/${encodeURIComponent(key)}`;
  const trendKey = (term) => String(term).toLowerCase();

  // ---------- Data ----------

  const cache = new Map();
  async function getJson(url) {
    if (!cache.has(url)) {
      cache.set(url, fetch(url, { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      }));
    }
    return cache.get(url).catch((e) => {
      cache.delete(url);
      throw e;
    });
  }
  const optional = (p) => p.catch(() => null);
  async function editions(archive, latest) {
    const dates = (archive?.editions ?? []).map((e) => e.edition);
    const list = await Promise.all(dates.map((d) => (latest && d === latest.edition ? latest : optional(getJson(`content/editions/${d}.json`)))));
    return list.filter(Boolean);
  }
  const storiesOf = (ed) => [ed.lead, ...(ed.subs || []), ...(ed.headlines || [])].filter(Boolean);

  // Story id -> the hot search behind it ("5000+", "Breakout", "+350%"), from today's trends.
  function hotStories(d) {
    const day = d.trends?.days?.[0];
    const out = new Map();
    if (!day) return out;
    const byUrl = new Map();
    for (const ed of d.eds) for (const st of storiesOf(ed)) for (const src of st.sources || []) if (!byUrl.has(src.url)) byUrl.set(src.url, st.id);
    const mark = (id, value) => { if (id && isHot(value) && !out.has(id)) out.set(id, value); };
    for (const x of day.searches ?? []) mark(x.story?.id, x.traffic);
    for (const p of day.picks ?? []) for (const src of p.sources || []) mark(byUrl.get(src.url), p.traffic);
    return out;
  }
  let HOT = new Map();
  const hotFor = (it) => (HOT.has(it.id) ? hotTag(hotLabel(HOT.get(it.id))) : null);

  // ---------- Cluster bar ----------

  function setReadout(latest, label) {
    const day = latest ? dayLabel(latest.edition) : '';
    document.title = label ? `${label} · Bike News` : `Bike News · ${day}`;
    document.getElementById('r-date').textContent = day.toUpperCase();
    const count = latest ? storiesOf(latest).length : 0;
    document.getElementById('r-count').replaceChildren(h('b', null, pad2(count)), ' Stories');
    const t = latest && ist(latest.published_at);
    document.getElementById('r-time').replaceChildren(h('span', { class: 'long' }, 'Updated '), h('b', null, t ? `${pad2(t.hh)}:${pad2(t.mm)}` : '--:--'));
    for (const a of document.querySelectorAll('.nav a')) {
      if (a.getAttribute('href') === sectionOf()) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  // ---------- Trend helpers ----------

  // Hot: 5000+ searches, a Breakout, or a rise of 300% or more in Google's own figures.
  const HOT_VOLUME = 5000;
  const HOT_RISE = 300;
  function isHot(value) {
    if (!value) return false;
    if (value === 'Breakout') return true;
    const n = Number(String(value).replace(/[^\d]/g, ''));
    return String(value).startsWith('+') ? n >= HOT_RISE : n >= HOT_VOLUME;
  }
  const flame = () => s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: 'M4 17l5-5 4 4 7-8M15 8h5v5' }));
  const hotTag = (label) => h('span', { class: 'hot' }, flame(), label);
  // "Trending · 5000+ searches" for a story, "Hot" for a search.
  const hotLabel = (value) => (value === 'Breakout' ? 'Trending · breakout' : String(value).startsWith('+') ? `Trending · ${value}` : `Trending · ${value} searches`);

  // Google's signal for a search: a volume ("5000+") or a rise over the last 24 hours ("+160%", "Breakout").
  function stat(value) {
    if (!value) return null;
    const rise = /^\+|^Breakout$/.test(value);
    return h('span', { class: `stat${rise ? ' stat--rise' : ''}${isHot(value) ? ' stat--hot' : ''}` },
      h('b', null, value), h('span', null, rise ? (value === 'Breakout' ? 'new today' : 'rise today') : 'searches'));
  }

  // ---------- Home ----------

  function sectionCard(section, href, title, count, countLabel, body, cta) {
    return h('article', { class: 'card section', 'data-section': section },
      stripes(),
      h('a', { class: 'section__head', href },
        h('h2', { class: 'section__title' }, title),
        h('span', { class: 'section__count' }, h('b', null, String(count)), ` ${countLabel}`)),
      h('div', { class: 'section__body' }, body),
      h('a', { class: 'section__more', href }, cta, h('span', { 'aria-hidden': 'true' }, ' →')));
  }

  function homeLaunches(eds) {
    const latest = eds[0];
    const stories = latest ? storiesOf(latest) : [];
    const order = ['launch', 'price', 'upcoming', 'ev', 'sales', 'policy', 'recall', 'racing', 'spy', 'rumour', 'other'];
    const top = latest?.lead ? [latest.lead] : [];
    const rest = stories.filter((x) => x !== latest?.lead).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    const list = [...top, ...rest].slice(0, 4);
    const total = eds.reduce((n, e) => n + storiesOf(e).length, 0);
    return sectionCard('launches', '#/launches', 'Feed', total, total === 1 ? 'story' : 'stories',
      list.length
        ? h('ol', { class: 'mini' }, list.map((it, i) => h('li', { class: i === 0 ? 'mini__item mini__item--lead' : 'mini__item' },
          h('a', { class: 'mini__link', href: itemHref('launches', it.id) },
            h('div', { class: 'mini__meta' }, hotFor(it), tag(it.type), it.kicker ? h('span', { class: 'kicker' }, it.kicker) : null),
            h('p', { class: 'mini__line' }, it.headline),
            i === 0 && it.figure ? h('p', { class: 'mini__figure' }, it.figure.value, h('span', null, ` ${it.figure.label}`)) : null))))
        : empty('No stories yet today.'),
      'The full feed');
  }

  function homeEvents(calendar, today, horizon) {
    const ahead = (calendar?.events ?? []).filter((ev) => ev.start_date <= horizon);
    const list = ahead.slice(0, 4);
    return sectionCard('events', '#/events', 'Events', ahead.length, 'in the next 3 months',
      list.length
        ? h('ol', { class: 'mini' }, list.map((ev) => {
          const d = parseYmd(ev.start_date);
          return h('li', { class: 'mini__item' },
            h('a', { class: 'mini__link mini__event', href: itemHref('events', ev.id) },
              h('div', { class: 'datebox', 'aria-hidden': 'true' }, h('span', { class: 'datebox__m' }, MONTHS[d.getUTCMonth()]), h('span', { class: 'datebox__d' }, String(d.getUTCDate()))),
              h('div', null,
                h('p', { class: 'mini__line' }, ev.name),
                h('p', { class: 'mini__sub' }, `${eventDates(ev)} · ${ev.city}`),
                h('p', { class: 'mini__when' }, relDay(ev.start_date, today)))));
        }))
        : empty('No upcoming events on the calendar yet.'),
      'Full calendar');
  }

  function homeTrending(trends) {
    const day = trends?.days?.[0];
    const picks = day?.picks ?? [];
    const searches = day?.searches ?? [];
    return sectionCard('trending', '#/trending', 'Trending now', picks.length || searches.length, picks.length ? (picks.length === 1 ? 'search explained' : 'searches explained') : 'bike searches',
      day && (picks.length || searches.length)
        ? h('div', { class: 'mini' },
          day.summary ? h('p', { class: 'mini__lede' }, day.summary.headline) : null,
          h('ol', { class: 'mini' }, (picks.length ? picks : searches).slice(0, 4).map((p) => h('li', { class: 'mini__item' },
            h('a', { class: 'mini__link mini__search', href: itemHref('trending', trendKey(p.term)) },
              stat(p.traffic),
              h('div', null, h('p', { class: 'mini__line' }, p.term), p.why ? h('p', { class: 'mini__sub' }, p.why) : null))))))
        : empty('Trends will appear after the next morning run.'),
      'What’s trending and why');
  }

  function homeGear(eds) {
    const items = gearItems(eds).map(({ a }) => a);
    return sectionCard('gear', '#/accessories', 'Aftermarket', items.length, items.length === 1 ? 'new product' : 'new products',
      items.length
        ? h('ol', { class: 'mini' }, items.slice(0, 4).map((a) => h('li', { class: 'mini__item' },
          h('a', { class: 'mini__link', href: itemHref('accessories', a.id) },
            h('div', { class: 'mini__meta' }, h('span', { class: 'kicker' }, a.brand), h('span', { class: 'mini__cat' }, GEAR_LABEL[a.category] || 'Accessory'), soonTag(a)),
            h('p', { class: 'mini__line' }, a.product),
            a.price ? h('p', { class: 'mini__price' }, a.price.value) : null))))
        : empty('No new accessories in the last few days.'),
      'All accessories');
  }

  // One line on what the day holds, counted from the data itself.
  function summaryLine(d) {
    const n = d.latest ? storiesOf(d.latest).length : 0;
    const ev = d.events?.events?.length ?? 0;
    const gear = (d.latest?.accessories ?? []).length;
    const parts = [`${n} ${n === 1 ? 'story' : 'stories'} today`];
    if (ev) parts.push(`${ev} ${ev === 1 ? 'event' : 'events'} coming up`);
    if (gear) parts.push(`${gear} new ${gear === 1 ? 'accessory' : 'accessories'}`);
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}.` : `${parts[0]}.`;
  }

  // ---------- Top news: a strip of today's stories that moves on every 10 seconds ----------

  const SLIDE_MS = 10000;
  let carouselStop = null;

  function latestCarousel(latest) {
    const stories = storiesOf(latest);
    const n = stories.length;
    if (!n) return null;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let i = 0, timer = null, paused = reduce, held = false;

    const slides = stories.map((it, k) => h('article', { class: 'slide', 'aria-roledescription': 'slide', 'aria-label': `${k + 1} of ${n}` },
      h('div', { class: 'meta' }, k === 0 && latest.lead ? h('span', { class: 'label label--lead' }, 'Lead') : null, hotFor(it), tag(it.type), updateTag(it), it.kicker ? h('span', { class: 'kicker' }, it.kicker) : null),
      // The headline's link covers the whole card; the source links sit above it.
      h('h2', { class: 'slide__headline' }, h('a', { class: 'slide__link', href: itemHref('launches', it.id) }, it.headline)),
      it.figure ? h('p', { class: 'slide__figure' }, it.figure.value, h('span', null, ` ${it.figure.label}`)) : null,
      it.text ? h('p', { class: 'slide__text' }, it.text) : null,
      h('p', { class: 'slide__src' }, h('span', { class: 'label' }, (it.sources || []).length > 1 ? `Reported by ${it.sources.length}` : 'Reported by'),
        (it.sources || []).slice(0, 3).map((x) => link(x, 'src')),
        (it.sources || []).length > 3 ? h('span', { class: 'more' }, `+${it.sources.length - 3} more`) : null,
        it.published_at ? h('time', { class: 'road__time', datetime: it.published_at }, stamp(it.published_at)) : null)));
    const track = h('div', { class: 'carousel__track', 'aria-live': 'off' }, slides);
    const segs = stories.map((_, k) => h('button', { class: 'seg', type: 'button', 'aria-label': `Story ${k + 1}: ${stories[k].headline}`, onclick: () => go(k, true) }, h('span')));
    const count = h('span', { class: 'carousel__count' });
    const pauseBtn = h('button', { class: 'cbtn', type: 'button', onclick: () => { paused = !paused; update(); } });
    const root = h('section', { class: 'carousel', 'aria-roledescription': 'carousel', 'aria-label': 'Top news' },
      h('div', { class: 'carousel__top' },
        h('h2', { class: 'label carousel__title' }, 'Top news'), count,
        h('div', { class: 'carousel__ctl' },
          h('button', { class: 'cbtn', type: 'button', 'aria-label': 'Previous story', onclick: () => go(i - 1, true) }, '‹'),
          pauseBtn,
          h('button', { class: 'cbtn', type: 'button', 'aria-label': 'Next story', onclick: () => go(i + 1, true) }, '›'))),
      h('div', { class: 'carousel__progress', style: `--n:${n}` }, segs),
      track);

    function fit() { track.style.height = `${slides[i].offsetHeight}px`; }
    function update() {
      count.textContent = `${pad2(i + 1)} / ${pad2(n)}`;
      segs.forEach((sg, k) => {
        sg.classList.toggle('is-done', k < i);
        sg.classList.remove('is-current');
        sg.setAttribute('aria-current', k === i ? 'true' : 'false');
      });
      void segs[i].offsetWidth; // restart the fill animation
      segs[i].classList.add('is-current');
      root.classList.toggle('is-paused', paused || held);
      pauseBtn.textContent = paused ? '▶' : 'Ⅱ';
      pauseBtn.setAttribute('aria-label', paused ? 'Play: move on every 10 seconds' : 'Pause');
      fit();
      clearTimeout(timer);
      if (!paused && !held && !document.hidden) timer = setTimeout(() => go(i + 1), SLIDE_MS);
    }
    function go(k, byHand) {
      i = (k + n) % n;
      track.scrollTo({ left: slides[i].offsetLeft - track.offsetLeft, behavior: reduce ? 'auto' : 'smooth' });
      if (byHand && reduce) paused = true;
      update();
    }
    // A swipe moves the strip by hand: follow it.
    let settle = null;
    track.addEventListener('scroll', () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        const k = Math.round(track.scrollLeft / track.clientWidth);
        if (k !== i && k >= 0 && k < n) { i = k; update(); }
      }, 120);
    }, { passive: true });
    const hold = (v) => () => { held = v; update(); };
    root.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') hold(true)(); });
    root.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hold(false)(); });
    root.addEventListener('focusin', hold(true));
    root.addEventListener('focusout', (e) => { if (!root.contains(e.relatedTarget)) hold(false)(); });
    window.addEventListener('resize', fit);
    document.addEventListener('visibilitychange', update);
    carouselStop = () => { clearTimeout(timer); window.removeEventListener('resize', fit); document.removeEventListener('visibilitychange', update); };
    requestAnimationFrame(update);
    return root;
  }

  async function renderHome(app, d) {
    const today = d.latest?.edition;
    put(app, 
      h('section', { class: 'today' },
        h('p', { class: 'today__date' }, today ? dayLabel(today) : ''),
        h('p', { class: 'today__title' }, summaryLine(d))),
      d.latest ? latestCarousel(d.latest) : null,
      h('div', { class: 'sections' },
        homeLaunches(d.eds), homeEvents(d.events, today, horizonOf(d, today)), homeTrending(d.trends), homeGear(d.eds)));
  }

  // ---------- Feed ----------

  function leadCard(it) {
    return h('article', { class: 'card card--lead', 'data-anchor': it.id }, stripes(),
      h('div', { class: 'lead' },
        h('header', { class: 'lead__head' },
          h('div', { class: 'meta' }, h('span', { class: 'label label--lead' }, 'Lead'), hotFor(it), tag(it.type), updateTag(it), it.kicker ? h('span', { class: 'kicker' }, it.kicker) : null, stampTag(it.published_at)),
          h('h2', { class: 'headline' }, it.headline)),
        it.figure ? h('div', { class: 'lead__plate' }, plate(it.figure)) : null,
        h('div', { class: 'lead__body' }, h('p', { class: 'text' }, it.text)),
        it.why ? h('aside', { class: 'lead__why why' }, h('h3', { class: 'label' }, 'Why it matters'), h('p', null, it.why)) : null,
        h('footer', { class: 'lead__foot' }, specs(it.specs), sources(it.sources))));
  }
  function subCard(it) {
    return h('article', { class: 'card card--sub', 'data-anchor': it.id }, stripes(),
      h('div', { class: 'meta' }, hotFor(it), tag(it.type), updateTag(it), it.kicker ? h('span', { class: 'kicker' }, it.kicker) : null, stampTag(it.published_at)),
      h('div', { class: 'sub__top' }, h('h3', { class: 'headline' }, it.headline), plate(it.figure)),
      it.text ? h('p', { class: 'text' }, it.text) : null,
      specs(it.specs), sources(it.sources));
  }
  function roadList(items) {
    return h('ul', { class: 'road__list' }, items.map((it) => h('li', { class: 'road__item', 'data-anchor': it.id },
      h('span', { class: 'dot', 'data-type': it.type, title: TYPE_LABEL[it.type] || '' }),
      h('p', { class: 'road__line' }, h('span', { class: 'sr' }, `${TYPE_LABEL[it.type] || 'News'}: `), it.headline,
        ['spy', 'rumour'].includes(it.type) ? tag(it.type) : null, updateTag(it), hotFor(it)),
      h('p', { class: 'road__src' }, (it.sources || []).map((x) => link(x)),
        it.published_at ? h('time', { class: 'road__time', datetime: it.published_at }, stamp(it.published_at)) : null))));
  }

  // Every story of the last 5 days in one list, newest first, under the day it was published. Today's lead and
  // sub-stories keep their larger cards; the rest are lines, grouped while they run together.
  function renderLaunches(app, d) {
    const today = d.latest?.edition;
    const active = LAUNCH_FILTERS.find(([label]) => label === (state.launchFilter || 'All')) ?? LAUNCH_FILTERS[0];
    const chips = h('div', { class: 'filters', role: 'group', 'aria-label': 'Show' }, LAUNCH_FILTERS.map(([label]) =>
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(label === active[0]), onclick: () => { state.launchFilter = label; route(); } }, label)));
    const seen = new Set();
    const all = [];
    for (const ed of d.eds) {
      const big = new Map([[ed.lead?.id, 'lead'], ...(ed.subs ?? []).map((x) => [x.id, 'sub'])]);
      for (const it of storiesOf(ed)) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        const at = it.published_at ?? `${ed.edition}T09:00:00+05:30`;
        all.push({ it: { ...it, published_at: at }, at, kind: ed.edition === today ? big.get(it.id) ?? 'line' : 'line' });
      }
    }
    const shown = all.filter((x) => !active[1] || active[1].includes(x.it.type)).sort((a, b) => byNewest(a.at, b.at));
    const days = new Map();
    for (const x of shown) {
      const k = ymdOf(ist(x.at));
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(x);
    }
    const sections = [...days].map(([ymd, list]) => {
      const blocks = [];
      let lines = [];
      const flush = () => { if (lines.length) blocks.push(h('div', { class: 'card road' }, roadList(lines))); lines = []; };
      for (const x of list) {
        if (x.kind === 'line') { lines.push(x.it); continue; }
        flush();
        blocks.push(x.kind === 'lead' ? leadCard(x.it) : subCard(x.it));
      }
      flush();
      return h('section', { class: 'day' },
        h('h2', { class: 'day-head' }, h('span', null, today ? relDay(ymd, today) : dayLabel(ymd)), h('span', { class: 'day-head__date' }, `${dayLabel(ymd)} · ${list.length} ${list.length === 1 ? 'story' : 'stories'}`)),
        blocks);
    });
    put(app, pageHead('launches', 'Feed', 'Every bike story from the last 5 days, newest first, with the date and time it was published.'), chips,
      sections.length ? sections : empty('Nothing of this kind in the last 5 days.'));
  }

  // ---------- Events ----------

  // A one-event calendar file the rider can add to their phone's calendar.
  function icsHref(ev) {
    const d = (ymd) => ymd.replaceAll('-', '');
    const end = ev.end_date || ev.start_date;
    const next = new Date(parseYmd(end).getTime() + 86400000).toISOString().slice(0, 10);
    const esc = (t) => String(t).replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\n/g, ' ');
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bike News//EN', 'BEGIN:VEVENT', `UID:${ev.id}@bikenews`,
      `DTSTART;VALUE=DATE:${d(ev.start_date)}`, `DTEND;VALUE=DATE:${d(next)}`, `SUMMARY:${esc(ev.name)}`, `LOCATION:${esc(ev.city)}`,
      `DESCRIPTION:${esc(ev.text)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    return `data:text/calendar;charset=utf-8,${encodeURIComponent(body)}`;
  }

  function eventCard(ev, today) {
    const d = parseYmd(ev.start_date);
    const n = daysBetween(today, ev.start_date);
    return h('article', { class: 'card event', 'data-anchor': ev.id },
      h('div', { class: 'datebox datebox--big', 'aria-hidden': 'true' },
        h('span', { class: 'datebox__m' }, MONTHS[d.getUTCMonth()]), h('span', { class: 'datebox__d' }, String(d.getUTCDate())), h('span', { class: 'datebox__w' }, DAYS[d.getUTCDay()])),
      h('div', { class: 'event__body' },
        h('div', { class: 'meta' }, h('span', { class: 'tag', 'data-kind': ev.kind }, EVENT_KIND[ev.kind] || 'Event'), ev.tag === 'update' ? updateTag(ev) : null,
          h('span', { class: 'event__when' }, n <= 0 ? 'On now' : n === 1 ? 'Tomorrow' : `In ${n} days`)),
        h('h3', { class: 'headline event__name' }, ev.name),
        h('p', { class: 'event__facts' }, h('b', null, eventDates(ev)), ` · ${ev.city}`, ev.organiser ? ` · by ${ev.organiser}` : ''),
        h('p', { class: 'text' }, ev.text),
        h('div', { class: 'event__actions' },
          ev.register ? h('a', { class: 'btn btn--solid', href: ev.register, target: '_blank', rel: 'noopener' }, 'Tickets and info') : null,
          h('a', { class: 'btn', href: icsHref(ev), download: `${ev.id}.ics` }, 'Add to calendar')),
        sources(ev.sources, 'Announced by')));
  }

  function renderEvents(app, d) {
    const today = d.latest?.edition ?? new Date().toISOString().slice(0, 10);
    const horizon = horizonOf(d, today);
    const all = (d.events?.events ?? []).filter((ev) => ev.start_date <= horizon);
    const kinds = ['All', ...new Set(all.map((e) => e.kind))];
    const active = kinds.includes(state.eventKind) ? state.eventKind : 'All';
    const chips = kinds.length > 2 ? h('div', { class: 'filters', role: 'group', 'aria-label': 'Show' }, kinds.map((k) =>
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(k === active), onclick: () => { state.eventKind = k; route(); } }, k === 'All' ? 'All' : `${EVENT_KIND[k] || k}s`))) : null;
    const shown = all.filter((e) => active === 'All' || e.kind === active);
    const months = new Map();
    for (const ev of shown) {
      const k = ev.start_date.slice(0, 7);
      if (!months.has(k)) months.set(k, []);
      months.get(k).push(ev);
    }
    put(app, pageHead('events', 'Events', 'Races, festivals, rides and meets in India in the next 3 months, so you can plan.'), chips,
      shown.length
        ? [...months].map(([k, list]) => h('section', { class: 'month' },
          h('h2', { class: 'day-head' }, h('span', null, `${MONTHS_LONG[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}`), h('span', { class: 'day-head__date' }, `${list.length} ${list.length === 1 ? 'event' : 'events'}`)),
          h('div', { class: 'events' }, list.map((ev) => eventCard(ev, today)))))
        : empty('No upcoming events on the calendar yet.'));
  }

  // ---------- Trending now ----------

  function renderTrending(app, d) {
    const day = d.trends?.days?.[0];
    if (!day) return put(app, pageHead('trending', 'Trending now'), empty('Trends will appear after the next morning run.'));
    const picks = day.picks ?? [];
    // The week's other bike searches: the ones already explained above are not repeated.
    const explained = new Set(picks.map((p) => p.term.toLowerCase()));
    const searches = (day.searches ?? []).filter((x) => !explained.has(x.term.toLowerCase()));
    const sinceLabel = (iso) => { const t = ist(iso); return t ? `since ${DAYS[t.wd]} ${t.d} ${MONTHS[t.m]}` : ''; };
    put(app,
      pageHead('trending', 'Trending now', 'What India is searching for about bikes, how much, and why.'),
      h('section', { class: 'card brief' }, stripes(),
        h('h2', { class: 'label', style: 'margin-bottom:10px' }, 'What’s trending and why'),
        day.summary ? h('p', { class: 'brief__headline' }, day.summary.headline) : null,
        day.summary ? h('p', { class: 'text brief__text' }, day.summary.text) : null,
        picks.length
          ? h('ol', { class: 'searches' }, picks.map((p) => h('li', { class: 'search', 'data-anchor': trendKey(p.term) },
            stat(p.traffic),
            h('div', { class: 'search__body' },
              h('p', { class: 'search__term' }, p.term, isHot(p.traffic) ? hotTag('Hot') : null),
              h('p', { class: 'text' }, p.why),
              sources(p.sources, 'Why')))))
          : empty('Nothing bike-related stood out in today’s searches.')),
      searches.length
        ? h('section', { class: 'card' }, stripes(),
          h('h2', { class: 'label', style: 'margin-bottom:4px' }, picks.length ? 'More bike searches this week' : 'Most searched bikes this week'),
          h('p', { class: 'note', style: 'margin:0 0 6px' }, 'Google Trends searches in India over the last 7 days that name a bike, brand or model.'),
          h('ol', { class: 'searches' }, searches.map((x) => h('li', { class: 'search', 'data-anchor': trendKey(x.term) },
            stat(x.traffic),
            h('div', { class: 'search__body' },
              h('p', { class: 'search__term' }, x.term, isHot(x.traffic) ? hotTag('Hot') : null),
              h('p', { class: 'search__meta' }, sinceLabel(x.started_at)),
              x.why ? h('p', { class: 'text' }, x.why) : null,
              x.story ? h('a', { class: 'search__story', href: x.story.id ? itemHref('launches', x.story.id) : '#/launches' }, h('span', { class: 'label' }, 'The story'), ' ', x.story.headline)
                : x.sources?.length ? sources(x.sources, 'Why') : null)))))
        : null,
      (day.rising ?? []).length || (day.top ?? []).length
        ? h('div', { class: 'two' },
          (day.rising ?? []).length
            ? h('section', { class: 'card' }, stripes(), h('h2', { class: 'label', style: 'margin-bottom:8px' }, 'Rising in the last 24 hours'),
              h('ul', { class: 'pills' }, day.rising.slice(0, 10).map((q) => h('li', null, h('span', null, q.q), h('b', { class: `rise${isHot(q.value) ? ' rise--hot' : ''}` }, q.value)))))
            : null,
          (day.top ?? []).length
            ? h('section', { class: 'card' }, stripes(), h('h2', { class: 'label', style: 'margin-bottom:8px' }, day.top_from ? `Most searched with “${day.top_from}”` : 'Most searched'),
              h('ol', { class: 'pills pills--ranked' }, day.top.slice(0, 10).map((q) => h('li', null, h('span', null, q.q)))))
            : null)
        : null,
      h('p', { class: 'note' }, 'Source: Google Trends, India. Volumes are Google’s own ranges; rises are Google’s growth figures for the last 24 hours.'));
  }

  // ---------- Aftermarket ----------

  function gearCard(a, edition, brands) {
    return h('article', { class: 'card gear', 'data-anchor': a.id }, stripes(),
      h('div', { class: 'meta' }, h('span', { class: 'tag', 'data-gear': a.category }, GEAR_LABEL[a.category] || 'Accessory'), soonTag(a), updateTag(a),
        h('span', { class: 'kicker' }, a.brand), a.published_at ? h('time', { class: 'gear__time', datetime: a.published_at }, stamp(a.published_at)) : null),
      h('div', { class: 'sub__top' }, h('h3', { class: 'headline' }, a.headline), plate(a.price)),
      h('p', { class: 'text' }, a.text),
      h('p', { class: 'gear__fits' }, h('span', { class: 'label' }, 'Fits'), ' ', a.for_bikes.join(', ')),
      sources(a.sources), makerLinks(brandOf(a.brand, brands)));
  }

  // The maker behind an accessory, from the brands we follow: its own site and Instagram.
  function brandOf(name, brands) {
    const want = String(name || '').toLowerCase();
    return (brands ?? []).find((b) => [b.name, ...(b.aka ?? [])].some((n) => {
      const have = n.toLowerCase();
      return want === have || want.startsWith(`${have} `);
    })) ?? null;
  }
  const igLink = (handle) => h('a', { class: 'src', href: `https://www.instagram.com/${handle}/`, target: '_blank', rel: 'noopener' }, `@${handle}`);
  function makerLinks(b) {
    if (!b) return null;
    return h('div', { class: 'sources maker' }, h('span', { class: 'label' }, 'From the maker'),
      link({ name: 'Website', url: b.site }, 'src'), b.instagram ? igLink(b.instagram) : null,
      b.india ? link({ name: b.india.name, url: b.india.site }, 'src') : null);
  }
  const MADE_IN = { India: 'Indian', Italy: 'Italian', France: 'French' };
  function brandList(brands) {
    if (!brands?.length) return null;
    const ordered = [...brands].sort((a, b) => (b.made_in === 'India') - (a.made_in === 'India') || a.name.localeCompare(b.name));
    return h('section', { class: 'brands', 'aria-labelledby': 'brands-title' },
      h('h2', { class: 'brands__title', id: 'brands-title' }, 'Brands we follow'),
      h('p', { class: 'brands__note' }, 'New products from their own stores and the press, every morning. Indian makers first.'),
      h('ul', { class: 'brands__list' }, ordered.map((b) => h('li', { class: 'brand-row', 'data-anchor': `brand-${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` },
        h('div', { class: 'brand-row__name' }, h('a', { href: b.site, target: '_blank', rel: 'noopener' }, b.name),
          h('span', { class: 'brand-row__made' }, MADE_IN[b.made_in] ?? b.made_in)),
        b.instagram ? igLink(b.instagram) : null))));
  }

  // Accessories of the kept editions, newest first, each once.
  function gearItems(eds, max = Infinity) {
    const seen = new Set();
    return eds.flatMap((ed) => (ed.accessories ?? []).map((a) => ({ a, ed: ed.edition })))
      .filter(({ a }) => !seen.has(a.id) && seen.add(a.id))
      .sort((x, y) => byNewest(x.a.published_at ?? `${x.ed}T09:00:00+05:30`, y.a.published_at ?? `${y.ed}T09:00:00+05:30`))
      .slice(0, max);
  }

  function renderGear(app, d) {
    const items = gearItems(d.eds, d.archive?.page?.accessories_shown ?? 15);
    const cats = ['All', ...new Set(items.map(({ a }) => a.category))];
    const active = cats.includes(state.gearCat) ? state.gearCat : 'All';
    const chips = cats.length > 2 ? h('div', { class: 'filters', role: 'group', 'aria-label': 'Show' }, cats.map((c) =>
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(c === active), onclick: () => { state.gearCat = c; route(); } }, c === 'All' ? 'All' : GEAR_LABEL[c] || c))) : null;
    const shown = items.filter(({ a }) => active === 'All' || a.category === active);
    put(app, pageHead('gear', 'Aftermarket', 'The latest helmets, riding gear, luggage and parts, newest first, and the bikes they fit.'), chips,
      shown.length ? h('div', { class: 'gears' }, shown.map(({ a, ed }) => gearCard(a, ed, d.brands))) : empty('No new accessories in the last 5 days.'),
      brandList(d.brands));
  }

  // ---------- Router ----------

  const state = {};
  const ROUTES = { '#/launches': ['Feed', renderLaunches], '#/events': ['Events', renderEvents], '#/trending': ['Trending now', renderTrending], '#/accessories': ['Aftermarket', renderGear] };
  let data = null;

  async function load() {
    const [latest, archive, events, trends, brandFile] = await Promise.all([
      optional(getJson('content/latest.json')), optional(getJson('content/archive.json')),
      optional(getJson('content/events.json')), optional(getJson('content/trends.json')), optional(getJson('content/brands.json')),
    ]);
    const brands = brandFile?.brands ?? [];
    const eds = await editions(archive, latest);
    if (latest && !eds.some((e) => e.edition === latest.edition)) eds.unshift(latest);
    return { latest, archive, events, trends, eds, brands };
  }

  // "#/launches/some-id" -> the section "#/launches" and the item "some-id".
  function sectionOf() { return `#/${(location.hash.split('/')[1] ?? '')}`; }
  function itemOf() {
    const rest = location.hash.split('/').slice(2).join('/');
    try { return rest ? decodeURIComponent(rest) : null; } catch { return rest || null; }
  }

  async function route() {
    const app = document.getElementById('paper');
    if (!data) data = await load();
    carouselStop?.();
    carouselStop = null;
    HOT = hotStories(data);
    const section = sectionOf();
    const item = itemOf();
    const [label, render] = ROUTES[section] ?? [null, renderHome];
    // Opening one item clears any filter that could hide it.
    if (item) { state.launchFilter = 'All'; state.eventKind = 'All'; state.gearCat = 'All'; }
    setReadout(data.latest, label);
    document.body.dataset.page = label ? section.slice(2) : 'home';
    await render(app, data);
    const target = item ? [...app.querySelectorAll('[data-anchor]')].find((el) => el.dataset.anchor === item) : null;
    if (!target) return window.scrollTo(0, 0);
    // Place the item just below the bar, and mark it for a moment so the eye finds it.
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.setAttribute('tabindex', '-1');
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
      target.focus({ preventScroll: true });
      target.classList.remove('is-target');
      void target.offsetWidth;
      target.classList.add('is-target');
    });
  }

  // Theme: light by default, dark when chosen; remembered on this device.
  const themeBtn = document.getElementById('theme');
  function applyTheme(dark) {
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    themeBtn?.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    document.getElementById('theme-color')?.setAttribute('content', dark ? '#141518' : '#F1F3F6');
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* private mode: not remembered */ }
  }
  themeBtn?.addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') !== 'dark'));
  themeBtn?.setAttribute('aria-label', document.documentElement.getAttribute('data-theme') === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');

  window.addEventListener('hashchange', () => { route(); });
  route();

  // As a home-screen app there is no reload button: fetch again when the app comes back after a while.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 10 * 60000) { cache.clear(); data = null; route(); }
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
