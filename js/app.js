/* Дашборд заказов: Vue 3 управляет состоянием и разметкой, d3.js рисует графики. */
(function () {
  const { createApp, ref, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;
  const D = window.DASH_DATA;

  // ---------- Форматирование (русская локаль) ----------
  const ru = d3.formatLocale({ decimal: ',', thousands: ' ', grouping: [3], currency: ['', ' ₽'] });
  const fInt = ru.format(',.0f');
  const fmtInt = v => fInt(v || 0);
  const fmtRub = v => fInt(Math.round(v || 0)) + ' ₽';
  const fmtRubShort = v => {
    if (Math.abs(v) >= 1e6) return ru.format(',.1f')(v / 1e6) + ' млн ₽';
    if (Math.abs(v) >= 1e4) return ru.format(',.1f')(v / 1e3) + ' тыс ₽';
    return fmtRub(v);
  };
  const fmtPct = v => (v == null || isNaN(v)) ? '—' : ru.format('.1f')(v * 100) + '%';
  const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const monthLong = m => cap(MONTHS[+m.slice(5, 7) - 1]) + ' ' + m.slice(0, 4);
  const monthShort = m => MONTHS_SHORT[+m.slice(5, 7) - 1] + ' ' + m.slice(2, 4);
  const fmtDateLong = s => +s.slice(8, 10) + ' ' + MONTHS_GEN[+s.slice(5, 7) - 1] + ' ' + s.slice(0, 4);
  const fmtDateShort = s => s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(2, 4);
  const addMonths = (m, k) => {
    const d = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 + k, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  };

  // ---------- Подготовка данных ----------
  const items = D.items;
  // если подключён js/images.js — берём картинки из него (не нужна папка img)
  if (window.ITEM_IMAGES) items.forEach((it, i) => { if (window.ITEM_IMAGES[i]) it.img = window.ITEM_IMAGES[i]; });
  const categories = D.categories;
  const SERVICES = categories.indexOf('Услуги Лавки');
  const allRows = D.rows.map(r => ({
    order: r[0], date: r[1], month: r[1].slice(0, 7), delivered: r[2] === 1,
    item: r[3], cat: items[r[3]].c, full: r[4], paid: r[5], qty: r[6],
    spend: r[5] * r[6], gross: r[4] * r[6], disc: (r[4] - r[5]) * r[6],
  }));
  const rows = allRows.filter(r => r.delivered);
  const cancelledOrders = new Set(allRows.filter(r => !r.delivered).map(r => r.order)).size;
  const lastMonth = d3.max(rows, r => r.month);
  const prevMonth = addMonths(lastMonth, -1);
  const months24 = d3.range(23, -1, -1).map(k => addMonths(lastMonth, -k));
  const firstDate = d3.min(rows, r => r.date);
  const lastDate = d3.max(rows, r => r.date);

  function aggregate(rs) {
    const orders = new Set(); let spend = 0, gross = 0, disc = 0, qty = 0;
    for (const r of rs) { orders.add(r.order); spend += r.spend; gross += r.gross; disc += r.disc; qty += r.qty; }
    return { orders: orders.size, spend, gross, disc, qty, discPct: gross ? disc / gross : null };
  }


  createApp({
    setup() {
      const selected = ref([]);          // индексы выбранных категорий
      const period = ref('all');         // период для анализа позиций/категорий
      const sortBy = ref('qty');
      const topN = ref(15);
      const periods = [
        { key: 'all', label: 'Всё время' },
        { key: '24', label: '24 мес' },
        { key: '12', label: '12 мес' },
      ];
      const trendEl = ref(null), itemsEl = ref(null), tipEl = ref(null);
      const sparkRefs = {}; // обычный объект: DOM-ссылки не должны быть реактивными
      const width = ref(1000);

      const toggleCat = i => {
        const s = selected.value.slice(); const k = s.indexOf(i);
        if (k >= 0) s.splice(k, 1); else s.push(i);
        selected.value = s.length === categories.length ? [] : s;
      };
      const clearCats = () => { selected.value = []; };
      const servicesSelected = computed(() => selected.value.includes(SERVICES));

      const catRows = computed(() => selected.value.length ? rows.filter(r => selected.value.includes(r.cat)) : rows);

      const totals = computed(() => {
        const a = aggregate(rows);
        return { ...a, itemsCount: new Set(rows.map(r => r.item)).size };
      });

      // ----- Помесячные метрики (24 мес) -----
      const monthly = computed(() => {
        const by = d3.group(catRows.value, r => r.month);
        return months24.map(m => ({ month: m, ...aggregate(by.get(m) || []) }));
      });

      const METRICS = [
        { key: 'orders', title: 'Количество заказов', colorVar: '--c-orders', fmt: fmtInt, kind: 'bar' },
        { key: 'spend', title: 'Сумма трат', colorVar: '--c-spend', fmt: fmtRub, kind: 'bar' },
        { key: 'discPct', title: 'Средняя скидка', colorVar: '--c-disc', fmt: fmtPct, kind: 'line' },
      ];

      const kpis = computed(() => {
        const ms = monthly.value;
        const cur = ms[ms.length - 1], prev = ms[ms.length - 2];
        const agg24 = aggregate(catRows.value.filter(r => r.month >= months24[0]));
        return METRICS.map(M => {
          const v = cur[M.key], p = prev[M.key];
          const vals = ms.map(m => m[M.key]).filter(x => x != null);
          const avg = d3.mean(vals);
          const rel = (a, b) => {
            if (a == null || b == null) return { txt: '—', cls: 'flat' };
            if (M.key === 'discPct') { // для доли — разница в п.п.
              const d = (a - b) * 100;
              return { txt: (d > 0 ? '+' : d < 0 ? '−' : '±') + ru.format('.1f')(Math.abs(d)) + ' п.п.', cls: Math.abs(d) < 0.05 ? 'flat' : d > 0 ? 'up' : 'down' };
            }
            if (!b) return { txt: '—', cls: 'flat' };
            const d = a / b - 1;
            return { txt: (d > 0 ? '+' : d < 0 ? '−' : '±') + ru.format('.0f')(Math.abs(d) * 100) + '%', cls: Math.abs(d) < 0.005 ? 'flat' : d > 0 ? 'up' : 'down' };
          };
          const mom = rel(v, p), va = rel(v, avg);
          let total24, avg24;
          if (M.key === 'orders') { total24 = fmtInt(agg24.orders); avg24 = ru.format('.1f')(avg); }
          else if (M.key === 'spend') { total24 = fmtRubShort(agg24.spend); avg24 = fmtRub(avg); }
          else { total24 = fmtPct(agg24.discPct) + ' · ' + fmtRubShort(agg24.disc); avg24 = fmtPct(avg); }
          return {
            key: M.key, title: M.title, color: `var(${M.colorVar})`,
            value: M.fmt(v), mom: mom.txt, momClass: mom.cls, vsAvg: va.txt, avgClass: va.cls, total24, avg24,
          };
        });
      });

      // ----- Позиции -----
      const periodRows = computed(() => {
        let rs = catRows.value;
        if (period.value !== 'all') {
          const from = addMonths(lastMonth, -(+period.value) + 1);
          rs = rs.filter(r => r.month >= from);
        }
        return rs;
      });
      const periodLabel = computed(() => period.value === 'all'
        ? `За всё время (${fmtDateShort(firstDate)} — ${fmtDateShort(lastDate)})`
        : `За последние ${period.value} мес (${monthShort(addMonths(lastMonth, -(+period.value) + 1))} — ${monthShort(lastMonth)})`);

      const itemStats = computed(() => {
        let rs = periodRows.value;
        if (!servicesSelected.value) rs = rs.filter(r => r.cat !== SERVICES);
        const g = d3.group(rs, r => r.item);
        const arr = [];
        for (const [item, list] of g) {
          const a = aggregate(list);
          arr.push({ item, ...a, list });
        }
        const key = sortBy.value === 'qty' ? 'qty' : 'spend';
        const other = key === 'qty' ? 'spend' : 'qty';
        arr.sort((x, y) => d3.descending(x[key], y[key]) || d3.descending(x[other], y[other]));
        return arr;
      });

      // ----- Категории -----
      const catStats = computed(() => {
        const rsAll = (() => {
          if (period.value === 'all') return rows;
          const from = addMonths(lastMonth, -(+period.value) + 1);
          return rows.filter(r => r.month >= from);
        })();
        const total = d3.sum(rsAll, r => r.spend);
        const byCat = d3.group(rsAll, r => r.cat);
        const sparkMonths = months24;
        const out = categories.map((name, idx) => {
          const list = byCat.get(idx) || [];
          const a = aggregate(list);
          const byItem = d3.rollups(list, v => d3.sum(v, r => r.spend), r => r.item)
            .sort((x, y) => d3.descending(x[1], y[1])).slice(0, 3).map(([item, s]) => ({ item, s }));
          const bm = d3.rollup(rows.filter(r => r.cat === idx), v => d3.sum(v, r => r.spend), r => r.month);
          const vals = sparkMonths.map(m => bm.get(m) || 0);
          const x = d3.scaleLinear().domain([0, vals.length - 1]).range([0, 120]);
          const y = d3.scaleLinear().domain([0, d3.max(vals) || 1]).range([27, 1]);
          const spark = d3.line().x((d, i) => x(i)).y(d => y(d)).curve(d3.curveMonotoneX)(vals);
          return {
            idx, name, ...a, share: total ? a.spend / total : 0,
            avgPrice: a.qty ? a.spend / a.qty : 0, top: byItem, spark,
          };
        });
        return out.sort((a, b) => d3.descending(a.spend, b.spend));
      });
      const maxCatSpend = computed(() => d3.max(catStats.value, c => c.spend) || 1);

      // ---------- Тултип ----------
      function showTip(html, ev) {
        const t = tipEl.value; if (!t) return;
        t.innerHTML = html; t.classList.add('show'); moveTip(ev);
      }
      function moveTip(ev) {
        const t = tipEl.value; if (!t) return;
        const pad = 16, r = t.getBoundingClientRect();
        let x = ev.clientX + pad, y = ev.clientY + pad;
        if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
        if (y + r.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - r.height - 8);
        if (x < 8) x = 8;
        t.style.left = x + 'px'; t.style.top = y + 'px';
      }
      function hideTip() { tipEl.value && tipEl.value.classList.remove('show'); }

      // ---------- Спарклайны KPI ----------
      function drawSparks() {
        const ms = monthly.value;
        METRICS.forEach(M => {
          const el = sparkRefs[M.key]; if (!el) return;
          const svg = d3.select(el); svg.selectAll('*').remove();
          const w = el.clientWidth || 300, h = 56;
          const vals = ms.map(m => m[M.key] ?? 0);
          const x = d3.scaleBand().domain(d3.range(vals.length)).range([0, w]).padding(0.25);
          const y = d3.scaleLinear().domain([0, d3.max(vals) || 1]).nice().range([h - 2, 4]);
          const color = `var(${M.colorVar})`;
          if (M.kind === 'bar') {
            svg.selectAll('rect').data(vals).join('rect')
              .attr('x', (d, i) => x(i)).attr('width', x.bandwidth())
              .attr('y', d => y(d)).attr('height', d => Math.max(0, h - 2 - y(d)))
              .attr('rx', 1.5).style('fill', color)
              .style('opacity', (d, i) => i === vals.length - 1 ? 1 : 0.35);
          } else {
            const line = d3.line().x((d, i) => x(i) + x.bandwidth() / 2).y(d => y(d)).curve(d3.curveMonotoneX);
            const area = d3.area().x((d, i) => x(i) + x.bandwidth() / 2).y0(h - 2).y1(d => y(d)).curve(d3.curveMonotoneX);
            svg.append('path').attr('d', area(vals)).style('fill', color).style('opacity', 0.12);
            svg.append('path').attr('d', line(vals)).style('fill', 'none').style('stroke', color).attr('stroke-width', 2);
            const li = vals.length - 1;
            svg.append('circle').attr('cx', x(li) + x.bandwidth() / 2).attr('cy', y(vals[li])).attr('r', 4)
              .style('fill', color).style('stroke', 'var(--surface)').attr('stroke-width', 2);
          }
          svg.append('line').attr('x1', 0).attr('x2', w).attr('y1', h - 2).attr('y2', h - 2).style('stroke', 'var(--grid)');
        });
      }

      // ---------- Динамика (3 панели, общий курсор) ----------
      function drawTrend() {
        const host = trendEl.value; if (!host) return;
        const ms = monthly.value;
        const W = host.clientWidth || 900;
        const narrow = W < 640;
        const m = { l: narrow ? 46 : 64, r: 12, t: 8, b: 26 };
        const panelH = narrow ? 110 : 130, gap = 34;
        const H = m.t + METRICS.length * (panelH + gap) - gap + m.b + 14;
        const iw = W - m.l - m.r;
        d3.select(host).selectAll('*').remove();
        const svg = d3.select(host).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H)
          .attr('role', 'img').attr('aria-label', 'Динамика количества заказов, трат и средней скидки за 24 месяца');
        const x = d3.scaleBand().domain(ms.map(d => d.month)).range([m.l, m.l + iw]).paddingInner(0.28).paddingOuter(0.1);
        const band = svg.append('rect').attr('class', 'hover-band').attr('y', m.t).attr('height', H - m.t - m.b + 4)
          .attr('width', x.step()).style('display', 'none');

        METRICS.forEach((M, pi) => {
          const top = m.t + 14 + pi * (panelH + gap);
          const g = svg.append('g');
          const vals = ms.map(d => d[M.key]);
          const maxV = d3.max(vals, v => v ?? 0) || 1;
          const y = d3.scaleLinear().domain([0, maxV]).nice(4).range([top + panelH, top]);
          const tickFmt = M.key === 'spend' ? (v => v >= 1000 ? ru.format(',.0f')(v / 1000) + 'k' : v)
            : M.key === 'discPct' ? (v => ru.format('.0f')(v * 100) + '%') : (v => v);
          g.append('text').attr('class', 'panel-title').attr('x', m.l).attr('y', top - 6).text(M.title);
          g.append('g').attr('class', 'grid').selectAll('line').data(y.ticks(4)).join('line')
            .attr('x1', m.l).attr('x2', m.l + iw).attr('y1', d => y(d)).attr('y2', d => y(d));
          g.append('g').attr('class', 'axis').attr('transform', `translate(${m.l - 6},0)`)
            .call(d3.axisLeft(y).ticks(4).tickFormat(tickFmt).tickSize(0));
          const color = `var(${M.colorVar})`;
          const isLast = d => d.month === lastMonth;
          if (M.kind === 'bar') {
            const topRounded = (x0, y0, w, h, r) => {
              r = Math.min(r, w / 2, h);
              if (h <= 0) return '';
              return `M${x0},${y0 + h}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + w - r}Q${x0 + w},${y0} ${x0 + w},${y0 + r}V${y0 + h}Z`;
            };
            g.selectAll('path.b').data(ms).join('path').attr('class', 'b')
              .attr('d', d => topRounded(x(d.month), y(d[M.key] || 0), x.bandwidth(), y(0) - y(d[M.key] || 0), 4))
              .style('fill', color)
              .style('opacity', d => isLast(d) ? 1 : 0.55);
          } else {
            const def = ms.filter(d => d[M.key] != null);
            const cx = d => x(d.month) + x.bandwidth() / 2;
            g.append('path').datum(def)
              .attr('d', d3.area().x(cx).y0(y(0)).y1(d => y(d[M.key])).curve(d3.curveMonotoneX))
              .style('fill', color).style('opacity', 0.1);
            g.append('path').datum(def)
              .attr('d', d3.line().x(cx).y(d => y(d[M.key])).curve(d3.curveMonotoneX))
              .style('fill', 'none').style('stroke', color).attr('stroke-width', 2);
            g.selectAll('circle').data(def).join('circle').attr('cx', cx).attr('cy', d => y(d[M.key]))
              .attr('r', d => isLast(d) ? 5 : 3).style('fill', color)
              .style('stroke', 'var(--surface)').attr('stroke-width', 2);
          }
          // среднее
          const avg = d3.mean(vals.filter(v => v != null));
          if (avg != null) {
            g.append('line').attr('class', 'avg-line').attr('x1', m.l).attr('x2', m.l + iw).attr('y1', y(avg)).attr('y2', y(avg));
            g.append('text').attr('class', 'avg-label').attr('x', m.l + 4).attr('y', y(avg) - 4)
              .text('среднее ' + (M.key === 'spend' ? fmtRub(avg) : M.key === 'discPct' ? fmtPct(avg) : ru.format('.1f')(avg)));
          }
          // подпись последнего значения
          const lv = ms[ms.length - 1][M.key];
          if (lv != null) {
            g.append('text').attr('class', 'bar-val').attr('x', x(lastMonth) + x.bandwidth() / 2)
              .attr('y', y(lv) - 8).attr('text-anchor', 'end')
              .attr('dx', x.bandwidth() / 2)
              .text(M.fmt(lv));
          }
        });

        // ось X
        const bottom = H - m.b;
        const every = narrow ? 4 : 2;
        svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${bottom - 6})`)
          .call(d3.axisBottom(x).tickSize(0).tickValues(ms.map(d => d.month).filter((d, i) => (ms.length - 1 - i) % every === 0))
            .tickFormat(monthShort));

        // интерактив
        svg.append('g').selectAll('rect').data(ms).join('rect')
          .attr('x', d => x(d.month) - x.step() * x.paddingInner() / 2).attr('width', x.step())
          .attr('y', m.t).attr('height', H - m.t - m.b).style('fill', 'transparent').style('cursor', 'crosshair')
          .on('mouseenter', (ev, d) => {
            band.style('display', null).attr('x', x(d.month) - x.step() * x.paddingInner() / 2);
            const row = (c, k, v) => `<div class="tt-row"><span class="k"><i style="background:var(${c})"></i>${k}</span><b>${v}</b></div>`;
            showTip(`<div class="tt-month">${monthLong(d.month)}</div>` +
              row('--c-orders', 'Заказов', fmtInt(d.orders)) +
              row('--c-spend', 'Траты', fmtRub(d.spend)) +
              row('--c-disc', 'Средняя скидка', fmtPct(d.discPct)) +
              `<div class="tt-row"><span class="k" style="padding-left:14px">Скидка в рублях</span><b>${fmtRub(d.disc)}</b></div>` +
              `<div class="tt-row"><span class="k" style="padding-left:14px">Средний чек</span><b>${d.orders ? fmtRub(d.spend / d.orders) : '—'}</b></div>`, ev);
          })
          .on('mousemove', moveTip)
          .on('mouseleave', () => { band.style('display', 'none'); hideTip(); });
      }

      // ---------- Позиции: двусторонний бар-чарт с картинками ----------
      function wrapName(name, maxChars) {
        const words = name.split(' '); const lines = [''];
        for (const w of words) {
          const cur = lines[lines.length - 1];
          if ((cur + ' ' + w).trim().length <= maxChars) lines[lines.length - 1] = (cur + ' ' + w).trim();
          else if (lines.length < 2) lines.push(w);
          else { lines[1] = lines[1] + ' ' + w; }
        }
        if (lines[1] && lines[1].length > maxChars) lines[1] = lines[1].slice(0, maxChars - 1).trim() + '…';
        return lines;
      }

      function priceTooltip(s) {
        const it = items[s.item];
        // покупки по датам: цена за штуку
        const purchases = d3.rollups(s.list, v => ({
          full: d3.max(v, r => r.full), paid: d3.sum(v, r => r.spend) / d3.sum(v, r => r.qty), qty: d3.sum(v, r => r.qty),
        }), r => r.date).map(([date, o]) => ({ date: new Date(date), ds: date, ...o })).sort((a, b) => a.date - b.date);
        const allP = rows.filter(r => r.item === s.item); // вся история цены (без учёта периода)
        const hist = d3.rollups(allP, v => ({
          full: d3.max(v, r => r.full), paid: d3.sum(v, r => r.spend) / d3.sum(v, r => r.qty),
        }), r => r.date).map(([date, o]) => ({ date: new Date(date), ds: date, ...o })).sort((a, b) => a.date - b.date);
        const first = hist[0], last = hist[hist.length - 1];
        const ch = first && first.full ? last.full / first.full - 1 : null;
        const chTxt = ch == null ? '' : (ch > 0 ? '+' : ch < 0 ? '−' : '±') + ru.format('.0f')(Math.abs(ch) * 100) + '% к первой покупке';
        const html = `
          <div class="tt-head"><img src="${it.img}" alt=""><div><div class="tt-title">${it.n}</div><div class="tt-cat">${categories[it.c]}</div></div></div>
          <div class="tt-grid">
            <span>Куплено</span><span>${fmtInt(s.qty)} шт. в ${fmtInt(s.orders)} заказ${plural(s.orders, 'е', 'ах', 'ах')}</span>
            <span>Потрачено</span><span>${fmtRub(s.spend)}</span>
            <span>Средняя цена</span><span>${fmtRub(s.spend / s.qty)}</span>
            <span>Сэкономлено</span><span>${fmtRub(s.disc)} (${fmtPct(s.discPct)})</span>
            <span>Первая / последняя</span><span>${fmtDateShort(purchases[0].ds)} / ${fmtDateShort(purchases[purchases.length - 1].ds)}</span>
          </div>
          <div class="tt-sec">
            <div class="tt-sec-title"><span>Динамика цены за шт.</span><span class="muted">${chTxt}</span></div>
            <svg class="tt-chart" width="300" height="110"></svg>
            <div class="tt-legend"><span><i style="background:var(--c-full);height:4px;opacity:.6"></i>без скидки</span><span><i style="background:var(--c-spend)"></i>заплачено</span></div>
          </div>`;
        return { html, hist };
      }
      function plural(n, one, few, many) {
        const n10 = n % 10, n100 = n % 100;
        if (n10 === 1 && n100 !== 11) return one;
        if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
        return many;
      }
      function drawPriceChart(hist) {
        const svg = d3.select(tipEl.value).select('svg.tt-chart'); if (svg.empty()) return;
        const W = 300, H = 110, m = { l: 40, r: 8, t: 8, b: 20 };
        const lo = d3.min(hist, d => Math.min(d.full, d.paid)), hi = d3.max(hist, d => Math.max(d.full, d.paid));
        const pad = Math.max(5, (hi - lo) * 0.15);
        const y = d3.scaleLinear().domain([Math.max(0, lo - pad), hi + pad]).nice(3).range([H - m.b, m.t]);
        let x;
        if (hist.length === 1) {
          const d0 = hist[0].date;
          x = d3.scaleTime().domain([d3.timeMonth.offset(d0, -1), d3.timeMonth.offset(d0, 1)]).range([m.l, W - m.r]);
        } else x = d3.scaleTime().domain(d3.extent(hist, d => d.date)).range([m.l, W - m.r]);
        svg.append('g').attr('class', 'grid').selectAll('line').data(y.ticks(3)).join('line')
          .attr('x1', m.l).attr('x2', W - m.r).attr('y1', d => y(d)).attr('y2', d => y(d));
        svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l - 4},0)`)
          .call(d3.axisLeft(y).ticks(3).tickSize(0).tickFormat(v => fInt(v) + ' ₽'));
        const span = x.domain()[1] - x.domain()[0];
        const fmtX = span > 400 * 864e5 ? d3.timeFormat('%Y') : (d => MONTHS_SHORT[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2));
        svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b + 4})`)
          .call(d3.axisBottom(x).ticks(4).tickSize(0).tickFormat(fmtX));
        const step = d3.line().x(d => x(d.date)).curve(d3.curveStepAfter);
        svg.append('path').datum(hist).attr('d', step.y(d => y(d.full)))
          .style('fill', 'none').style('stroke', 'var(--c-full)').attr('stroke-width', 4).style('opacity', 0.55);
        svg.append('path').datum(hist).attr('d', d3.line().x(d => x(d.date)).y(d => y(d.paid)).curve(d3.curveStepAfter))
          .style('fill', 'none').style('stroke', 'var(--c-spend)').attr('stroke-width', 2);
        svg.selectAll('circle').data(hist).join('circle').attr('cx', d => x(d.date)).attr('cy', d => y(d.paid))
          .attr('r', hist.length > 40 ? 2 : 3).style('fill', 'var(--c-spend)').style('stroke', 'var(--surface)').attr('stroke-width', 1);
      }

      function drawItems() {
        const host = itemsEl.value; if (!host) return;
        d3.select(host).selectAll('*').remove();
        const data = itemStats.value.slice(0, topN.value);
        if (!data.length) return;
        const W = host.clientWidth || 900;
        const narrow = W < 700;
        const rowH = narrow ? 50 : 46, headH = 26;
        const C = narrow ? Math.min(190, W * 0.46) : Math.min(330, W * 0.34); // центральная колонка
        const side = (W - C) / 2;
        const valPad = narrow ? 50 : 76;
        const H = headH + data.length * rowH + 4;
        const svg = d3.select(host).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H)
          .attr('role', 'img').attr('aria-label', 'Топ позиций: количество штук и траты');
        const xQ = d3.scaleLinear().domain([0, d3.max(data, d => d.qty)]).range([0, side - valPad]);
        const xS = d3.scaleLinear().domain([0, d3.max(data, d => d.spend)]).range([0, side - valPad]);
        const cx0 = side, cx1 = side + C;

        svg.append('text').attr('class', 'col-head').attr('x', cx0 - 8).attr('y', 14).attr('text-anchor', 'end')
          .text((sortBy.value === 'qty' ? '▼ ' : '') + 'Штук');
        svg.append('text').attr('class', 'col-head').attr('x', cx1 + 8).attr('y', 14)
          .text((sortBy.value === 'spend' ? '▼ ' : '') + 'Рублей');
        svg.append('text').attr('class', 'col-head').attr('x', cx0 + 8).attr('y', 14).text('Позиция');

        const g = svg.selectAll('g.item-row').data(data, d => d.item).join('g').attr('class', 'item-row')
          .attr('transform', (d, i) => `translate(0,${headH + i * rowH})`);
        g.append('rect').attr('class', 'hit').attr('x', 0).attr('width', W).attr('height', rowH - 2).attr('rx', 10);
        const barH = 14, by = (rowH - barH) / 2 - 1;
        // штуки (влево)
        g.append('rect').attr('x', d => cx0 - 6 - xQ(d.qty)).attr('y', by).attr('height', barH)
          .attr('width', d => Math.max(2, xQ(d.qty))).attr('rx', 4).style('fill', 'var(--c-orders)');
        g.append('text').attr('class', 'bar-val').attr('x', d => cx0 - 12 - xQ(d.qty)).attr('y', by + barH / 2 + 4)
          .attr('text-anchor', 'end').text(d => fmtInt(d.qty) + (narrow ? '' : ' шт.'));
        // рубли (вправо)
        g.append('rect').attr('x', cx1 + 6).attr('y', by).attr('height', barH)
          .attr('width', d => Math.max(2, xS(d.spend))).attr('rx', 4).style('fill', 'var(--c-spend)');
        g.append('text').attr('class', 'bar-val').attr('x', d => cx1 + 12 + xS(d.spend)).attr('y', by + barH / 2 + 4)
          .text(d => narrow ? fmtRubShort(d.spend).replace(' ₽', '') : fmtRub(d.spend));
        // картинка + название
        const imgS = rowH - 10;
        g.append('rect').attr('x', cx0 + 6).attr('y', 4).attr('width', imgS).attr('height', imgS).attr('rx', 8).style('fill', '#fff');
        g.append('image').attr('href', d => items[d.item].img).attr('x', cx0 + 6).attr('y', 4)
          .attr('width', imgS).attr('height', imgS).attr('preserveAspectRatio', 'xMidYMid meet')
          .style('clip-path', 'inset(0 round 8px)');
        const tx = cx0 + 6 + imgS + 8;
        const maxChars = Math.max(10, Math.floor((cx1 - tx - 10) / 6.9));
        g.each(function (d) {
          const sel = d3.select(this);
          const lines = wrapName(items[d.item].n, maxChars);
          const t = sel.append('text').attr('class', 'item-name').attr('x', tx).attr('y', lines.length > 1 ? rowH / 2 - 4 : rowH / 2 + 3);
          lines.forEach((l, i) => t.append('tspan').attr('x', tx).attr('dy', i ? 14 : 0).text(l));
        });
        g.append('title').text(d => items[d.item].n);
        g.style('cursor', 'default')
          .on('mouseenter', function (ev, d) {
            d3.select(this).classed('hover', true).select('title').text('');
            const { html, hist } = priceTooltip(d);
            showTip(html, ev); drawPriceChart(hist); moveTip(ev);
          })
          .on('mousemove', moveTip)
          .on('mouseleave', function (ev, d) {
            d3.select(this).classed('hover', false).select('title').text(items[d.item].n);
            hideTip();
          });
      }

      const redrawAll = () => { drawSparks(); drawTrend(); drawItems(); };
      watch([monthly], () => nextTick(() => { drawSparks(); drawTrend(); }));
      watch([itemStats, topN], () => nextTick(drawItems));

      let ro;
      onMounted(() => {
        nextTick(redrawAll);
        let raf;
        ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(redrawAll); });
        ro.observe(document.body);
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redrawAll);
      });
      onBeforeUnmount(() => ro && ro.disconnect());

      return {
        categories, items, selected, toggleCat, clearCats, servicesSelected,
        period, periods, sortBy, topN, periodLabel,
        totals, monthly, kpis, itemStats, catStats, maxCatSpend,
        trendEl, itemsEl, tipEl, sparkRefs,
        lastMonth, prevMonth, firstDate, lastDate, cancelledOrders,
        fmtInt, fmtRub, fmtPct, monthLong, monthShort, fmtDateLong,
      };
    },
  }).mount('#app');
})();
