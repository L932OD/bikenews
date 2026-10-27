// Bike Desk: reads content/latest.json (or a past edition with ?d=YYYY-MM-DD) and lays out the page.
(() => {
  'use strict';

  const TYPE_LABEL = {
    launch: 'Launch', price: 'Price', recall: 'Recall', sales: 'Sales', ev: 'EV', policy: 'Policy',
    upcoming: 'Upcoming', spy: 'Spy shot', rumour: 'Rumour', racing: 'Racing', other: 'News',
  };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Tiny element builder. Text always goes in as text, never as HTML.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  // Dates are shown in India time whatever the reader's clock says.
  function ist(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    const d = new Date(t + 330 * 60000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
  }
  function dayLabel(ymd) {
    const d = new Date(ymd + 'T00:00:00Z');
    return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  }
  function itemTime(iso, edition) {
    const t = ist(iso);
    if (!t) return '';
    const ymd = `${t.y}-${pad2(t.m + 1)}-${pad2(t.d)}`;
    return ymd === edition ? `${pad2(t.hh)}:${pad2(t.mm)}` : `${t.d} ${MONTHS[t.m]}`;
  }

  const link = (s, cls) => h('a', { class: cls, href: s.url, target: '_blank', rel: 'noopener' }, s.name);

  function tag(type) {
    return h('span', { class: 'tag', 'data-type': type }, TYPE_LABEL[type] || 'News');
  }
  function updateTag(it) {
    return it.tag === 'update' ? h('span', { class: 'tag tag--update' }, 'Update') : null;
  }

  function sources(list) {
    return h('div', { class: 'sources' }, h('span', { class: 'label' }, 'Read at'), (list || []).map((s) => link(s, 'src')));
  }

  function plate(fig) {
    if (!fig || !fig.value) return null;
    return h('div', { class: 'plate' },
      h('span', { class: 'plate__value' }, fig.value),
      fig.label ? h('span', { class: 'plate__label' }, fig.label) : null);
  }

  function specs(list) {
    if (!Array.isArray(list) || !list.length) return null;
    return h('dl', { class: 'specs' }, list.slice(0, 3).map(([k, v]) => h('div', { class: 'spec' }, h('dt', null, k), h('dd', null, v))));
  }

  function leadCard(it) {
    return h('article', { class: 'card card--lead', 'aria-labelledby': 'lead-h' },
      h('span', { class: 'stripes', 'aria-hidden': 'true' }),
      h('div', { class: 'lead' },
        h('header', { class: 'lead__head' },
          h('div', { class: 'meta' }, h('span', { class: 'label label--lead' }, 'Lead'), tag(it.type), updateTag(it), it.kicker ? h('span', { class: 'kicker' }, it.kicker) : null),
          h('h1', { class: 'headline', id: 'lead-h' }, it.headline)),
        it.figure ? h('div', { class: 'lead__plate' }, plate(it.figure)) : null,
        h('div', { class: 'lead__body' }, h('p', { class: 'text' }, it.text)),
        it.why ? h('aside', { class: 'lead__why why' }, h('h2', { class: 'label' }, 'Why it matters'), h('p', null, it.why)) : null,
        h('footer', { class: 'lead__foot' }, specs(it.specs), sources(it.sources))));
  }

  function subCard(it, i) {
    const id = `sub-h-${i}`;
    return h('article', { class: 'card card--sub', 'aria-labelledby': id },
      h('span', { class: 'stripes', 'aria-hidden': 'true' }),
      h('div', { class: 'meta' }, tag(it.type), updateTag(it), it.kicker ? h('span', { class: 'kicker' }, it.kicker) : null),
      h('div', { class: 'sub__top' }, h('h2', { class: 'headline', id }, it.headline), plate(it.figure)),
      it.text ? h('p', { class: 'text' }, it.text) : null,
      specs(it.specs),
      sources(it.sources));
  }

  function roadCard(items, edition) {
    return h('section', { class: 'card road', 'aria-labelledby': 'road-h' },
      h('span', { class: 'stripes', 'aria-hidden': 'true' }),
      h('h2', { class: 'label', id: 'road-h', style: 'margin-bottom:10px' }, 'Also on the road'),
      h('ul', { class: 'road__list' }, items.map((it) =>
        h('li', { class: 'road__item' },
          h('span', { class: 'dot', 'data-type': it.type, title: TYPE_LABEL[it.type] || '' }),
          h('p', { class: 'road__line' },
            h('span', { class: 'sr' }, `${TYPE_LABEL[it.type] || 'News'}: `),
            it.headline,
            ['spy', 'rumour'].includes(it.type) ? tag(it.type) : null,
            updateTag(it)),
          h('p', { class: 'road__src' },
            (it.sources || []).map((s) => link(s)),
            it.published_at ? h('span', { class: 'road__time' }, itemTime(it.published_at, edition)) : null)))));
  }

  // Three to five lit segments, by how hard the term is trending ("2000+", "20000+" ...).
  function revLevel(traffic) {
    const n = parseInt(String(traffic || '').replace(/[^\d]/g, ''), 10) || 0;
    return n >= 50000 ? 5 : n >= 5000 ? 4 : 3;
  }

  function radarCard(trends) {
    return h('section', { class: 'card radar', 'aria-labelledby': 'radar-h' },
      h('span', { class: 'stripes', 'aria-hidden': 'true' }),
      h('h2', { class: 'label', id: 'radar-h', style: 'margin-bottom:14px' }, 'On the radar'),
      h('ul', { class: 'radar__list' }, trends.map((t) => {
        const lit = revLevel(t.traffic);
        return h('li', { class: 'radar__item' },
          h('span', { class: 'revbar', role: 'img', 'aria-label': `Trending level ${lit} of 5` }, [1, 2, 3, 4, 5].map((i) => h('i', { class: i <= lit ? 'on' : null }))),
          h('p', { class: 'radar__term' }, t.term),
          h('p', { class: 'radar__why' }, t.why, (t.sources || []).slice(0, 2).map((s) => link(s))));
      })));
  }

  function render(ed) {
    const paper = document.getElementById('paper');
    const subs = ed.subs || [];
    const heads = ed.headlines || [];
    const trending = ed.trending || [];
    const count = (ed.lead ? 1 : 0) + subs.length + heads.length;

    const day = dayLabel(ed.edition);
    document.title = `Bike Desk · ${day}`;
    document.getElementById('r-date').textContent = day.toUpperCase();
    const rc = document.getElementById('r-count');
    rc.replaceChildren(h('b', null, pad2(count)), ' Stories');
    const t = ist(ed.published_at);
    const rt = document.getElementById('r-time');
    rt.replaceChildren(h('span', { class: 'long' }, 'Updated '), h('b', null, t ? `${pad2(t.hh)}:${pad2(t.mm)}` : '--:--'));

    const parts = [];
    if (ed.lead) parts.push(leadCard(ed.lead));
    if (subs.length) parts.push(h('div', { class: 'subs' }, subs.map(subCard)));
    if (heads.length) parts.push(roadCard(heads, ed.edition));
    if (trending.length) parts.push(radarCard(trending));
    paper.replaceChildren(...parts);
  }

  function renderChips(archive, current) {
    const list = (archive && archive.editions) || [];
    if (!list.length) return;
    const latest = list[0].edition;
    const chips = list.slice(0, 14).map((e) => {
      const href = e.edition === latest ? './' : `?d=${e.edition}`;
      return h('li', null, h('a', { href, 'aria-current': e.edition === current ? 'page' : null, title: e.lead || null }, dayLabel(e.edition)));
    });
    document.getElementById('chips').replaceChildren(...chips);
    document.getElementById('rides').hidden = false;
  }

  function fail(msg) {
    document.getElementById('paper').replaceChildren(
      h('p', { class: 'notice' }, msg, ' ', h('a', { href: './' }, "Today's edition")));
  }

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  }

  async function main() {
    const d = new URLSearchParams(location.search).get('d');
    const wanted = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
    const [ed, archive] = await Promise.all([
      getJson(wanted ? `content/editions/${wanted}.json` : 'content/latest.json').catch(() => null),
      getJson('content/archive.json').catch(() => null),
    ]);
    if (ed) render(ed);
    else fail(wanted ? `There is no edition for ${wanted}.` : 'The latest edition could not be loaded.');
    renderChips(archive, ed && ed.edition);
  }

  main();

  // As a home-screen app there is no reload button: fetch again when the app comes back after a while.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 10 * 60000) main();
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
