(function () {
  var DATA = window.REPORT_DATA;
  if (!DATA || !Array.isArray(DATA.products)) return;

  var DAY = 86400000;
  var THUMB_UP = '👍';

  function parseDate(s) {
    var p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function isoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* 交易状态按确认日期判定：确认日未到，或确认日净值尚未披露，均为「在途」，不计入持仓 */
  function txStatus(t) {
    var d = t && (t.confirmDate || t.applyDate);
    if (!d) return (t && t.status) || '已确认';
    if (d > isoDate(new Date())) return '在途';
    var p = findProductById(t.pid);
    if (p && p.latestDate && d > p.latestDate) return '在途';
    return '已确认';
  }

  function txPendingReason(t) {
    var d = t.confirmDate || t.applyDate;
    if (d > isoDate(new Date())) return '确认日期未到，净值未披露';
    var p = findProductById(t.pid);
    if (p && p.latestDate && d > p.latestDate) return '确认日净值尚未披露';
    return '';
  }

  /* 当前可卖份额：只认已确认的持仓，已清仓为 0 */
  function sellableShares(pid) {
    var map = HOLD_BY_PID || {};
    var h = map[pid];
    return h && h.shares > 0.000001 ? h.shares : 0;
  }

  /* 是否已有在途清仓单（确认日未到或净值未披露），避免重复清仓 */
  function hasPendingClear(pid) {
    var items = (window.TRANSACTIONS && window.TRANSACTIONS.items) || [];
    return items.some(function (t) {
      return t.pid === pid && t.type === '清仓' && txStatus(t) === '在途';
    });
  }

  /* 产品在指定日期披露的净值，未披露返回 null */
  function navOnDate(p, date) {
    if (!p || !p.dates || !date) return null;
    var i = p.dates.indexOf(date);
    return i === -1 ? null : p.nav[i];
  }

  /* 确认日按申购日 T+1 自动换算，遇周末/法定节假日顺延至下一交易日 */
  var MARKET_HOLIDAYS = [
    ['2025-01-01', '2025-01-01'],
    ['2025-01-28', '2025-02-04'],
    ['2025-04-04', '2025-04-06'],
    ['2025-05-01', '2025-05-05'],
    ['2025-05-31', '2025-06-02'],
    ['2025-10-01', '2025-10-08'],
    ['2026-01-01', '2026-01-03'],
    ['2026-02-15', '2026-02-22'],
    ['2026-04-04', '2026-04-06'],
    ['2026-05-01', '2026-05-05'],
    ['2026-06-19', '2026-06-21'],
    ['2026-09-25', '2026-09-27'],
    ['2026-10-01', '2026-10-07']
  ];

  /* 是否休市：周末或法定节假日 */
  function isMarketClosed(d) {
    var w = d.getDay();
    if (w === 0 || w === 6) return true;
    var s = isoDate(d);
    for (var i = 0; i < MARKET_HOLIDAYS.length; i++) {
      if (s >= MARKET_HOLIDAYS[i][0] && s <= MARKET_HOLIDAYS[i][1]) return true;
    }
    return false;
  }

  function nextWorkday(s) {
    var d = s ? parseDate(s) : null;
    if (!d || isNaN(d.getTime())) return '';
    do { d = new Date(d.getTime() + DAY); } while (isMarketClosed(d));
    return isoDate(d);
  }

  function dayDiff(a, b) {
    return Math.round((b.getTime() - a.getTime()) / DAY);
  }

  function mmdd(s) {
    return s ? s.slice(5) : '—';
  }

  function calc(p) {
    var n = p.dates.length;
    var latest = parseDate(p.dates[n - 1]);
    var incep = parseDate(p.dates[0]);
    var days = dayDiff(incep, latest);
    var sinceAnn = (p.nav[n - 1] / p.nav[0] - 1) * 365 / days * 100;
    var todayPer = (p.nav[n - 1] - p.nav[n - 2]) * 10000;
    var windows = [7, 14, 30, 60, 90, 365].map(function (w) {
      var target = latest.getTime() - w * DAY;
      var idx = -1;
      for (var i = 0; i < n; i++) {
        if (parseDate(p.dates[i]).getTime() <= target) idx = i;
      }
      var fallback = false;
      if (idx < 0) {
        if (w === 365) {
          idx = 0;
          fallback = true;
        } else {
          return { days: w, per: null, ann: null, span: null, start: null, fallback: false };
        }
      }
      var span = dayDiff(parseDate(p.dates[idx]), latest);
      var ret = p.nav[n - 1] / p.nav[idx] - 1;
      return {
        days: w,
        per: (p.nav[n - 1] - p.nav[idx]) * 10000 / span,
        ann: ret * 365 / span * 100,
        span: span,
        start: p.dates[idx],
        fallback: fallback
      };
    });
    return {
      latestDate: p.dates[n - 1],
      latestNav: p.nav[n - 1],
      inception: p.dates[0],
      days: days,
      listing: dayDiff(parseDate(p.inception || p.dates[0]), parseDate(DATA.asOf)),
      sinceAnn: sinceAnn,
      todayPer: todayPer,
      windows: windows
    };
  }

  var MODEL = [];
  var HOLDINGS = [];
  var HOLD_BY_PID = {};

  function computeModel(data) {
    MODEL = data.products.map(function (p) {
      p.dailyAnn = p.nav.map(function (v, i) {
        if (i === 0) return null;
        return (v / p.nav[i - 1] - 1) * 365 * 100;
      });
      return { product: p, m: calc(p) };
    });
    window.DASHBOARD_METRICS = MODEL;
  }
  computeModel(DATA);

  // 产品库扩容数据：8.1 后成立的产品（真实抓取，仅用于产品库展示）
  var LIB_MODEL = [];
  function computeLibrary() {
    var lib = (window.PRODUCT_LIBRARY && window.PRODUCT_LIBRARY.items) || [];
    LIB_MODEL = lib.filter(function (p) {
      /* 手工添加的产品可能只有一条净值，仅展示净值与净值日期，不计算区间指标 */
      if (!p || !p.nav || !p.nav.length) return false;
      return p.dates && p.dates.length > (p.manual ? 0 : 1);
    }).map(function (p) {
      p.dailyAnn = p.nav.map(function (v, i) {
        if (i === 0) return null;
        return (v / p.nav[i - 1] - 1) * 365 * 100;
      });
      if (p.manual && p.dates.length < 2) {
        var blank = { per: null, ann: null, fallback: false };
        return {
          product: p,
          m: {
            latestDate: p.latestDate, latestNav: p.latestNav,
            inception: p.inception || '', days: 0, listing: 0,
            sinceAnn: null, todayPer: null,
            windows: [blank, blank, blank, blank, blank, blank]
          }
        };
      }
      return { product: p, m: calc(p) };
    });
    window.DASHBOARD_LIBRARY = LIB_MODEL;
  }
  computeLibrary();

  /* 手工添加的产品（云端 MANUAL_PRODUCTS）合并进产品库，按 id 去重 */
  function manualToProduct(m) {
    if (!m || !m.id || !m.name) return null;
    var date = m.navDate || '';
    var nav = Number(m.nav);
    return {
      id: m.id,
      name: m.name,
      short: m.name,
      org: m.org || '',
      orgShort: orgShort(m.org || '') || '手工添加',
      regCode: m.regCode || '',
      risk: m.risk || '',
      saleChannel: m.saleChannel || '',
      inception: '',
      raiseStart: '', raiseEnd: '',
      dates: date ? [date] : [],
      nav: date && nav > 0 ? [nav] : [],
      per10k: [null],
      latestDate: date,
      latestNav: date && nav > 0 ? nav : null,
      manual: true
    };
  }

  function mergeManualProducts() {
    var list = window.MANUAL_PRODUCTS || [];
    window.PRODUCT_LIBRARY = window.PRODUCT_LIBRARY || { items: [] };
    var src = window.PRODUCT_LIBRARY.items || [];
    var hadManual = src.some(function (p) { return p.manual; });
    /* 每次以云端手工产品为准整体重建，新增/修改/删除都能同步 */
    var items = src.filter(function (p) { return !p.manual; });
    var seen = {};
    items.forEach(function (p) { seen[p.id] = 1; });
    list.forEach(function (m) {
      var p = manualToProduct(m);
      if (!p || seen[p.id]) return;
      seen[p.id] = 1;
      items.push(p);
    });
    window.PRODUCT_LIBRARY.items = items;
    if (hadManual || list.length) computeLibrary();
  }
  mergeManualProducts();

  // 产品数据源：与「产品库」一致（持仓产品 + 产品库扩容产品）
  function tradeProducts() {
    var out = DATA.products.slice();
    var seen = {};
    out.forEach(function (p) { seen[p.id] = 1; });
    LIB_MODEL.forEach(function (x) {
      var p = x.product;
      if (p && !seen[p.id]) { seen[p.id] = 1; out.push(p); }
    });
    return out;
  }

  function findProductById(pid) {
    return tradeProducts().filter(function (p) { return p.id === pid; })[0] || null;
  }

  // 产品库中已产生交易的产品，纳入统计与盈亏明细
  function libHeldProducts() {
    return LIB_MODEL.filter(function (x) { return !!HOLD_BY_PID[x.product.id]; })
      .map(function (x) { return x.product; });
  }

  // 交易底稿 → 持仓：申购累加份额，赎回/清仓按确认净值扣减，起息日 = 首次确认日
  function computeHoldings() {
    var tx = ((window.TRANSACTIONS && window.TRANSACTIONS.items) || []).slice();
    var asof = parseDate((window.TRANSACTIONS && window.TRANSACTIONS.asOf) || DATA.asOf);
    tx.sort(function (a, b) {
      return a.confirmDate < b.confirmDate ? -1 : a.confirmDate > b.confirmDate ? 1 : 0;
    });
    var acc = {};
    var todayStr = isoDate(new Date());
    tx.forEach(function (t) {
      /* 申购 / 赎回在途（确认日未到或净值未披露）不计入持仓；
         清仓按确认日生效：确认日已到即使当日净值尚未披露也按最新净值估算扣减，保证清仓当天可见 */
      if (txStatus(t) === '在途') {
        var cd = t.confirmDate || t.applyDate;
        if (!(t.type === '清仓' && cd && cd <= todayStr)) return;
      }
      var p = findProductById(t.pid);
      if (!p) return;
      var rec = acc[p.id];
      if (!rec) rec = acc[p.id] = { product: p, shares: 0, cost: 0, realized: 0, startDate: null, lastTx: t };
      var nav = Number(t.confirmNav) || 1;
      var sh = Number(t.shares);
      if (!(sh > 0)) sh = Number(t.amount) / nav;
      if (t.type === '赎回' || t.type === '清仓') {
        var sell = t.type === '清仓' ? rec.shares : Math.min(rec.shares, sh);
        /* 已无份额可卖（重复录入的清仓/赎回）直接忽略，避免覆盖真实清仓日 */
        if (!(sell > 0)) return;
        var avg = rec.shares > 0 ? rec.cost / rec.shares : nav;
        rec.realized += sell * (nav - avg);
        rec.cost -= sell * avg;
        rec.shares -= sell;
      } else {
        /* 清仓后重新申购：起息日按本次确认日重新计算 */
        if (!(rec.shares > 0.000001)) rec.startDate = t.confirmDate;
        rec.shares += sh;
        rec.cost += Number(t.amount) || sh * nav;
      }
      rec.lastTx = t;
    });

    HOLDINGS = [];
    HOLD_BY_PID = {};
    Object.keys(acc).forEach(function (pid) {
      var rec = acc[pid];
      var p = rec.product;
      var n = p.nav.length;
      var latestNav = p.nav[n - 1];
      var alive = rec.shares > 0.000001;
      var mv = rec.shares * latestNav;
      var profit = mv - rec.cost + rec.realized;
      var days = alive ? dayDiff(parseDate(rec.startDate), asof) : 0;
      var costNav = alive ? rec.cost / rec.shares : 0;
      var lastPer = p.per10k[n - 1];
      var h = {
        tx: rec.lastTx,
        product: p,
        shares: rec.shares,
        cost: rec.cost,
        costNav: costNav,
        latestNav: latestNav,
        latestDate: p.latestDate,
        startDate: rec.startDate,
        mv: mv,
        profit: profit,
        profitRate: rec.cost > 0 ? profit / rec.cost * 100 : null,
        ann: (days > 0 && rec.cost > 0) ? profit / rec.cost * 365 / days * 100 : null,
        days: days,
        income: (lastPer === null || lastPer === undefined || !alive) ? 0 : lastPer * rec.shares / 10000,
        cleared: !alive,
        realized: rec.realized
      };
      HOLDINGS.push(h);
      HOLD_BY_PID[p.id] = h;
    });
  }
  computeHoldings();
  window.DASHBOARD_HOLDINGS = HOLDINGS;

  // 当前选中的产品（顶部“覆盖产品”多选）
  /* 顶部产品多选的可选范围：与持仓联动，只列当前在持（有份额）的产品 */
  function pickableProducts() {
    var seen = {};
    var out = [];
    HOLDINGS.forEach(function (h) {
      var p = h && h.product;
      if (!p || !p.id || seen[p.id]) return;
      if (!(h.shares > 0.000001)) return;
      seen[p.id] = 1;
      out.push(p);
    });
    return out;
  }

  var selectedIds = pickableProducts().map(function (p) { return p.id; });
  var pickerKnown = {};
  var AGG = null;

  /* 持仓变化后同步可选范围：新增持仓自动勾选，已无持仓的从选中集合移除 */
  function syncPickerScope() {
    var ids = pickableProducts().map(function (p) { return p.id; });
    ids.forEach(function (id) {
      if (pickerKnown[id]) return;
      pickerKnown[id] = 1;
      if (selectedIds.indexOf(id) === -1) selectedIds.push(id);
    });
    Object.keys(pickerKnown).forEach(function (id) {
      if (ids.indexOf(id) === -1) delete pickerKnown[id];
    });
    selectedIds = selectedIds.filter(function (id) { return ids.indexOf(id) !== -1; });
  }

  function selectedProducts() {
    return pickableProducts().filter(function (p) { return selectedIds.indexOf(p.id) !== -1; });
  }

  // 合计口径：按持仓份额把万收折算为当日收益（元），年化按当日前一净值日市值折算
  function buildAggregate(products) {
    if (!products.length) return null;
    var sums = {}, prevs = {}, counts = {};
    products.forEach(function (p) {
      var h = HOLD_BY_PID[p.id];
      if (!h) return;
      var lastCum = 0;
      for (var i = 0; i < p.dates.length; i++) {
        var dt = p.dates[i];
        if (dt < h.startDate) continue;
        var cum = (p.nav[i] - h.costNav) * h.shares;
        var income = cum - lastCum;
        var prevMv = h.cost + lastCum;
        lastCum = cum;
        if (!(dt in sums)) { sums[dt] = 0; prevs[dt] = 0; counts[dt] = 0; }
        sums[dt] += income;
        prevs[dt] += prevMv;
        counts[dt] += 1;
      }
    });
    var dates = Object.keys(sums).sort();
    return {
      id: 'agg',
      name: products.length + ' 款产品合计',
      short: products.length + ' 款产品',
      multi: true,
      unit: 'yuan',
      dates: dates,
      per10k: dates.map(function (d) { return Math.round(sums[d] * 100) / 100; }),
      /* 未取整合计：月/年合计用原始值累加，仅在展示时取整，保证与逐日累加闭合 */
      raw: dates.map(function (d) { return sums[d]; }),
      counts: dates.map(function (d) { return counts[d]; }),
      ann: dates.map(function (d) {
        return prevs[d] > 0 ? Math.round(sums[d] / prevs[d] * 365 * 100 * 100) / 100 : null;
      }),
      prevMv: dates.map(function (d) { return prevs[d]; }),
      latestDate: dates[dates.length - 1],
      inception: dates[0]
    };
  }

  function refreshAggregate() {
    AGG = buildAggregate(selectedProducts());
  }
  refreshAggregate();

  function isMulti() { return selectedProducts().length > 1; }

  function colorBy(v) {
    if (v === null || v === undefined) return 'muted';
    if (v > 0) return 'up';
    if (v < 0) return 'down';
    return '';
  }

  function fmt2(v) {
    return v === null || v === undefined ? '—' : v.toFixed(2);
  }

  function fmtSigned(v) {
    if (v === null || v === undefined) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(2);
  }

  function fmtAnn(v) {
    return v === null || v === undefined ? '—' : v.toFixed(2) + '%';
  }

  function fmtNav(v) {
    return v === null || v === undefined ? '—' : v.toFixed(6);
  }

  // 评分参数：市场利率基准（%，一年期定存参考），可自行调整
  var MARKET_RATE = 1.5;
  var RATE_TOP = 4.0;       // 收益分满分对应的年化
  var SD_FLOOR = 2.5;       // 稳健分归零对应的日万收标准差

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function mean(arr) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function std(arr) {
    if (arr.length < 2) return 0;
    var m = mean(arr), s = 0;
    for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(s / arr.length);
  }

  function ratingOf(s) {
    if (s >= 7.5) return { text: '优秀', cls: 'sc-good' };
    if (s >= 6) return { text: '良好', cls: 'sc-good' };
    if (s >= 4) return { text: '一般', cls: 'sc-mid' };
    return { text: '偏弱', cls: 'sc-weak' };
  }

  // 1–10 综合评分：全部按近一个月（30 日）表现考核（公式与旧版一致）
  function scoreFor(m, p, peerAvg30) {
    var a30 = m.windows[2].ann;
    if (a30 === null) return null;

    var marketScore = clamp((a30 - MARKET_RATE) / (RATE_TOP - MARKET_RATE) * 10, 0, 10);
    var peerScore = clamp(((a30 - peerAvg30) + 1) / 2 * 10, 0, 10);

    var recent = p.per10k.slice(-30).filter(function (v) { return v !== null && v !== undefined; });
    var stabilityScore = clamp((1 - std(recent) / SD_FLOOR) * 10, 0, 10);
    var trendScore = 5;
    if (recent.length >= 10) {
      var half = Math.floor(recent.length / 2);
      var prevHalf = recent.slice(0, half);
      var lastHalf = recent.slice(recent.length - half);
      trendScore = clamp(5 + (mean(lastHalf) - mean(prevHalf)) * 2.5, 0, 10);
    }

    var total = marketScore * 0.5 + peerScore * 0.2 + stabilityScore * 0.2 + trendScore * 0.1;
    return {
      score: Math.round(clamp(total, 1, 10) * 10) / 10,
      marketScore: marketScore,
      peerScore: peerScore,
      stabilityScore: stabilityScore,
      trendScore: trendScore
    };
  }

  function activeModels() {
    return MODEL.concat(LIB_MODEL).filter(function (x) {
      return selectedIds.indexOf(x.product.id) !== -1;
    });
  }

  function peerAvg30Of(models) {
    return mean(models.map(function (x) { return x.m.windows[2].ann; }).filter(function (v) { return v !== null; }));
  }

  function scoreCell(row, cls, rowspan) {
    var rs = rowspan ? ' rowspan="' + rowspan + '"' : '';
    if (!row.score) {
      var held = row.item && HOLD_BY_PID[row.item.product.id];
      var sub = held ? (held.cleared ? '已清仓' : '新持仓') : '新品';
      return '<td' + rs + ' class="c st sc-none score-col"><b>—</b><i>' + sub + '</i></td>';
    }
    var rating = ratingOf(row.score.score);
    var sc = row.score;
    var lv = sc.score >= 7 ? 'sc-good' : (sc.score >= 5 ? 'sc-mid' : 'sc-weak');
    var tip = '市场利率 ' + MARKET_RATE.toFixed(1) + '% · 收益 ' + sc.marketScore.toFixed(1) +
      ' / 同类 ' + sc.peerScore.toFixed(1) + ' / 稳健 ' + sc.stabilityScore.toFixed(1) +
      ' / 趋势 ' + sc.trendScore.toFixed(1);
    return '<td' + rs + ' class="' + (cls || 'c') + ' st score-col ' + lv + '" title="' + tip + '"><b>' +
      sc.score.toFixed(1) + '</b><i>' + rating.text + '</i></td>';
  }

  /* ---------------- 顶部指标卡 ---------------- */
  function fmtMoney(v) {
    if (v === null || v === undefined) return '—';
    return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function holdingsOf(models) {
    return models.map(function (x) { return HOLD_BY_PID[x.product.id]; }).filter(Boolean);
  }

  function maxLatestDate() {
    var d = '';
    DATA.products.forEach(function (p) {
      if (p.latestDate && p.latestDate > d) d = p.latestDate;
    });
    return d || DATA.asOf;
  }

  function renderMetrics() {
    var models = activeModels();
    var hs = holdingsOf(models);

    var today = 0, todayCnt = 0, perSum = 0, perCnt = 0;
    hs.forEach(function (h) {
      var p = h.product;
      if (h.income !== null) { today += h.income; todayCnt += 1; }
      /* 今日平均万收只统计在持产品，已清仓产品不进分子也不进分母 */
      if (h.cleared) return;
      perSum += p.per10k[p.per10k.length - 1] || 0;
      perCnt += 1;
    });
    var avg = perCnt ? perSum / perCnt : null;

    var ym = DATA.asOf.slice(0, 7);
    var month = 0, mCnt = 0, mPerSum = 0;
    if (AGG) {
      AGG.dates.forEach(function (d, i) {
        if (d.indexOf(ym) !== 0) return;
        var v = AGG.raw ? AGG.raw[i] : AGG.per10k[i];
        if (v === null || v === undefined) return;
        month += v;
      });
    }
    hs.forEach(function (h) {
      var p = h.product;
      for (var i = 0; i < p.dates.length; i++) {
        if (p.dates[i].indexOf(ym) !== 0) continue;
        var v = p.per10k[i];
        if (v === null || v === undefined) continue;
        mPerSum += v;
        mCnt += 1;
      }
    });

    var cost = 0, profit = 0, mv = 0;
    hs.forEach(function (h) { cost += h.cost; profit += h.profit; mv += h.mv; });

    // 较上月：以上月最后一个净值日的持仓市值对比
    var d = parseDate(DATA.asOf);
    var pm = new Date(d.getFullYear(), d.getMonth(), 0);
    var prevPrefix = pm.getFullYear() + '-' + String(pm.getMonth() + 1).padStart(2, '0') + '-';
    var prevMv = 0, prevHas = false;
    hs.forEach(function (h) {
      var p = h.product, idx = -1;
      for (var i = 0; i < p.dates.length; i++) if (p.dates[i].indexOf(prevPrefix) === 0) idx = i;
      if (idx >= 0) { prevMv += p.nav[idx] * h.shares; prevHas = true; }
    });
    var mom = prevHas && prevMv > 0 ? (mv - prevMv) / prevMv * 100 : null;

    // 较上月收益：本月累计收益 − 上月同期（1 日至今月同日）累计收益
    var todayDay = Number(DATA.asOf.slice(8, 10));
    var prevYmPrefix = prevPrefix.slice(0, 7);
    var prevSum = 0, prevCnt = 0;
    if (AGG) {
      AGG.dates.forEach(function (dd, i) {
        if (dd.indexOf(prevYmPrefix) !== 0 || Number(dd.slice(8, 10)) > todayDay) return;
        var v = AGG.raw ? AGG.raw[i] : AGG.per10k[i];
        if (v === null || v === undefined) return;
        prevSum += v;
        prevCnt += 1;
      });
    }
    var momProfit = prevCnt ? month - prevSum : null;

    var el = document.getElementById('metric-today');
    if (el) {
      el.innerHTML = todayCnt ? fmtSigned(today) + '<em>元</em>' : '—';
      el.className = 'v ' + colorBy(todayCnt ? today : null);
    }
    el = document.getElementById('metric-avg');
    if (el) el.textContent = fmt2(avg);

    el = document.getElementById('metric-month');
    if (el) {
      el.innerHTML = mCnt ? fmtSigned(month) + '<em>元</em>' : '—';
      el.className = 'v ' + colorBy(mCnt ? month : null);
    }
    el = document.getElementById('metric-month-avg');
    if (el) el.textContent = fmt2(mCnt ? mPerSum / mCnt : null);

    el = document.getElementById('metric-profit');
    if (el) {
      el.innerHTML = hs.length ? fmtSigned(profit) + '<em>元</em>' : '—';
      el.className = 'v ' + colorBy(hs.length ? profit : null);
    }
    el = document.getElementById('metric-momprofit');
    if (el) {
      el.textContent = momProfit === null ? '—' : (momProfit > 0 ? '+' : '') + momProfit.toFixed(2);
      el.className = 'ink ' + colorBy(momProfit);
    }
    el = document.getElementById('metric-value');
    if (el) el.innerHTML = hs.length ? fmtMoney(mv) + '<em>元</em>' : '—';
    el = document.getElementById('metric-mom');
    if (el) {
      el.textContent = mom === null ? '—' : (mom > 0 ? '+' : '') + mom.toFixed(2) + '%';
      el.className = 'ink ' + colorBy(mom);
    }

    var heroAsOf = document.getElementById('hero-asof');
    if (heroAsOf) heroAsOf.textContent = maxLatestDate();
    var heroReport = document.getElementById('hero-report');
    if (heroReport) heroReport.textContent = DATA.fetchedAt || DATA.asOf;
  }

  /* ---------------- 模块 01：盈亏明细 ---------------- */
  var profitState = { key: 'today', dir: 'desc' };
  var holdMetric = 'both';
  var sumState = { key: 'mv', dir: 'desc' };
  var sumSorters = {
    name: function (h) { return h.product.short || h.product.name; },
    navdate: function (h) { return h.latestDate || ''; },
    nav: function (h) { return h.latestNav; },
    shares: function (h) { return h.shares; },
    mv: function (h) { return h.mv; },
    profit: function (h) { return h.profit; },
    ann: function (h) { return h.ann; },
    days: function (h) { return h.days; }
  };
  var WINDOW_SORT = { w7: 0, w14: 1, w30: 2, w60: 3, w90: 4, w365: 5 };

  function profitSortValue(row, key) {
    var m = row.item.m;
    var h = HOLD_BY_PID[row.item.product.id];
    if (key === 'name') return row.item.product.short || row.item.product.name;
    if (key === 'navdate') return m.latestDate;
    if (key === 'today') return m.todayPer;
    if (key === 'income') return h ? h.income : null;
    if (key === 'profit') return h ? h.profit : null;
    if (key === 'holdann') return h ? h.ann : null;
    if (key === 'value') return h ? h.mv : null;
    if (key === 'holddays') return h ? h.days : null;
    if (key === 'score') return row.score ? row.score.score : null;
    if (key in WINDOW_SORT) return m.windows[WINDOW_SORT[key]].per;
    return null;
  }

  function renderProfitTable() {
    var tbody = document.getElementById('hold-body');
    if (!tbody) return;

    var models = activeModels().filter(function (x) { return !!HOLD_BY_PID[x.product.id]; });
    var peerAvg30 = peerAvg30Of(models);
    var rows = models.map(function (item) {
      return { item: item, score: scoreFor(item.m, item.product, peerAvg30) };
    });

    if (profitState.key) {
      rows.sort(function (a, b) {
        var av = profitSortValue(a, profitState.key);
        var bv = profitSortValue(b, profitState.key);
        var dir = profitState.dir === 'asc' ? 1 : -1;
        if (profitState.key === 'name' || profitState.key === 'navdate') {
          return String(av).localeCompare(String(bv), 'zh-Hans-CN') * dir;
        }
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av - bv) * dir;
      });
    }

    var maxV = null, minV = null;
    rows.forEach(function (row) {
      var v = row.item.m.todayPer;
      if (v === null || v === undefined) return;
      if (maxV === null || v > maxV) maxV = v;
      if (minV === null || v < minV) minV = v;
    });

    var html = '';
    rows.forEach(function (row, i) {
      var p = row.item.product;
      var m = row.item.m;
      var h = HOLD_BY_PID[p.id];

      var badge = '';
      var tv = m.todayPer;
      if (tv !== null && tv !== undefined && maxV !== minV) {
        if (Math.abs(tv - maxV) < 1e-9) badge = '<span class="thumb-under" title="今日万收最高">' + THUMB_UP + '</span>';
      }

      var dual = holdMetric === 'both';
      var rs = dual ? ' rowspan="2"' : '';
      var lbl = holdMetric === 'ann' ? '年化' : '日均万收';
      html += '<tr class="ma' + (dual ? ' dual' : '') + '">';
      html += '<td class="c num"' + rs + '>' + (i + 1) + '</td>';
      html += '<td' + rs + '><div class="pname"><a class="plink" href="javascript:void(0)" data-goto-trade="' + p.id + '" title="查看「' + p.name + '」的交易记录">' + (p.short || p.name) + '</a>' + badge + '</div></td>';
      html += '<td class="c num"' + rs + '>' + mmdd(m.latestDate) + '</td>';
      html += '<td class="r num today-col ' + colorBy(tv) + '"' + rs + '>' + fmtSigned(tv) + '</td>';
      html += '<td class="r num income-col ' + colorBy(h ? h.income : null) + '"' + rs + '>' + fmtSigned(h ? h.income : null) + '</td>';
      html += '<td class="r num ' + colorBy(h ? h.profit : null) + '"' + rs + ' title="' +
        (h ? '市值 ' + fmtMoney(h.mv) + ' − 成本 ' + fmtMoney(h.cost) : '暂无持仓') + '">' + fmtSigned(h ? h.profit : null) + '</td>';
      html += '<td class="r num ' + colorBy(h ? h.ann : null) + '"' + rs + '>' + fmtAnn(h ? h.ann : null) + '</td>';
      html += '<td class="r num"' + rs + '>' + (h ? fmtMoney(h.mv) : '—') + '</td>';
      html += '<td class="c num dcell"' + rs + '>' + (h ? '<span class="days">' + h.days + '</span><i class="dunit">天</i>' : '—') + '</td>';
      html += '<td class="c mlabel">' + lbl + '</td>';

      var perCells = '';
      var annCells = '';
      m.windows.forEach(function (w) {
        var mark = w.fallback ? '<sup class="dag">†</sup>' : '';
        var perTip = w.per === null ? '历史区间不足'
          : w.per.toFixed(4) + ' 元 / 万份（' + w.start + ' 至 ' + m.latestDate + '，' + w.span + ' 天）' +
            (w.fallback ? '；成立不足 1 年，按成立以来计算' : '');
        var annTip = w.ann === null ? '历史区间不足'
          : w.ann.toFixed(4) + '%（' + w.start + ' 至 ' + m.latestDate + '，按 ' + w.span + ' 天年化）' +
            (w.fallback ? '；成立不足 1 年，按成立以来计算' : '');
        perCells += '<td class="c num pwin" title="' + perTip + '">' + fmt2(w.per) + mark + '</td>';
        annCells += '<td class="c num awin" title="' + annTip + '">' + fmtAnn(w.ann) + mark + '</td>';
      });
      html += holdMetric === 'ann' ? annCells : perCells;

      html += scoreCell(row, 'c', dual ? 2 : 0);
      html += '</tr>';

      if (dual) html += '<tr class="mb"><td class="c mlabel">年化</td>' + annCells + '</tr>';
    });

    tbody.innerHTML = html || '<tr><td colspan="17" class="c muted" style="padding:28px">未选择产品，请在顶部「覆盖产品」中选择</td></tr>';

    var ths = document.querySelectorAll('#hold-table thead th[data-sort]');
    Array.prototype.forEach.call(ths, function (th) {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.getAttribute('data-sort') === profitState.key) {
        th.classList.add(profitState.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      }
    });

    renderMetrics();
  }

  function bindProfitSort() {
    var ths = document.querySelectorAll('#hold-table thead th[data-sort]');
    Array.prototype.forEach.call(ths, function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (profitState.key === key) {
          profitState.dir = profitState.dir === 'asc' ? 'desc' : 'asc';
        } else {
          profitState.key = key;
          profitState.dir = 'desc';
        }
        renderProfitTable();
      });
    });
  }

  // 盈亏明细「数据」列下拉筛选：全部（万收+年化）/ 仅万收 / 仅年化
  function bindDataFilter() {
    var sel = document.getElementById('hold-data-sel');
    var tbl = document.getElementById('hold-table');
    if (!sel || !tbl) return;

    function apply() {
      var v = sel.value;
      holdMetric = (v === 'per10k' || v === 'ann') ? v : 'both';
      tbl.classList.toggle('only-ann', holdMetric === 'ann');
      tbl.classList.toggle('only-p10k', holdMetric === 'per10k');
    }

    sel.addEventListener('change', function () {
      apply();
      renderProfitTable();
    });
    apply();
  }

  /* ---------------- 模块 02：盈亏日历 ---------------- */
  var calState = { y: 0, m: 0, mode: 'month' };

  function perMapOf(p) {
    var map = {};
    for (var i = 0; i < p.dates.length; i++) {
      if (p.per10k[i] !== null) map[p.dates[i]] = p.per10k[i];
    }
    return map;
  }

  /* 合计用：取未取整的原始万收（单产品无 raw 时退回 per10k） */
  function rawMapOf(p) {
    var map = {};
    var arr = p.raw || p.per10k;
    for (var i = 0; i < p.dates.length; i++) {
      if (arr[i] !== null && arr[i] !== undefined) map[p.dates[i]] = arr[i];
    }
    return map;
  }

  function annMapOf(p) {
    var map = {};
    var arr = p.multi ? p.ann : p.dailyAnn;
    if (!arr) return map;
    for (var i = 0; i < p.dates.length; i++) {
      if (arr[i] !== null && arr[i] !== undefined) map[p.dates[i]] = arr[i];
    }
    return map;
  }

  function monthStats(p, perMap, annMap, y, m) {
    var prefix = y + '-' + String(m + 1).padStart(2, '0') + '-';
    var sum = 0, cnt = 0, pos = 0, neg = 0, flat = 0, annSum = 0, annCnt = 0;
    p.dates.forEach(function (dt) {
      if (dt.indexOf(prefix) !== 0) return;
      var v = perMap[dt];
      if (v === undefined) return;
      sum += v;
      cnt += 1;
      if (v > 0.005) pos += 1;
      else if (v < -0.005) neg += 1;
      else flat += 1;
      if (annMap[dt] !== undefined) { annSum += annMap[dt]; annCnt += 1; }
    });
    return {
      sum: sum,
      avg: cnt ? sum / cnt : null,
      cnt: cnt,
      pos: pos,
      neg: neg,
      flat: flat,
      ann: annCnt ? annSum / annCnt : null
    };
  }

  function rateLevel(v) {
    if (v === null || v === undefined) return 'lv1';
    if (v < 2.5) return 'lv1';
    if (v < 3.0) return 'lv2';
    if (v < 3.5) return 'lv3';
    if (v < 4.0) return 'lv4';
    return 'lv5';
  }

  function yearsOf(p) {
    var out = [];
    p.dates.forEach(function (dt) {
      var y = +dt.slice(0, 4);
      if (out.indexOf(y) === -1) out.push(y);
    });
    return out.sort(function (a, b) { return a - b; });
  }

  function monthsOf(p, y) {
    var out = [];
    p.dates.forEach(function (dt) {
      if (+dt.slice(0, 4) !== y) return;
      var m = +dt.slice(5, 7) - 1;
      if (out.indexOf(m) === -1) out.push(m);
    });
    return out.sort(function (a, b) { return a - b; });
  }

  function allMonths(p) {
    var out = [];
    p.dates.forEach(function (dt) {
      var key = dt.slice(0, 7);
      if (out.indexOf(key) === -1) out.push(key);
    });
    return out.sort();
  }

  function resetCalendarMonth() {
    var latest = AGG ? AGG.latestDate : DATA.asOf;
    var d = parseDate(latest);
    calState.y = d.getFullYear();
    calState.m = d.getMonth();
  }

  function renderCalendar() {
    var wrap = document.getElementById('cal');
    if (!wrap) return;
    var yv = document.getElementById('year-view');
    var mv = document.getElementById('month-view');
    var mwrap = document.getElementById('cal-month-wrap');
    /* 月度收益与年度收益同级常显：年度表固定在月度表下方 */
    if (yv) yv.hidden = false;
    if (mv) mv.hidden = false;
    if (mwrap) mwrap.style.display = '';
    renderYearView();
    var p = AGG;
    if (!p || !p.dates.length) {
      wrap.innerHTML = '';
      var sumEl = document.getElementById('cal-summary');
      if (sumEl) sumEl.innerHTML = '<span class="lead">当月收益<b>—</b><i>元</i></span>';
      return;
    }

    var years = yearsOf(p);
    if (years.indexOf(calState.y) === -1) calState.y = years[years.length - 1];
    var months = monthsOf(p, calState.y);
    if (months.indexOf(calState.m) === -1) calState.m = months[months.length - 1];

    var perMap = perMapOf(p);
    var annMap = annMapOf(p);
    /* 月度合计改用未取整的原始万收累加，避免逐日四舍五入后求和产生 0.01~0.02 元偏差 */
    var sumMap = rawMapOf(p);

    // 年 / 月下拉
    var ySel = document.getElementById('cal-year-sel');
    if (ySel) {
      ySel.innerHTML = years.map(function (y) {
        return '<option value="' + y + '">' + y + ' 年</option>';
      }).join('');
      ySel.value = String(calState.y);
    }
    var mSel = document.getElementById('cal-month-sel');
    if (mSel) {
      mSel.innerHTML = months.map(function (m) {
        return '<option value="' + m + '">' + (m + 1) + ' 月</option>';
      }).join('');
      mSel.value = String(calState.m);
    }

    var yLabel = document.getElementById('year-label');
    if (yLabel) yLabel.textContent = calState.y + ' 年 · 月度收益';
    var rangeHint = document.getElementById('cal-range-hint');
    if (rangeHint) rangeHint.textContent = '数据区间 ' + p.dates[0] + ' ~ ' + p.dates[p.dates.length - 1];

    // 左侧月度收益表
    var list = document.getElementById('month-list');
    if (list) {
      var monthRows = months.map(function (m) {
        return { m: m, st: monthStats(p, sumMap, annMap, calState.y, m) };
      });
      var bestAnn = null;
      monthRows.forEach(function (r) {
        if (r.st.ann !== null && (bestAnn === null || r.st.ann > bestAnn)) bestAnn = r.st.ann;
      });
      var html = '<div class="month-row mhead"><span>月份</span><span>收益</span><span>日均万收</span><span>正收益</span><span>回撤</span><span>挂0</span><span>年化</span></div>';
      html += '<div class="month-rows">';
      monthRows.slice().reverse().forEach(function (r) {
        var st = r.st;
        var thumb = (bestAnn !== null && st.ann !== null && Math.abs(st.ann - bestAnn) < 1e-9)
          ? '<span class="thumb">' + THUMB_UP + '</span>' : '';
        html += '<div class="month-item' + (r.m === calState.m ? ' on' : '') + '" data-month="' + r.m + '">' +
          '<span class="m">' + (r.m + 1) + '月</span>' +
          '<span class="v ' + colorBy(st.sum) + '">' + fmtSigned(st.sum) + '</span>' +
          '<span class="d">' + fmtSigned(st.avg) + '</span>' +
          '<span class="d">' + st.pos + '</span>' +
          '<span class="d">' + st.neg + '</span>' +
          '<span class="d">' + st.flat + '</span>' +
          '<span class="rate-cell ' + rateLevel(st.ann) + '">' + fmtAnn(st.ann) + thumb + '</span>' +
          '</div>';
      });
      html += '</div>';
      list.innerHTML = html;
    }

    // 右侧日历
    var first = new Date(calState.y, calState.m, 1);
    var lastDay = new Date(calState.y, calState.m + 1, 0).getDate();
    var offset = (first.getDay() + 6) % 7;
    var prefix = calState.y + '-' + String(calState.m + 1).padStart(2, '0') + '-';

    var defined = [];
    for (var d = 1; d <= lastDay; d++) {
      var vv = perMap[prefix + String(d).padStart(2, '0')];
      if (vv !== undefined) defined.push(vv);
    }
    var maxV = defined.length ? Math.max.apply(null, defined) : null;

    var cells = ['一', '二', '三', '四', '五', '六', '日'].map(function (w) {
      return '<div class="wd">' + w + '</div>';
    });
    for (var b = 0; b < offset; b++) cells.push('<div class="cell empty"></div>');

    var pos = 0, neg = 0, flat = 0, sum = 0;
    var compact = (window.innerWidth || 1200) < 480;
    for (var d2 = 1; d2 <= lastDay; d2++) {
      var ds = prefix + String(d2).padStart(2, '0');
      var v = perMap[ds];
      var a = annMap[ds];
      if (v === undefined) {
        cells.push('<div class="cell nodata"><div class="d">' + d2 + '</div><div class="v">—</div><div class="a">—</div></div>');
        continue;
      }
      sum += v;
      if (v > 0.005) pos += 1; else if (v < -0.005) neg += 1; else flat += 1;
      var best = (maxV !== null && Math.abs(v - maxV) < 1e-9);
      // 手机端格子窄，两位小数会被截断，绝对值≥10 时收一位
      var txt = (compact && Math.abs(v) >= 10) ? (v > 0 ? '+' : '') + v.toFixed(1) : fmtSigned(v);
      cells.push('<div class="cell' + (best ? ' best' : '') + '">' +
        '<div class="d">' + d2 + (best ? '<span class="thumb">' + THUMB_UP + '</span>' : '') + '</div>' +
        '<div class="vrow"><span class="v ' + colorBy(v) + '">' + txt + '</span></div>' +
        '<div class="a">' + fmtAnn(a) + '</div></div>');
    }
    wrap.innerHTML = cells.join('');

    var sub = document.getElementById('cal-sub');
    if (sub) sub.textContent = calState.y + ' 年 ' + (calState.m + 1) + ' 月 · 每日收益';

    var summary = document.getElementById('cal-summary');
    if (summary) {
      summary.innerHTML =
        '<span class="lead">当月收益<b class="' + colorBy(sum) + '">' + fmtSigned(sum) + '</b><i>元</i></span>' +
        '<span class="st">正收益<b>' + pos + '</b><i>天</i></span>' +
        '<span class="st">回撤<b>' + neg + '</b><i>天</i></span>' +
        '<span class="st">挂0<b>' + flat + '</b><i>天</i></span>';
    }

    updateCalArrows();
  }

  function rateLv(v) {
    if (v === null || v === undefined) return 'lv1';
    if (v >= 4.5) return 'lv5';
    if (v >= 3.8) return 'lv4';
    if (v >= 3.2) return 'lv3';
    if (v >= 2.6) return 'lv2';
    return 'lv1';
  }

  function renderYearView() {
    var tbody = document.getElementById('year-body');
    if (!tbody) return;
    if (!AGG || !AGG.dates.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="c muted" style="padding:28px">暂无收益数据</td></tr>';
      return;
    }
    var map = {};
    AGG.dates.forEach(function (d, i) {
      var y = d.slice(0, 4);
      var v = AGG.raw ? AGG.raw[i] : AGG.per10k[i];
      if (v === null || v === undefined) return;
      if (!map[y]) map[y] = { sum: 0, cnt: 0, pos: 0, neg: 0, prev: 0 };
      map[y].sum += v;
      map[y].cnt += 1;
      if (v > 0.005) map[y].pos += 1;
      else if (v < -0.005) map[y].neg += 1;
      map[y].prev += (AGG.prevMv && AGG.prevMv[i]) || 0;
    });
    var years = Object.keys(map).sort().reverse();
    var latestYear = years[0];
    tbody.innerHTML = years.map(function (y) {
      var s = map[y];
      var ann = s.prev > 0 ? s.sum / s.prev * 365 * 100 : null;
      return '<tr data-year="' + y + '" class="' + (y === latestYear ? 'on' : '') + '">' +
        '<td class="ym">' + y + '</td>' +
        '<td class="r num ' + colorBy(s.sum) + '">' + (s.sum > 0 ? '+' : '') + fmtMoney(s.sum) + '</td>' +
        '<td class="r num cnt">' + (s.cnt ? (s.sum / s.cnt > 0 ? '+' : '') + (s.sum / s.cnt).toFixed(2) : '—') + '</td>' +
        '<td class="num cnt">' + s.pos + '</td>' +
        '<td class="num cnt">' + s.neg + '</td>' +
        '<td></td>' +
        '<td><div class="rate-cell ' + rateLv(ann) + '">' + (ann === null ? '—' : ann.toFixed(2) + '%') + '</div></td>' +
        '</tr>';
    }).join('');
  }

  function updateCalArrows() {
    var prev = document.getElementById('cal-prev');
    var next = document.getElementById('cal-next');
    var yPrev = document.getElementById('cal-year-prev');
    var yNext = document.getElementById('cal-year-next');
    if (!AGG) return;
    var all = allMonths(AGG);
    var cur = calState.y + '-' + String(calState.m + 1).padStart(2, '0');
    var idx = all.indexOf(cur);
    if (prev) prev.disabled = idx <= 0;
    if (next) next.disabled = idx === -1 || idx >= all.length - 1;
    var years = yearsOf(AGG);
    if (yPrev) yPrev.disabled = calState.y <= years[0];
    if (yNext) yNext.disabled = calState.y >= years[years.length - 1];
  }

  function stepMonth(delta) {
    if (!AGG) return;
    var all = allMonths(AGG);
    var cur = calState.y + '-' + String(calState.m + 1).padStart(2, '0');
    var idx = all.indexOf(cur) + delta;
    if (idx < 0 || idx >= all.length) return;
    var parts = all[idx].split('-');
    calState.y = +parts[0];
    calState.m = +parts[1] - 1;
    renderCalendar();
  }

  function stepYear(delta) {
    if (!AGG) return;
    var years = yearsOf(AGG);
    var idx = years.indexOf(calState.y) + delta;
    if (idx < 0 || idx >= years.length) return;
    calState.y = years[idx];
    var months = monthsOf(AGG, calState.y);
    calState.m = months[months.length - 1];
    renderCalendar();
  }

  function bindCalendar() {
    var ySel = document.getElementById('cal-year-sel');
    if (ySel) ySel.addEventListener('change', function () {
      calState.y = +ySel.value;
      var months = monthsOf(AGG, calState.y);
      calState.m = months.length ? months[months.length - 1] : calState.m;
      renderCalendar();
    });

    var mSel = document.getElementById('cal-month-sel');
    if (mSel) mSel.addEventListener('change', function () {
      calState.m = +mSel.value;
      renderCalendar();
    });

    var list = document.getElementById('month-list');
    if (list) list.addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('.month-item') : null;
      if (!item) return;
      calState.m = +item.dataset.month;
      renderCalendar();
    });

    var prev = document.getElementById('cal-prev');
    if (prev) prev.addEventListener('click', function () { stepMonth(-1); });
    var next = document.getElementById('cal-next');
    if (next) next.addEventListener('click', function () { stepMonth(1); });
    var yPrev = document.getElementById('cal-year-prev');
    if (yPrev) yPrev.addEventListener('click', function () { stepYear(-1); });
    var yNext = document.getElementById('cal-year-next');
    if (yNext) yNext.addEventListener('click', function () { stepYear(1); });
  }

  /* ---------------- 模块 03：盈亏趋势 ---------------- */
  var trendState = { range: 30 };
  var trendChart = null;

  function trendStart(p, range) {
    var n = p.dates.length;
    var latest = parseDate(p.dates[n - 1]);
    var cutoff = latest.getTime() - range * DAY;
    var start = 0;
    for (var i = 0; i < n; i++) {
      if (parseDate(p.dates[i]).getTime() <= cutoff) start = i;
      else break;
    }
    return start;
  }

  function bindTrend() {
    var ranges = document.querySelectorAll('#range-tabs button');
    Array.prototype.forEach.call(ranges, function (btn) {
      btn.addEventListener('click', function () {
        trendState.range = +btn.getAttribute('data-range');
        Array.prototype.forEach.call(ranges, function (b) { b.classList.toggle('on', b === btn); });
        renderTrend();
      });
    });
  }

  function renderTrend() {
    var el = document.getElementById('chart');
    if (!el) return;
    if (!trendChart) trendChart = echarts.init(el, null, { renderer: 'svg' });
    if (!AGG) {
      trendChart.clear();
      var emptySub = document.getElementById('trend-sub');
      if (emptySub) emptySub.textContent = '未选择产品，暂无趋势数据';
      return;
    }
    var p = AGG;
    var start = trendStart(p, trendState.range);
    var dates = p.dates.slice(start);
    var series = p.per10k.slice(start);
    var annSeries = p.ann.slice(start);
    var counts = p.counts.slice(start);
    var firstDate = dates[0];
    var lastDate = dates[dates.length - 1];
    var lastIdx = dates.length - 1;
    var nonNull = series.filter(function (v) { return v !== null && v !== undefined; });
    var sum = 0;
    for (var i = 0; i < nonNull.length; i++) sum += nonNull[i];
    var avg = nonNull.length ? sum / nonNull.length : 0;
    var minV = nonNull.length ? Math.min(0, Math.min.apply(null, nonNull)) : 0;
    var maxV = nonNull.length ? Math.max(0, Math.max.apply(null, nonNull)) : 0;
    var maxIdx = -1, minIdx = -1;
    for (var k = 0; k < series.length; k++) {
      if (series[k] === null || series[k] === undefined) continue;
      if (maxIdx === -1 || series[k] > series[maxIdx]) maxIdx = k;
      if (minIdx === -1 || series[k] < series[minIdx]) minIdx = k;
    }
    function niceStep(raw) {
      if (!(raw > 0)) return 1;
      var pow = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
      var n = raw / pow;
      var m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
      return m * pow;
    }
    var yStep = niceStep((Math.max(0, maxV * 1.15) - Math.min(0, minV * 1.15)) / 8);
    var yMin = Math.floor(Math.min(0, minV * 1.15) / yStep) * yStep;
    var yMax = Math.ceil(Math.max(0, maxV * 1.15) / yStep) * yStep;
    if (yMin === yMax) { yMin -= yStep; yMax += yStep; }

    var sub = document.getElementById('trend-sub');
    if (sub) {
      var baseMv = (AGG.prevMv && AGG.prevMv[start]) || 0;
      var spanDays = Math.max(1, Math.round((parseDate(lastDate) - parseDate(firstDate)) / DAY));
      var rangeAnn = baseMv > 0 ? sum / baseMv * 365 / spanDays * 100 : null;
      sub.innerHTML = '区间日均收益 <b class="' + colorBy(avg) + '">' +
        (avg >= 0 ? '+' : '') + avg.toFixed(2) + ' 元</b>' +
        '<span class="sep">·</span>区间持仓年化 <b class="' + colorBy(rangeAnn) + '">' +
        (rangeAnn === null ? '—' : (rangeAnn >= 0 ? '+' : '') + rangeAnn.toFixed(2) + '%') + '</b>';
    }

    // 刻度：按数据点等分（首点与末点必显），整体均匀分布
    var narrow = (window.innerWidth || 1200) < 480;
    var tickCount = Math.min(narrow ? 4 : 7, Math.max(1, dates.length - 1));
    var tickSet = {};
    for (var tk = 0; tk <= tickCount; tk++) {
      tickSet[Math.round(tk * (dates.length - 1) / tickCount)] = 1;
    }
    function axisInterval(index) {
      return !!tickSet[index];
    }

    var rule = '#eef2f5';
    var muted = '#8b98a2';
    var lineColor = '#5b94a6';

    // 三个标注点：最高 / 最低 / 最新；收益在上、年化在下，负值统一绿色
    function trendMark(idx, baseColor, preferBelow) {
      var v = series[idx];
      if (idx < 0 || v === null || v === undefined) return null;
      var a = annSeries[idx];
      var c = v < 0 ? '#1e8449' : baseColor;
      var top = (v > 0 ? '+' : '') + v.toFixed(2);
      var bottom = (a === null || a === undefined) ? '—' : (a > 0 ? '+' : '') + a.toFixed(2) + '%';
      // 标注避让：贴近坐标轴时改放点正上方，贴近顶部时改放点下方，避免压住趋势线与横轴
      var yr = (v - yMin) / ((yMax - yMin) || 1);
      var below = !!preferBelow;
      if (below && yr < 0.3) below = false;
      if (!below && yr > 0.82) below = true;
      var dx = idx === lastIdx ? -16 : (idx === 0 ? 14 : 0);
      return {
        coord: [dates[idx], v],
        symbol: 'circle',
        symbolSize: 6,
        itemStyle: { color: c },
        label: {
          show: true,
          position: below ? 'bottom' : 'top',
          offset: [dx, below ? 8 : -8],
          formatter: '{v|' + top + '}\n{a|' + bottom + '}',
          backgroundColor: 'transparent',
          padding: [1, 3],
          borderRadius: 3,
          rich: {
            v: { fontSize: 11.5, fontWeight: 700, color: c, lineHeight: 15, align: 'center', verticalAlign: below ? 'top' : 'bottom' },
            a: { fontSize: 11.5, fontWeight: 400, color: c, lineHeight: 13, align: 'center', verticalAlign: below ? 'top' : 'bottom' }
          }
        }
      };
    }
    var markIdx = [];
    if (maxIdx >= 0 && maxIdx !== lastIdx) markIdx.push([maxIdx, '#b8860b', false]);
    if (minIdx >= 0 && minIdx !== lastIdx && minIdx !== maxIdx) markIdx.push([minIdx, '#1e8449', true]);
    markIdx.push([lastIdx, '#c0392b', false]);
    var trendMarks = markIdx.map(function (m) { return trendMark(m[0], m[1], m[2]); }).filter(Boolean);

    trendChart.setOption({
      animation: false,
      grid: { left: 14, right: 38, top: 42, bottom: 26, containLabel: true },
      tooltip: {
        trigger: 'axis',
        appendToBody: true,
        backgroundColor: '#fff',
        borderColor: '#dfe5ea',
        textStyle: { color: '#172530', fontSize: 12 },
        formatter: function (params) {
          var idx = params[0].dataIndex;
          var v = series[idx];
          var a = annSeries[idx];
          var val = v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + ' 元';
          var lines = ['<strong>' + dates[idx] + '</strong>', '当日收益：' + val];
          if (a !== null && a !== undefined) lines.push('当日年化：' + (a > 0 ? '+' : '') + a.toFixed(2) + '%');
          lines.push('参与产品：' + counts[idx] + ' 款');
          return lines.join('<br/>');
        }
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: dates,
        axisLine: { lineStyle: { color: rule } },
        axisTick: { show: false },
        axisLabel: {
          color: muted, fontSize: narrow ? 10.5 : 11.5,
          margin: 17,
          hideOverlap: true,
          interval: axisInterval,
          formatter: function (v) { return v.slice(5); }
        }
      },
      yAxis: {
        type: 'value',
        min: yMin,
        max: yMax,
        interval: yStep,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: muted, fontSize: 11 },
        splitLine: { lineStyle: { color: rule, type: 'solid' } }
      },
      series: [{
        name: '当日收益',
        type: 'line',
        data: series,
        smooth: 0.45,
        symbol: 'circle',
        symbolSize: 4,
        showSymbol: false,
        lineStyle: { width: 1.4, color: lineColor },
        itemStyle: { color: lineColor },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          data: [
            { yAxis: 0, lineStyle: { color: rule, type: 'solid', width: 1 } }
          ]
        },
        markPoint: {
          symbol: 'circle',
          symbolSize: 1,
          data: trendMarks
        }
      }]
    }, true);
    trendChart.resize();
    placeTrendMarks(trendMarks, dates, series, yMin, yMax);
  }

  /* 标注避让：渲染后按像素碰撞重新选择方位，避免压住趋势线与横向坐标轴 */
  function placeTrendMarks(marks, dates, series, yMin, yMax) {
    if (!trendChart || !trendChart.convertToPixel || !marks || !marks.length) return;
    var axisBottom = trendChart.convertToPixel({ yAxisIndex: 0 }, yMin);
    var axisTop = trendChart.convertToPixel({ yAxisIndex: 0 }, yMax);
    var width = trendChart.getWidth();
    var height = trendChart.getHeight();
    if (!isFinite(axisBottom) || !isFinite(axisTop) || !width || !height) return;
    var boxW = 58, boxH = 30, gap = 8;
    var pts = [];
    for (var i = 0; i < series.length; i++) {
      if (series[i] === null || series[i] === undefined) continue;
      var pt = trendChart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [dates[i], series[i]]);
      if (pt) pts.push(pt);
    }
    function hit(x0, y0, x1, y1) {
      for (var j = 0; j < pts.length - 1; j++) {
        var a = pts[j], b = pts[j + 1];
        for (var s = 0; s <= 10; s++) {
          var x = a[0] + (b[0] - a[0]) * s / 10;
          var y = a[1] + (b[1] - a[1]) * s / 10;
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
        }
      }
      return false;
    }
    function clash(a, b) {
      return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
    }
    var placed = [];
    var dashSpecs = [];
    var lineXs = [];
    marks.forEach(function (mk) {
      var cc = trendChart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, mk.coord);
      if (cc) lineXs.push({ x: cc[0], yTop: cc[1] });
    });
    marks.forEach(function (mk, mi) {
      var c = trendChart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, mk.coord);
      if (!c) return;
      var cands = [
        { pos: 'top', box: [c[0] - boxW / 2, c[1] - gap - boxH, c[0] + boxW / 2, c[1] - gap] },
        { pos: 'bottom', box: [c[0] - boxW / 2, c[1] + gap, c[0] + boxW / 2, c[1] + gap + boxH] },
        { pos: 'right', box: [c[0] + gap, c[1] - boxH / 2, c[0] + gap + boxW, c[1] + boxH / 2] },
        { pos: 'left', box: [c[0] - gap - boxW, c[1] - boxH / 2, c[0] - gap, c[1] + boxH / 2] }
      ];
      var pick = null, offX = 0, box = null;
      for (var j = 0; j < cands.length; j++) {
        var cand = cands[j];
        var b = cand.box.slice(0);
        var dx = 0;
        // 水平兜底收边：标注靠左右边缘时平移回画布内，避免文字溢出被裁切
        if (cand.pos === 'top' || cand.pos === 'bottom') {
          if (b[0] < 2 || b[2] > width - 2) {
            if (b[0] < 2 && b[2] > width - 2) dx = (2 - b[0] + (width - 2 - b[2])) / 2;
            else dx = b[0] < 2 ? 2 - b[0] : width - 2 - b[2];
          }
          b[0] += dx; b[2] += dx;
        }
        if (b[0] < 2 || b[2] > width - 2 || b[1] < 2) continue;
        // 标注不得越过横轴（压住日期刻度）；顶部允许使用绘图区上方留白
        if (b[3] > axisBottom - 2 || b[3] > height - 2) continue;
        if (hit(b[0], b[1], b[2], b[3])) continue;
        var blocked = false;
        // 虚线只画在点下方（点到横轴之间），标注框只需避开其他点下方的线段
        for (var m = 0; m < lineXs.length; m++) {
          if (m === mi) continue;
          if (lineXs[m].x > b[0] - 1 && lineXs[m].x < b[2] + 1 && b[3] > lineXs[m].yTop) { blocked = true; break; }
        }
        for (var q = 0; !blocked && q < placed.length; q++) { if (clash(b, placed[q])) { blocked = true; break; } }
        if (blocked) continue;
        pick = cand; offX = dx; box = b;
        break;
      }
      if (!pick) { pick = cands[0]; offX = 0; box = cands[0].box; }
      placed.push(box);
      mk.label.position = pick.pos;
      mk.label.offset = pick.pos === 'top' ? [offX, -gap] : pick.pos === 'bottom' ? [offX, gap] :
        pick.pos === 'right' ? [gap, 0] : [-gap, 0];
      var va = pick.pos === 'top' ? 'bottom' : (pick.pos === 'bottom' ? 'top' : 'middle');
      mk.label.rich.v.verticalAlign = va;
      mk.label.rich.a.verticalAlign = va;
      dashSpecs.push({ date: mk.coord[0], value: mk.coord[1], color: mk.itemStyle.color, pos: pick.pos, box: box });
    });
    // 竖向虚线仅连接「最低点/最高点/最新点」到横轴，不再向上穿过数据点顶部
    var toVal = function (py) {
      var r = (py - axisTop) / ((axisBottom - axisTop) || 1);
      return yMax - r * (yMax - yMin);
    };
    var dashColors = { '#b8860b': 'rgba(184,134,11,.45)', '#1e8449': 'rgba(30,132,73,.45)', '#c0392b': 'rgba(192,57,43,.4)' };
    var lineData = [{ yAxis: 0, lineStyle: { color: '#dfe5ea', type: 'solid', width: 1 } }];
    dashSpecs.forEach(function (o) {
      var c = dashColors[o.color] || 'rgba(192,57,43,.4)';
      // 标注在点下方时，线从标注下沿起画，避免穿过标签
      var y0 = o.pos === 'bottom' ? Math.max(yMin, toVal(o.box[3])) : o.value;
      var y1 = yMin;
      if (y0 - y1 <= 0) return;
      lineData.push([
        { coord: [o.date, y0], lineStyle: { color: c, type: 'dashed', width: 1 } },
        { coord: [o.date, y1], lineStyle: { color: c, type: 'dashed', width: 1 } }
      ]);
    });
    trendChart.setOption({
      series: [{
        markLine: { silent: true, symbol: 'none', label: { show: false }, data: lineData },
        markPoint: { data: marks }
      }]
    });
  }

  function getModel(pid) {
    for (var i = 0; i < MODEL.length; i++) {
      if (MODEL[i].product.id === pid) return MODEL[i];
    }
    return MODEL[0];
  }

  /* ---------------- 产品库 ---------------- */
  var PROD_PAGE_SIZE = 20;
  var prodUi = {
    sale: '', org: '', risk: '', term: '', q: '',
    flagNew: false, flagFav: false,
    holdHolding: true, holdCleared: true, page: 1,
    mPer10k: true, mAnn: true
  };

  function favs() {
    try { return JSON.parse(localStorage.getItem('wealth3.favs') || '[]'); } catch (e) { return []; }
  }
  function saveFavs(list) {
    try { localStorage.setItem('wealth3.favs', JSON.stringify(list)); } catch (e) { /* 忽略 */ }
  }

  function termOf(p) {
    var s = (p.short || '') + (p.name || '');
    if (/日日开|日开/.test(s)) return '日开';
    s = s.replace(/十四/g, '14').replace(/三十/g, '30').replace(/七/g, '7');
    var m = s.match(/持有期?\s*(\d+)\s*天/) || s.match(/(\d+)\s*天/);
    return m ? (+m[1]) + '天' : '—';
  }

  function termBucket(term) {
    if (term === '日开') return '1–14 天';
    var n = parseInt(term, 10);
    if (!n) return '';
    if (n <= 14) return '1–14 天';
    if (n <= 30) return '15–30 天';
    if (n <= 60) return '31–60 天';
    if (n <= 90) return '61–90 天';
    if (n <= 180) return '91–180 天';
    return '180 天以上';
  }

  function saleOf(p) {
    var h = HOLD_BY_PID[p.id];
    return h ? h.tx.saleChannel : (p.saleChannel || '—');
  }

  /* 产品名下方的代销机构小字（持仓优先取交易登记渠道，产品库取公告渠道） */
  function saleSpan(p) {
    var h = HOLD_BY_PID[p.id];
    var v = (h && h.tx && h.tx.saleChannel) || p.saleChannel || '';
    return v && v !== '—' ? '<span class="salech">' + v + '</span>' : '';
  }

  /* 风险等级：以中国理财网披露的 prodRiskLevel 为准（daily/risk_levels.json 同步而来） */
  var RISK_LABEL = {
    '1': 'R1 低风险', '2': 'R2 中低风险', '3': 'R3 中风险',
    '4': 'R4 中高风险', '5': 'R5 高风险'
  };
  function riskOf(p) {
    var levels = window.RISK_LEVELS || {};
    var raw = levels[p.regCode] || p.risk || '';
    if (!raw) return '';
    var s = String(raw).toUpperCase();
    var m = s.match(/R\s*([1-5])/) || s.match(/^0?([1-5])/);
    if (m) return RISK_LABEL[m[1]] || raw;
    return raw;
  }
  /* 产品库风险列仅显示 R + 数字 */
  function riskShort(p) {
    var m = String(riskOf(p)).match(/R\s*([1-5])/);
    return m ? 'R' + m[1] : '';
  }
  /* 发行机构简称：去掉「有限责任公司 / 股份有限公司 / 有限公司」等后缀，用于合并同类项 */
  function orgShort(name) {
    return String(name || '')
      .replace(/有限责任公司|股份有限公司|有限公司|公司/g, '')
      .replace(/\s/g, '')
      .trim();
  }

  /* 搜索排序：产品名称优先，登记编码最后
   * 0 = 名称前缀命中；1 = 名称包含；2 = 仅登记编码命中 */
  function searchRank(p, kw) {
    var short = String(p.short || '').toLowerCase();
    var full = String(p.name || '').toLowerCase();
    if (short.indexOf(kw) === 0 || full.indexOf(kw) === 0) return 0;
    if (short.indexOf(kw) !== -1 || full.indexOf(kw) !== -1) return 1;
    return 2;
  }
  function sortBySearch(list, q, getP) {
    var kw = (q || '').trim().toLowerCase();
    if (!kw) return list;
    var get = getP || function (x) { return x; };
    return list.map(function (x, i) {
      return { x: x, i: i, r: searchRank(get(x) || {}, kw) };
    }).sort(function (a, b) {
      return a.r - b.r || a.i - b.i;
    }).map(function (o) { return o.x; });
  }

  function renderProductTable() {
    var tbody = document.getElementById('prod-body');
    if (!tbody) return;
    var allModels = MODEL.concat(LIB_MODEL);
    var peerAvg30 = peerAvg30Of(allModels);
    var favList = favs();
    var asofMonth = DATA.asOf.slice(0, 7);

    var list = allModels.filter(function (item) {
      var p = item.product;
      var h = HOLD_BY_PID[p.id];
      var term = termOf(p);
      var isNew = (p.inception || item.m.inception || '').slice(0, 7) === asofMonth;
      var isFav = favList.indexOf(p.id) !== -1;
      if (prodUi.sale && saleOf(p) !== prodUi.sale) return false;
      if (prodUi.org && orgShort(p.org) !== prodUi.org) return false;
      if (prodUi.risk && riskOf(p) !== prodUi.risk) return false;
      if (prodUi.term && termBucket(term) !== prodUi.term) return false;
      if (prodUi.flagNew && !isNew) return false;
      if (prodUi.flagFav && !isFav) return false;
      /* 仅持仓/仅清仓为唯一选择：未持有的产品不再出现 */
      if (prodUi.holdHolding !== prodUi.holdCleared) {
        if (!h) return false;
        if (!!h.cleared !== prodUi.holdCleared) return false;
      }
      var q = prodUi.q.trim().toLowerCase();
      if (q && (p.name || '').toLowerCase().indexOf(q) === -1 &&
        (p.short || '').toLowerCase().indexOf(q) === -1 &&
        (p.regCode || '').toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    /* 搜索时按「名称命中优先、编号命中最后」重排；无搜索词时按今日万收降序 */
    list = sortBySearch(list, prodUi.q, function (it) { return it.product; });
    if (!prodUi.q.trim()) {
      list = list.slice().sort(function (a, b) {
        var av = a.m ? a.m.todayPer : null;
        var bv = b.m ? b.m.todayPer : null;
        var aOk = typeof av === 'number' && isFinite(av);
        var bOk = typeof bv === 'number' && isFinite(bv);
        if (aOk !== bOk) return aOk ? -1 : 1;
        if (!aOk) return 0;
        return bv - av;
      });
    }

    var hit = list.length;
    var pages = Math.max(1, Math.ceil(hit / PROD_PAGE_SIZE));
    if (prodUi.page > pages) prodUi.page = pages;
    if (prodUi.page < 1) prodUi.page = 1;
    var pageRows = list.slice((prodUi.page - 1) * PROD_PAGE_SIZE, prodUi.page * PROD_PAGE_SIZE);

    var html = pageRows.map(function (item) {
      var p = item.product;
      var m = item.m;
      var h = HOLD_BY_PID[p.id];
      var term = termOf(p);
      var isNew = (p.inception || m.inception || '').slice(0, 7) === asofMonth;
      var isFav = favList.indexOf(p.id) !== -1;

      var w7 = m.windows[0], w14 = m.windows[1], w30 = m.windows[2];
      function winCell(w) {
        var mark = w.fallback ? '<sup class="dag">†</sup>' : '';
        return '<td class="c st"><b class="m-p10k ' + colorBy(w.per) + '">' + fmt2(w.per) + mark +
          '</b><i class="m-ann ' + colorBy(w.ann) + '">' + fmtAnn(w.ann) + mark + '</i></td>';
      }

      return '<tr data-pid="' + p.id + '">' +
        '<td class="c"><button class="stars" data-fav="' + p.id + '" title="' +
          (isFav ? '取消收藏' : '收藏') + '">' + (isFav ? '★' : '☆') + '</button></td>' +
        '<td><div class="pname">' + (h ?
          '<a class="plink" href="javascript:void(0)" data-goto-trade="' + p.id + '">' +
            (p.short || p.name) + '</a>' :
          (p.short || p.name)) +
          (h ? (h.cleared ?
            '<span class="cleared-date" style="margin-left:6px">' +
              (h.tx && h.tx.confirmDate ? h.tx.confirmDate.slice(5) + ' ' : '') + '清仓</span>' :
            '<span class="tag new" style="margin-left:6px">持仓</span>') : '') +
          (isNew ? '<span class="tag np" style="margin-left:6px">当月新品</span>' : '') +
          saleSpan(p) +
          '</div></td>' +
        '<td class="c pmeta">' + (riskShort(p) || '—') + '</td>' +
        '<td class="c pmeta">' + term + '</td>' +
        '<td class="r num ' + colorBy(m.todayPer) + '" data-col="p10k">' + fmtSigned(m.todayPer) + '</td>' +
        winCell(w7) + winCell(w14) + winCell(w30) +
        '<td class="r num ' + colorBy(m.sinceAnn) + '">' + fmtAnn(m.sinceAnn) + '</td>' +
        '<td class="r num">' + fmtNav(m.latestNav) + '</td>' +
        '<td class="c num">' + mmdd(m.latestDate) + '</td>' +
        '<td class="c cdate">' + (m.inception ?
          '<span>' + m.inception + '</span><i>' + m.listing + ' 天</i>' :
          '<span class="muted">—</span>') + '</td>' +
        '<td class="c">' + (h ? '<button class="mini" data-detail="' + p.id + '">详情</button>' : '<span class="muted">—</span>') + '</td>' +
        '</tr>';
    }).join('');

    tbody.innerHTML = html || '<tr><td colspan="13" class="c muted" style="padding:28px">当前筛选条件下暂无产品</td></tr>';

    var totalEl = document.getElementById('prod-total');
    if (totalEl) totalEl.textContent = allModels.length;
    var hitEl = document.getElementById('prod-hit');
    if (hitEl) hitEl.textContent = hit;
    renderProdPager(pages, hit);

    applyProductCols();
  }

  function renderProdPager(pages, total) {
    var box = document.getElementById('prod-pages');
    var info = document.getElementById('prod-pager-info');
    if (info) info.textContent = '共 ' + total + ' 条 · 每页 ' + PROD_PAGE_SIZE + ' 条';
    if (!box) return;
    var html = '<button data-page="' + (prodUi.page - 1) + '"' + (prodUi.page <= 1 ? ' disabled' : '') + '>‹</button>';
    for (var i = 1; i <= pages; i++) {
      html += '<button data-page="' + i + '"' + (i === prodUi.page ? ' class="on"' : '') + '>' + i + '</button>';
    }
    html += '<button data-page="' + (prodUi.page + 1) + '"' + (prodUi.page >= pages ? ' disabled' : '') + '>›</button>';
    box.innerHTML = html;
  }

  function applyProductCols() {
    var tbl = document.getElementById('prod-table');
    if (!tbl) return;
    var on = { per10k: prodUi.mPer10k, ann: prodUi.mAnn };
    tbl.classList.toggle('only-ann', on.ann && !on.per10k);
    tbl.classList.toggle('only-p10k', on.per10k && !on.ann);
    tbl.querySelectorAll('.m-p10k').forEach(function (el) { el.style.display = on.per10k ? '' : 'none'; });
    tbl.querySelectorAll('.m-ann').forEach(function (el) { el.style.display = on.ann ? '' : 'none'; });
    tbl.querySelectorAll('[data-col="p10k"]').forEach(function (el) { el.style.display = on.per10k ? '' : 'none'; });
  }

  function populateOrgSelect() {
    var sel = document.getElementById('org-sel');
    if (!sel) return;
    var orgs = [];
    MODEL.concat(LIB_MODEL).forEach(function (item) {
      var o = orgShort(item.product.org);
      if (o && orgs.indexOf(o) === -1) orgs.push(o);
    });
    orgs.sort(function (a, b) { return a.localeCompare(b, 'zh-Hans-CN'); });
    var current = sel.value;
    sel.innerHTML = '<option value="">发行机构</option>' + orgs.map(function (o) {
      return '<option value="' + o + '">' + o + '</option>';
    }).join('');
    sel.value = orgs.indexOf(current) !== -1 ? current : '';
  }

  function bindProductFilters() {
    var ids = ['sale-sel', 'org-sel', 'risk-sel', 'term-sel'];
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', function () {
        prodUi.sale = document.getElementById('sale-sel').value;
        prodUi.org = document.getElementById('org-sel').value;
        prodUi.risk = document.getElementById('risk-sel').value;
        prodUi.term = document.getElementById('term-sel').value;
        prodUi.page = 1;
        renderProductTable();
      });
    });

    var flagBtns = document.querySelectorAll('.filters .chip[data-flag]');
    Array.prototype.forEach.call(flagBtns, function (b) {
      b.addEventListener('click', function () {
        b.classList.toggle('on');
        if (b.dataset.flag === 'new') prodUi.flagNew = b.classList.contains('on');
        if (b.dataset.flag === 'fav') prodUi.flagFav = b.classList.contains('on');
        prodUi.page = 1;
        renderProductTable();
      });
    });

    var holdSel = document.getElementById('hold-sel');
    if (holdSel) holdSel.addEventListener('change', function () {
      prodUi.holdHolding = holdSel.value !== 'cleared';
      prodUi.holdCleared = holdSel.value !== 'holding';
      prodUi.page = 1;
      renderProductTable();
    });

    var mSel = document.getElementById('m-sel');
    if (mSel) mSel.addEventListener('change', function () {
      prodUi.mPer10k = mSel.value !== 'ann';
      prodUi.mAnn = mSel.value !== 'per10k';
      applyProductCols();
    });

    var search = document.getElementById('prod-search');
    if (search) search.addEventListener('input', function () {
      prodUi.q = search.value;
      prodUi.page = 1;
      renderProductTable();
    });

    var pager = document.getElementById('prod-pages');
    if (pager) pager.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-page]');
      if (!btn || btn.disabled) return;
      var page = parseInt(btn.getAttribute('data-page'), 10);
      if (!page || page === prodUi.page) return;
      prodUi.page = page;
      renderProductTable();
    });

    var tbody = document.getElementById('prod-body');
    if (tbody) tbody.addEventListener('click', function (e) {
      var fav = e.target.closest('[data-fav]');
      if (fav) {
        var list = favs();
        var id = fav.dataset.fav;
        var idx = list.indexOf(id);
        if (idx === -1) list.push(id); else list.splice(idx, 1);
        saveFavs(list);
        renderProductTable();
        return;
      }
      var det = e.target.closest('[data-detail]');
      if (det) openTradeFor(det.dataset.detail);
    });

    var addBtn = document.getElementById('open-add');
    if (addBtn) addBtn.addEventListener('click', function () {
      resetAddModal();
      var m = document.getElementById('modal-add');
      if (m) m.hidden = false;
    });
  }

  /* ---------------- 添加产品 ---------------- */
  var addState = { image: '', filename: '' };

  function resetAddModal() {
    ['add-name', 'add-code', 'add-org', 'add-nav', 'add-navdate'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    var risk = document.getElementById('add-risk');
    if (risk) risk.value = '';
  }

  function bindAddModal() {
    var submit = document.getElementById('submit-add');
    if (!submit || submit.dataset.bound) return;
    submit.dataset.bound = '1';
    submit.addEventListener('click', function () {
      var name = (document.getElementById('add-name').value || '').trim();
      var code = (document.getElementById('add-code').value || '').trim();
      var org = (document.getElementById('add-org').value || '').trim();
      var risk = document.getElementById('add-risk').value || '';
      var channel = document.getElementById('add-channel').value || '';
      var nav = Number((document.getElementById('add-nav').value || '').trim());
      var navDate = (document.getElementById('add-navdate').value || '').trim();
      if (!name) { toast('请填写产品名称'); return; }
      if (!(nav > 0)) { toast('请填写最新净值'); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(navDate)) { toast('请选择净值日期'); return; }
      if (code && tradeProducts().some(function (p) { return p.regCode === code; })) {
        toast('该登记编码已在产品库，无需重复添加');
        return;
      }
      var item = {
        id: code ? 'M' + code : 'M' + Date.now(),
        name: name,
        regCode: code,
        org: org,
        risk: risk,
        saleChannel: channel,
        nav: nav,
        navDate: navDate
      };
      submit.disabled = true;
      window.STORE.addProduct(item).then(function () {
        submit.disabled = false;
        mergeManualProducts();
        computeHoldings();
        renderAll();
        resetAddModal();
        document.getElementById('modal-add').hidden = true;
        toast('已加入产品库');
      }).catch(function (e) {
        submit.disabled = false;
        toast((e && e.message) || '保存失败，请检查网络');
      });
    });
  }

  /* ---------------- 交易 ---------------- */
  var flowState = { pid: '', year: '', month: '' };
  var flowOpenMonths = {};

  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('on'); }, 2600);
  }

  /* ---------------- 新增交易（人工录入，写入交易底稿） ---------------- */
  function tradeProduct() {
    var hid = document.getElementById('trade-prod');
    if (!hid || !hid.value) return null;
    return findProductById(hid.value);
  }

  function navHint(p) {
    var n = p.nav.length;
    return '净值 ' + Number(p.nav[n - 1]).toFixed(6) + ' · ' + mdText(p.latestDate) + ' · 确认 ' + (p.latestDate || DATA.asOf);
  }

  function renderTradeProductList(q) {
    var list = document.getElementById('trade-prod-list');
    if (!list) return;
    var kw = (q || '').trim().toLowerCase();
    /* 默认不展示搜索建议，输入关键字后再列出「产品库」匹配项 */
    if (!kw) {
      list.innerHTML = '';
      list.hidden = true;
      return;
    }
    list.hidden = false;
    var items = sortBySearch(tradeProducts().filter(function (p) {
      return (p.short || '').toLowerCase().indexOf(kw) !== -1 ||
        (p.name || '').toLowerCase().indexOf(kw) !== -1 ||
        (p.regCode || '').toLowerCase().indexOf(kw) !== -1;
    }), kw).slice(0, 6);
    var hid = document.getElementById('trade-prod');
    var cur = hid ? hid.value : '';
    list.innerHTML = items.map(function (p) {
      return '<div class="sr-row' + (p.id === cur ? ' on' : '') + '" data-pid="' + p.id + '"><span>' +
        (p.short || p.name) + '</span></div>';
    }).join('') || '<div class="sr-row" style="cursor:default"><span class="muted">未找到匹配产品</span></div>';
  }

  function syncTradeForm() {
    var p = tradeProduct();
    if (!p) return;
    var n = p.nav.length;
    var navEl = document.getElementById('trade-nav');
    var applyEl = document.getElementById('trade-apply');
    var dateEl = document.getElementById('trade-confirm');
    var typeEl = document.getElementById('trade-type');
    var shEl = document.getElementById('trade-shares');
    var amtEl = document.getElementById('trade-amount');
    if (navEl) navEl.value = Number(p.nav[n - 1]).toFixed(6);
    if (dateEl) dateEl.value = nextWorkday(applyEl ? applyEl.value : '');
    var h = HOLD_BY_PID[p.id];
    if (typeEl && typeEl.value === '清仓') {
      if (shEl) shEl.value = h && h.shares > 0 ? h.shares.toFixed(2) : '';
      if (amtEl && shEl && shEl.value) amtEl.value = (Number(shEl.value) * Number(navEl.value)).toFixed(2);
    }
    if (amtEl && typeEl && typeEl.value === '赎回' && shEl && shEl.value) {
      amtEl.value = (Number(shEl.value) * Number(navEl.value)).toFixed(2);
    }
  }

  /* 交易类型按钮组的选中态与 select 值保持同步 */
  function syncTypeSeg() {
    var typeEl = document.getElementById('trade-type');
    var box = document.getElementById('trade-type-seg');
    if (!box) return;
    var v = (typeEl && typeEl.value) || '申购';
    Array.prototype.forEach.call(box.querySelectorAll('.seg'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-type') === v);
    });
  }

  /* 按当前持仓限制可选交易类型：无份额不可赎回/清仓，已有在途清仓不可再次清仓 */
  function applyTypeLimits(allowAll) {
    var typeEl = document.getElementById('trade-type');
    var box = document.getElementById('trade-type-seg');
    if (!typeEl || !box) return;
    var p = tradeProduct();
    var shares = allowAll || !p ? 1 : sellableShares(p.id);
    var pending = allowAll || !p ? false : hasPendingClear(p.id);
    var allow = { '申购': true, '赎回': shares > 0, '清仓': shares > 0 && !pending };
    if (!allow[typeEl.value]) {
      typeEl.value = '申购';
      syncTypeSeg();
      syncTradeForm();
    }
    Array.prototype.forEach.call(box.querySelectorAll('.seg'), function (b) {
      var t = b.getAttribute('data-type');
      b.disabled = !allow[t];
      b.title = allow[t] ? '' : (t === '清仓' && pending ? '已有在途清仓单' : '当前无可卖份额');
    });
  }

  function openTradeModal(pid, type, edit) {
    var modal = document.getElementById('modal-trade');
    if (!modal) return;
    modal.dataset.editId = edit ? edit.id : '';
    var titleEl = document.getElementById('trade-modal-title');
    if (titleEl) titleEl.textContent = edit ? '修改交易' : '新增交易';
    var hid = document.getElementById('trade-prod');
    if (hid) hid.value = (edit ? edit.pid : pid) || '';
    var qEl = document.getElementById('trade-prod-q');
    var curP = findProductById(hid ? hid.value : '');
    if (qEl) qEl.value = curP ? (curP.short || curP.name) : '';
    var typeEl = document.getElementById('trade-type');
    if (typeEl) typeEl.value = (edit ? edit.type : type) || '申购';
    syncTypeSeg();
    var shEl = document.getElementById('trade-shares');
    var amtEl = document.getElementById('trade-amount');
    var navEl = document.getElementById('trade-nav');
    var applyEl = document.getElementById('trade-apply');
    var dateEl = document.getElementById('trade-confirm');
    var chEl = document.getElementById('trade-channel');
    if (shEl) shEl.value = '';
    if (amtEl) amtEl.value = '';
    if (applyEl) applyEl.value = '';
    renderTradeProductList('');
    if (edit) {
      var edShares = edit.shares || (edit.confirmNav > 0 ? edit.amount / edit.confirmNav : 0);
      if (shEl) shEl.value = edShares ? String(Math.round(edShares * 100) / 100) : '';
      if (amtEl) amtEl.value = edit.amount ? String(edit.amount) : '';
      if (navEl) navEl.value = Number(edit.confirmNav || 0).toFixed(6);
      if (applyEl) applyEl.value = edit.applyDate || edit.confirmDate || '';
      if (dateEl) dateEl.value = edit.confirmDate || edit.applyDate || '';
      if (chEl) chEl.value = edit.saleChannel || '建设银行';
      if (navEl) navEl.readOnly = false;
      if (dateEl) dateEl.readOnly = false;
    } else {
      if (navEl) navEl.readOnly = true;
      if (dateEl) dateEl.readOnly = true;
      syncTradeForm();
      applyTypeLimits();
    }
    modal.hidden = false;
  }

  function submitTrade() {
    var p = tradeProduct();
    var typeEl = document.getElementById('trade-type');
    var navEl = document.getElementById('trade-nav');
    var applyEl = document.getElementById('trade-apply');
    var dateEl = document.getElementById('trade-confirm');
    var shEl = document.getElementById('trade-shares');
    var amtEl = document.getElementById('trade-amount');
    var chEl = document.getElementById('trade-channel');
    if (!p) { toast('请先选择产品'); return; }
    if (!typeEl || !navEl) return;
    var nav = Number(navEl.value);
    var shares = Number(shEl && shEl.value);
    var amount = Number(amtEl && amtEl.value);
    var modal = document.getElementById('modal-trade');
    var editId = modal ? (modal.dataset.editId || '') : '';
    var tType = typeEl.value;
    /* 赎回/清仓必须基于真实持仓：清仓固定卖出全部可卖份额，赎回份额不得超过持仓 */
    if (!editId && (tType === '赎回' || tType === '清仓')) {
      var hold = sellableShares(p.id);
      if (!(hold > 0)) { toast('该产品当前无可卖份额，无法' + tType); return; }
      if (tType === '清仓' && hasPendingClear(p.id)) { toast('该产品已有在途清仓单，请等待确认后再操作'); return; }
      if (tType === '清仓') {
        shares = hold;
      } else if (shares > hold + 0.01) {
        toast('赎回份额不能超过可卖份额 ' + hold.toFixed(2));
        return;
      }
      if (shEl && tType === '清仓') shEl.value = hold.toFixed(2);
    }
    if (!(shares > 0) && amount > 0 && nav > 0) shares = amount / nav;
    if (!(amount > 0) && shares > 0 && nav > 0) amount = shares * nav;
    if (tType === '清仓' && !editId) amount = shares * nav;
    if (!dateEl.value && applyEl && applyEl.value) dateEl.value = nextWorkday(applyEl.value);
    if (!(shares > 0) || !(nav > 0) || !dateEl.value || (applyEl && !applyEl.value)) {
      toast('请填写份额（或金额）与申购日期后提交');
      return;
    }
    var btn = document.getElementById('trade-submit');
    if (btn) btn.disabled = true;
    var body = {
      pid: p.id,
      type: tType,
      shares: Math.round(shares * 100) / 100,
      amount: Math.round(amount * 100) / 100,
      confirmNav: nav,
      applyDate: applyEl ? applyEl.value : dateEl.value,
      confirmDate: dateEl.value,
      saleChannel: chEl ? chEl.value : ''
    };
    var req = editId ? window.STORE.update(editId, body) : window.STORE.add(body);
    req.then(function (res) {
      if (btn) btn.disabled = false;
      if (!res || !res.ok) { toast((res && res.message) || '提交失败'); return; }
      toast(editId ? '交易已修改，刷新持仓' : ('已录入 ' + typeEl.value + '，刷新持仓'));
      setTimeout(function () { location.reload(); }, 700);
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      toast((e && e.message) || '写入交易失败，请检查网络后重试');
    });
  }

  function bindTradeModal() {
    var modal = document.getElementById('modal-trade');
    if (!modal) return;
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = document.getElementById(b.getAttribute('data-close'));
        if (m) m.hidden = true;
      });
    });
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.hidden = true; });
    var qEl = document.getElementById('trade-prod-q');
    if (qEl) qEl.addEventListener('input', function () { renderTradeProductList(qEl.value); });
    var list = document.getElementById('trade-prod-list');
    if (list) list.addEventListener('click', function (e) {
      var row = e.target.closest('[data-pid]');
      if (!row) return;
      var pid = row.getAttribute('data-pid');
      var hid = document.getElementById('trade-prod');
      if (hid) hid.value = pid;
      /* 选中后把产品名称回填到搜索框，并收起候选列表 */
      var picked = findProductById(pid);
      if (qEl) qEl.value = picked ? (picked.short || picked.name) : (row.querySelector('span') || {}).textContent || '';
      list.innerHTML = '';
      list.hidden = true;
      var sh0 = document.getElementById('trade-shares');
      if (sh0) sh0.value = '';
      var amt0 = document.getElementById('trade-amount');
      if (amt0) amt0.value = '';
      var ap0 = document.getElementById('trade-apply');
      if (ap0) ap0.value = '';
      syncTradeForm();
      applyTypeLimits();
    });
    var applyEl = document.getElementById('trade-apply');
    if (applyEl) applyEl.addEventListener('change', function () {
      var dateEl = document.getElementById('trade-confirm');
      if (dateEl) dateEl.value = nextWorkday(applyEl.value);
    });
    var typeEl = document.getElementById('trade-type');
    if (typeEl) typeEl.addEventListener('change', function () {
      var sh = document.getElementById('trade-shares');
      if (sh) sh.value = '';
      var amt = document.getElementById('trade-amount');
      if (amt) amt.value = '';
      syncTradeForm();
    });
    /* 交易类型同级按钮：点选后同步隐藏的 select 并刷新表单 */
    var segBox = document.getElementById('trade-type-seg');
    if (segBox) segBox.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-type]');
      if (!btn) return;
      if (typeEl) {
        typeEl.value = btn.getAttribute('data-type');
        typeEl.dispatchEvent(new Event('change'));
      }
      syncTypeSeg();
    });
    var shEl = document.getElementById('trade-shares');
    if (shEl) shEl.addEventListener('input', function () {
      var nav = Number((document.getElementById('trade-nav') || {}).value);
      var amt = document.getElementById('trade-amount');
      if (amt && nav > 0) amt.value = (Number(shEl.value) * nav).toFixed(2);
    });
    var amtEl = document.getElementById('trade-amount');
    if (amtEl) amtEl.addEventListener('input', function () {
      var nav = Number((document.getElementById('trade-nav') || {}).value);
      var sh = document.getElementById('trade-shares');
      if (sh && nav > 0) sh.value = (Number(amtEl.value) / nav).toFixed(2);
    });
    var submit = document.getElementById('trade-submit');
    if (submit) submit.addEventListener('click', submitTrade);
  }

  function switchTab(name) {
    var tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (tab) tab.click();
  }

  /* ---------------- 自定义日期选择器 ---------------- */
  var dpEl = null;
  var dpState = { input: null, view: new Date(), sel: '', mode: 'day' };

  function buildDp() {
    if (dpEl) return dpEl;
    dpEl = document.createElement('div');
    dpEl.className = 'dp';
    dpEl.id = 'dp-pop';
    dpEl.hidden = true;
    dpEl.setAttribute('role', 'dialog');
    dpEl.setAttribute('aria-label', '选择日期');
    dpEl.innerHTML =
      '<div class="dp-head">' +
        '<button type="button" class="dp-nav" data-dp="prev" aria-label="上个月">‹</button>' +
        '<button type="button" class="dp-title" data-dp="title" aria-label="切换年月"></button>' +
        '<button type="button" class="dp-nav" data-dp="next" aria-label="下个月">›</button>' +
      '</div>' +
      '<div class="dp-body"></div>' +
      '<div class="dp-foot">' +
        '<button type="button" data-dp="today">今天</button>' +
        '<span class="dp-hint">点标题切换年月</span>' +
        '<button type="button" data-dp="clear">清空</button>' +
      '</div>';
    document.body.appendChild(dpEl);
    dpEl.addEventListener('click', onDpClick);
    return dpEl;
  }

  function renderDp() {
    var title = dpEl.querySelector('[data-dp="title"]');
    var body = dpEl.querySelector('.dp-body');
    var y = dpState.view.getFullYear();
    var m = dpState.view.getMonth();
    title.textContent = y + ' 年 ' + (m + 1) + ' 月';

    if (dpState.mode === 'month') {
      var mh = '';
      for (var i = 0; i < 12; i++) {
        mh += '<button type="button" data-dp-month="' + i + '"' + (i === m ? ' class="on"' : '') + '>' + (i + 1) + ' 月</button>';
      }
      body.innerHTML = '<div class="dp-ybar">' +
        '<button type="button" class="dp-nav" data-dp="yprev" aria-label="上一年">‹</button>' +
        '<span class="dp-y">' + y + '</span>' +
        '<button type="button" class="dp-nav" data-dp="ynext" aria-label="下一年">›</button></div>' +
        '<div class="dp-mgrid">' + mh + '</div>';
      return;
    }

    /* 周一为首列，只渲染当月实际需要的行数，避免多余的下月占位行 */
    var first = new Date(y, m, 1);
    var offset = (first.getDay() + 6) % 7;
    var total = Math.ceil((offset + new Date(y, m + 1, 0).getDate()) / 7) * 7;
    var todayStr = isoDate(new Date());
    var cells = '';
    for (var k = 0; k < total; k++) {
      var d = new Date(y, m, 1 - offset + k);
      var s = isoDate(d);
      var cls = [];
      if (d.getMonth() !== m) cls.push('out');
      if (d.getDay() === 0 || d.getDay() === 6) cls.push('we');
      if (s === todayStr) cls.push('today');
      if (s === dpState.sel) cls.push('on');
      cells += '<button type="button" data-dp-day="' + s + '" class="' + cls.join(' ') + '"' +
        (cls.indexOf('on') > -1 ? ' aria-current="date"' : '') + '>' + d.getDate() + '</button>';
    }
    body.innerHTML = '<div class="dp-week">' +
      '<span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span>' +
      '</div><div class="dp-grid">' + cells + '</div>';
  }

  function placeDp() {
    if (!dpEl || !dpState.input) return;
    var r = dpState.input.getBoundingClientRect();
    var w = dpEl.offsetWidth;
    var h = dpEl.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = vw <= 560 ? Math.max(8, (vw - w) / 2) : Math.min(Math.max(8, r.left), vw - w - 8);
    var top = r.bottom + 6;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
    dpEl.style.left = left + 'px';
    dpEl.style.top = top + 'px';
  }

  function openDp(input) {
    buildDp();
    if (!dpEl.hidden && dpState.input === input) { closeDp(); return; }
    dpState.input = input;
    var v = String(input.value || '').trim();
    var ok = /^\d{4}-\d{2}-\d{2}$/.test(v);
    var base = ok ? parseDate(v) : new Date();
    if (!base || isNaN(base.getTime())) base = new Date();
    dpState.sel = ok ? v : '';
    dpState.view = new Date(base.getFullYear(), base.getMonth(), 1);
    dpState.mode = 'day';
    renderDp();
    dpEl.hidden = false;
    placeDp();
  }

  function closeDp() {
    if (dpEl) dpEl.hidden = true;
    dpState.input = null;
  }

  function pickDp(s) {
    var input = dpState.input;
    if (!input) return;
    input.value = s;
    closeDp();
    input.dispatchEvent(new Event('change'));
  }

  function onDpClick(e) {
    var monthBtn = e.target.closest('[data-dp-month]');
    if (monthBtn) {
      dpState.view = new Date(dpState.view.getFullYear(), Number(monthBtn.getAttribute('data-dp-month')), 1);
      dpState.mode = 'day';
      renderDp();
      return;
    }
    var dayBtn = e.target.closest('[data-dp-day]');
    if (dayBtn) { pickDp(dayBtn.getAttribute('data-dp-day')); return; }
    var act = e.target.closest('[data-dp]');
    if (!act) return;
    var v = dpState.view;
    switch (act.getAttribute('data-dp')) {
      case 'prev': dpState.view = new Date(v.getFullYear(), v.getMonth() - 1, 1); break;
      case 'next': dpState.view = new Date(v.getFullYear(), v.getMonth() + 1, 1); break;
      case 'yprev': dpState.view = new Date(v.getFullYear() - 1, v.getMonth(), 1); break;
      case 'ynext': dpState.view = new Date(v.getFullYear() + 1, v.getMonth(), 1); break;
      case 'title': dpState.mode = dpState.mode === 'month' ? 'day' : 'month'; break;
      case 'today': pickDp(isoDate(new Date())); return;
      case 'clear': pickDp(''); return;
    }
    renderDp();
  }

  function initDatePicker() {
    var inputs = document.querySelectorAll('.dp-wrap input');
    Array.prototype.forEach.call(inputs, function (input) {
      var wrap = input.closest('.dp-wrap') || input;
      wrap.addEventListener('click', function (e) { e.preventDefault(); openDp(input); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDp(input); }
        else if (e.key === 'Escape') closeDp();
      });
    });
    document.addEventListener('mousedown', function (e) {
      if (!dpEl || dpEl.hidden) return;
      if (dpEl.contains(e.target) || e.target.closest('.dp-wrap')) return;
      closeDp();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDp(); });
    window.addEventListener('resize', function () { if (dpEl && !dpEl.hidden) placeDp(); });
    window.addEventListener('scroll', function () { if (dpEl && !dpEl.hidden) placeDp(); }, true);
  }

  function openTradeFor(pid) {
    flowState.pid = pid || '';
    flowState.year = '';
    flowState.month = '';
    var ys = document.getElementById('flow-year');
    var ms = document.getElementById('flow-month');
    if (ys) ys.value = '';
    if (ms) ms.value = '';
    /* 从产品名进入时，该产品所有流水月份全部展开，不按月份折叠 */
    flowOpenMonths = {};
    if (pid) {
      ((window.TRANSACTIONS && window.TRANSACTIONS.items) || []).forEach(function (t) {
        if (t.pid === pid) flowOpenMonths[String(t.applyDate).slice(0, 7)] = true;
      });
    }
    renderFlows();
    renderTradeSummary();
    switchTab('trade');
    closePanel();
  }

  /* 交易汇总行：待确认申购计入（标记在途），已清仓按「确认日 +1 天」剔除 */
  function summaryRows() {
    var today = isoDate(new Date());
    var rows = [];
    HOLDINGS.forEach(function (h) {
      if (h.cleared) {
        var cd = h.tx && h.tx.confirmDate;
        if (cd) {
          /* 剔除日 = 清仓确认份额日 + 1 天：12 号确认，13 号才从交易汇总剔除 */
          var cut = new Date(cd + 'T00:00:00');
          cut.setDate(cut.getDate() + 1);
          if (today >= isoDate(cut)) return;
        }
      }
      rows.push({
        product: h.product, latestDate: h.latestDate, latestNav: h.latestNav,
        shares: h.shares, cost: h.cost, mv: h.mv, profit: h.profit, ann: h.ann,
        days: h.days, cleared: h.cleared, tx: h.tx, pending: false
      });
    });
    var pend = {};
    ((window.TRANSACTIONS && window.TRANSACTIONS.items) || []).forEach(function (t) {
      if (t.type !== '申购' || txStatus(t) !== '在途') return;
      var p = findProductById(t.pid);
      if (!p) return;
      var latestNav = p.nav[p.nav.length - 1];
      var nav = Number(t.confirmNav) || latestNav || 1;
      var sh = Number(t.shares);
      if (!(sh > 0)) sh = (Number(t.amount) || 0) / nav;
      var rec = pend[p.id];
      if (!rec) {
        rec = pend[p.id] = {
          product: p, latestDate: p.latestDate, latestNav: latestNav,
          shares: 0, cost: 0, tx: t
        };
      }
      rec.shares += sh;
      rec.cost += Number(t.amount) || sh * nav;
    });
    Object.keys(pend).forEach(function (pid) {
      var q = pend[pid];
      var row = null;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].product.id === pid) { row = rows[i]; break; }
      }
      if (row) {
        row.shares += q.shares;
        row.cost += q.cost;
        row.mv = row.shares * row.latestNav;
        row.profit = row.mv - row.cost;
        row.ann = (row.days > 0 && row.cost > 0) ? row.profit / row.cost * 365 / row.days * 100 : row.ann;
        row.pending = true;
      } else {
        rows.push({
          product: q.product, latestDate: q.latestDate, latestNav: q.latestNav,
          shares: q.shares, cost: q.cost, mv: q.shares * q.latestNav,
          profit: q.shares * q.latestNav - q.cost,
          ann: null, days: 0, cleared: false, tx: q.tx, pending: true
        });
      }
    });
    return rows;
  }

  function renderTradeSummary() {
    var tbody = document.getElementById('sum-body');
    if (!tbody) return;
    var rows = summaryRows();
    if (flowState.pid) {
      rows = rows.filter(function (r) { return r.product.id === flowState.pid; });
    }
    if (sumState.key && sumSorters[sumState.key]) {
      var get = sumSorters[sumState.key];
      var dir = sumState.dir === 'asc' ? 1 : -1;
      rows.sort(function (a, b) {
        var va = get(a), vb = get(b);
        var ea = (va === null || va === undefined || va === ''), eb = (vb === null || vb === undefined || vb === '');
        if (ea && eb) return 0;
        if (ea) return 1;
        if (eb) return -1;
        if (typeof va === 'string' || typeof vb === 'string') {
          return String(va).localeCompare(String(vb), 'zh-Hans-CN') * dir;
        }
        return (va - vb) * dir;
      });
    }
    tbody.innerHTML = rows.map(function (h) {
      var p = h.product;
      /* 已清仓无份额：赎回/清仓不可用；已有在途清仓单：清仓不可用（份额取已确认持仓，不含在途申购） */
      var canSell = sellableShares(p.id) > 0;
      var canClose = canSell && !hasPendingClear(p.id);
      var noShareTip = ' title="当前无可卖份额（已清仓）" disabled';
      var pendingTip = ' title="已有在途清仓单，确认后再操作" disabled';
      return '<tr>' +
        '<td><div class="pname"><a class="plink" href="javascript:void(0)" data-goto-trade="' + p.id + '">' +
          (p.short || p.name) + '</a>' +
          (h.pending ? '<span class="tag np" style="margin-left:6px" title="申购待确认：确认日净值未披露，按最新净值估算计入">在途</span>' : '') +
          (h.cleared ? '<span class="cleared-date" style="margin-left:6px">' +
            (h.tx && h.tx.confirmDate ? h.tx.confirmDate.slice(5).replace('-', '.') : '') + ' 清仓</span>' : '') +
          '</div></td>' +
        '<td class="c num">' + mmdd(h.latestDate) + '</td>' +
        '<td class="c num">' + fmtNav(h.latestNav) + '</td>' +
        '<td class="r num">' + fmtMoney(h.shares) + '</td>' +
        '<td class="r num">' + fmtMoney(h.mv) + '</td>' +
        '<td class="r num ' + colorBy(h.profit) + '" title="持仓收益 = 市值 − 成本">' + fmtSigned(h.profit) + '</td>' +
        '<td class="r num ' + colorBy(h.ann) + '">' + fmtAnn(h.ann) + '</td>' +
        '<td class="c num dcell"><span class="days">' + h.days + '</span><i class="dunit">天</i></td>' +
        '<td class="c"><button class="mini buy" data-act="add" data-pid="' + p.id + '">加购</button> ' +
          '<button class="mini sell" data-act="redeem" data-pid="' + p.id + '"' + (canSell ? '' : noShareTip) + '>赎回</button> ' +
          '<button class="mini warn" data-act="close" data-pid="' + p.id + '"' + (canClose ? '' : (canSell ? pendingTip : noShareTip)) + '>清仓</button></td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="9" class="c muted" style="padding:28px">' + (flowState.pid ? '该产品暂无持仓' : '暂无持仓') + '</td></tr>';

    Array.prototype.forEach.call(document.querySelectorAll('#sum-table thead th[data-sort]'), function (th) {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.getAttribute('data-sort') === sumState.key) {
        th.classList.add(sumState.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      }
    });
  }

  /* 交易汇总表头排序：点第一次降序，再点升序 */
  function bindSumSort() {
    Array.prototype.forEach.call(document.querySelectorAll('#sum-table thead th[data-sort]'), function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (sumState.key === key) {
          sumState.dir = sumState.dir === 'asc' ? 'desc' : 'asc';
        } else {
          sumState.key = key;
          sumState.dir = 'desc';
        }
        renderTradeSummary();
      });
    });
  }

  function populateFlowSelects() {
    var items = (window.TRANSACTIONS && window.TRANSACTIONS.items) || [];
    /* 默认定位到最近一笔交易日所在年月 */
    if (!flowState.pid && flowState.year === '' && flowState.month === '') {
      var latest = '';
      items.forEach(function (t) { if (t.applyDate > latest) latest = t.applyDate; });
      if (latest) {
        flowState.year = latest.slice(0, 4);
        flowState.month = String(+latest.slice(5, 7) - 1);
      }
    }
    var ys = document.getElementById('flow-year');
    var ms = document.getElementById('flow-month');
    if (ys) {
      var years = [];
      items.forEach(function (t) {
        var y = t.applyDate.slice(0, 4);
        if (years.indexOf(y) === -1) years.push(y);
      });
      years.sort();
      ys.innerHTML = '<option value="">年份</option>' + years.map(function (y) {
        return '<option value="' + y + '">' + y + ' 年</option>';
      }).join('');
      ys.value = flowState.year;
    }
    if (ms) {
      ms.innerHTML = '<option value="">月份</option>' + Array.apply(null, Array(12)).map(function (_, i) {
        return '<option value="' + i + '">' + (i + 1) + ' 月</option>';
      }).join('');
      ms.value = flowState.month === '' ? '' : String(+flowState.month);
    }
  }

  /* 交易流水：左右箭头按月切换（仅在已有流水的月份之间移动） */
  function flowMonthKeys() {
    var items = (window.TRANSACTIONS && window.TRANSACTIONS.items) || [];
    var set = {};
    items.forEach(function (t) {
      if (flowState.pid && t.pid !== flowState.pid) return;
      set[t.applyDate.slice(0, 7)] = 1;
    });
    return Object.keys(set).sort();
  }

  /* 交易流水：年份箭头仅在已有流水的年份之间移动 */
  function flowYearKeys() {
    var set = {};
    flowMonthKeys().forEach(function (k) { set[k.slice(0, 4)] = 1; });
    return Object.keys(set).sort();
  }

  function currentFlowKey() {
    if (flowState.year && flowState.month !== '') {
      return flowState.year + '-' + ('0' + (+flowState.month + 1)).slice(-2);
    }
    return '';
  }

  function updateFlowArrows() {
    var prev = document.getElementById('flow-month-prev');
    var next = document.getElementById('flow-month-next');
    var keys = flowMonthKeys();
    var cur = currentFlowKey();
    var idx = keys.indexOf(cur);
    if (prev) prev.disabled = !keys.length || (cur !== '' && idx <= 0);
    if (next) next.disabled = !keys.length || cur === '' || idx >= keys.length - 1;

    var yPrev = document.getElementById('flow-year-prev');
    var yNext = document.getElementById('flow-year-next');
    var years = flowYearKeys();
    var yi = years.indexOf(flowState.year);
    if (yPrev) yPrev.disabled = !years.length || (flowState.year !== '' && yi <= 0);
    if (yNext) yNext.disabled = !years.length || flowState.year === '' || yi >= years.length - 1;
  }

  /* 年份箭头：切到有流水的上/下一年，月份回落为「全年」 */
  function stepFlowYear(delta) {
    var years = flowYearKeys();
    if (!years.length || delta > 0 && flowState.year === '') return;
    var idx = years.indexOf(flowState.year);
    var target;
    if (flowState.year === '') target = years[years.length - 1];
    else target = years[Math.min(Math.max(idx + delta, 0), years.length - 1)];
    flowState.year = target;
    flowState.month = '';
    var ys = document.getElementById('flow-year');
    var ms = document.getElementById('flow-month');
    if (ys) ys.value = flowState.year;
    if (ms) ms.value = '';
    renderFlows();
  }

  function stepFlowMonth(delta) {
    var keys = flowMonthKeys();
    if (!keys.length || delta > 0 && currentFlowKey() === '') return;
    var cur = currentFlowKey();
    var idx = keys.indexOf(cur);
    var target;
    if (cur === '') target = keys[keys.length - 1];
    else target = keys[Math.min(Math.max(idx + delta, 0), keys.length - 1)];
    flowState.year = target.slice(0, 4);
    flowState.month = String(+target.slice(5, 7) - 1);
    var ys = document.getElementById('flow-year');
    var ms = document.getElementById('flow-month');
    if (ys) ys.value = flowState.year;
    if (ms) ms.value = flowState.month;
    renderFlows();
  }

  function renderFlows() {
    var tbody = document.getElementById('flow-body');
    if (!tbody) return;
    var items = ((window.TRANSACTIONS && window.TRANSACTIONS.items) || []).slice();

    items.forEach(function (t) {
      t._p = findProductById(t.pid);
    });

    items = items.filter(function (t) {
      if (flowState.pid && t.pid !== flowState.pid) return false;
      if (flowState.year && t.applyDate.slice(0, 4) !== flowState.year) return false;
      if (flowState.month !== '' && (+t.applyDate.slice(5, 7) - 1) !== +flowState.month) return false;
      return true;
    }).sort(function (a, b) { return b.applyDate.localeCompare(a.applyDate); });

    var groups = {};
    var months = [];
    items.forEach(function (t) {
      var mk = t.applyDate.slice(0, 7);
      if (!groups[mk]) { groups[mk] = []; months.push(mk); }
      groups[mk].push(t);
    });
    months.sort().reverse();

    function moneyBrief(v) {
      return v >= 10000 ? (v / 10000).toFixed(2) + '万' : fmtMoney(v);
    }

    tbody.innerHTML = months.map(function (mk) {
      var list = groups[mk];
      var open = !!flowOpenMonths[mk];
      var sum = {};
      list.forEach(function (t) {
        var k = t.type || '申购';
        if (!sum[k]) sum[k] = { n: 0, amt: 0 };
        sum[k].n += 1;
        sum[k].amt += Number(t.amount) || 0;
      });
      var meta = ['申购', '赎回', '清仓'].filter(function (k) { return sum[k] && sum[k].n; })
        .map(function (k) { return k + ' ' + sum[k].n + ' 笔 ' + moneyBrief(sum[k].amt); })
        .join(' · ');
      var head = '<tr class="flow-month' + (open ? ' open' : '') + '" data-mk="' + mk + '">' +
        '<td colspan="9"><span class="fm-caret">▸</span>' + mk.slice(0, 4) + '年' + (+mk.slice(5, 7)) + '月' +
        '<span class="fm-meta">共 ' + list.length + ' 笔 · ' + meta + '</span></td></tr>';
      var rows = list.map(function (t) {
        var p = t._p;
        var st = txStatus(t);
        return '<tr class="flow-detail"' + (open ? '' : ' hidden') + '>' +
          '<td class="num">' + t.applyDate + '</td>' +
          '<td><div class="pname">' + (p ? (p.short || p.name) : t.pid) +
            (t.saleChannel ? '<span class="salech">' + t.saleChannel + '</span>' : '') + '</div></td>' +
          '<td class="c"><span class="tag' + (t.type === '赎回' || t.type === '清仓' ? ' new' : '') + '">' + t.type + '</span></td>' +
          '<td class="r num">' + fmtMoney(t.shares || (t.amount / t.confirmNav)) + '</td>' +
          '<td class="r num">' + (st === '在途' ? '<span class="pending-nav">待确认</span>' : fmtNav(navOnDate(p, t.confirmDate) || t.confirmNav)) + '</td>' +
          '<td class="r num">' + fmtMoney(t.amount) + '</td>' +
          '<td class="c num">' + t.confirmDate + '</td>' +
          '<td class="c"><span class="tag' + (st === '在途' ? ' np' : '') + '" title="' +
            (st === '在途' ? '在途：' + txPendingReason(t) + '，暂不计入持仓；净值披露后自动转为已确认' : '已确认并计入持仓') + '">' + st + '</span></td>' +
          '<td class="c"><button class="mini" data-edit="' + t.id + '">修改</button> ' +
            '<button class="mini warn" data-del="' + t.id + '">删除</button></td>' +
          '</tr>';
      }).join('');
      return head + rows;
    }).join('') || '<tr><td colspan="9" class="c muted" style="padding:28px">暂无符合条件的交易流水</td></tr>';

    var filterEl = document.getElementById('trade-filter');
    var nameEl = document.getElementById('trade-filter-name');
    if (filterEl) {
      if (flowState.pid) {
        filterEl.hidden = false;
        if (nameEl) nameEl.textContent = shortOf(flowState.pid);
      } else {
        filterEl.hidden = true;
      }
    }
    updateFlowArrows();
  }

  function bindTrade() {
    var ys = document.getElementById('flow-year');
    if (ys) ys.addEventListener('change', function () { flowState.year = ys.value; renderFlows(); });
    var ms = document.getElementById('flow-month');
    if (ms) ms.addEventListener('change', function () { flowState.month = ms.value; renderFlows(); });
    var mp = document.getElementById('flow-month-prev');
    if (mp) mp.addEventListener('click', function () { stepFlowMonth(-1); });
    var mn = document.getElementById('flow-month-next');
    if (mn) mn.addEventListener('click', function () { stepFlowMonth(1); });
    var yp = document.getElementById('flow-year-prev');
    if (yp) yp.addEventListener('click', function () { stepFlowYear(-1); });
    var yn = document.getElementById('flow-year-next');
    if (yn) yn.addEventListener('click', function () { stepFlowYear(1); });

    var clear = document.getElementById('clear-filter');
    if (clear) clear.addEventListener('click', function () { openTradeFor(''); });

    var open = document.getElementById('open-trade');
    if (open) open.addEventListener('click', function () {
      openTradeModal('', '申购');
    });

    var sum = document.getElementById('sum-body');
    if (sum) sum.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      var map = { add: '申购', redeem: '赎回', close: '清仓' };
      openTradeModal(btn.getAttribute('data-pid') || '', map[btn.getAttribute('data-act')] || '申购');
    });

    var flow = document.getElementById('flow-body');
    if (flow) flow.addEventListener('click', function (e) {
      var mh = e.target.closest('tr.flow-month');
      if (mh) {
        var mk = mh.getAttribute('data-mk');
        flowOpenMonths[mk] = !flowOpenMonths[mk];
        renderFlows();
        return;
      }
      var ed = e.target.closest('[data-edit]');
      if (ed) {
        var eid = ed.getAttribute('data-edit');
        var t = ((window.TRANSACTIONS && window.TRANSACTIONS.items) || []).filter(function (x) { return x.id === eid; })[0];
        if (t) openTradeModal(t.pid, t.type, t);
        return;
      }
      var del = e.target.closest('[data-del]');
      if (del) {
        var did = del.getAttribute('data-del');
        if (!window.confirm('确认删除该笔交易？删除后持仓与收益将重新计算。')) return;
        window.STORE.remove(did).then(function (res) {
          if (!res || !res.ok) { toast((res && res.message) || '删除失败'); return; }
          toast('交易已删除，刷新持仓');
          setTimeout(function () { location.reload(); }, 700);
        }).catch(function (e) { toast((e && e.message) || '删除交易失败，请检查网络后重试'); });
      }
    });

    document.addEventListener('click', function (e) {
      var link = e.target.closest ? e.target.closest('[data-goto-trade]') : null;
      if (!link) return;
      e.preventDefault();
      openTradeFor(link.getAttribute('data-goto-trade'));
    });
  }

  /* ---------------- 顶部产品多选 ---------------- */
  function shortOf(id) {
    var list = pickableProducts();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i].short || list[i].name;
    }
    return '';
  }

  function updatePickerLabel() {
    var el = document.getElementById('ms-label');
    if (!el) return;
    var n = selectedIds.length;
    var total = pickableProducts().length;
    el.textContent = n + ' 款';
    var trigger = document.getElementById('ms-trigger');
    if (trigger) {
      trigger.title = n === 0
        ? '未选择产品'
        : n === total
          ? '全部产品（' + n + ' 款）'
          : (n === 1 ? shortOf(selectedIds[0]) : '已选 ' + n + ' 款');
    }
  }

  var pickerQuery = '';

  function pickerMatches(p) {
    var q = pickerQuery.trim().toLowerCase();
    if (!q) return true;
    return (p.name || '').toLowerCase().indexOf(q) !== -1 ||
      (p.short || '').toLowerCase().indexOf(q) !== -1 ||
      (p.regCode || '').toLowerCase().indexOf(q) !== -1;
  }

  function renderPickerList() {
    var list = document.getElementById('ms-list');
    if (!list) return;
    var items = sortBySearch(pickableProducts().filter(pickerMatches), pickerQuery);
    if (!items.length) {
      list.innerHTML = '<div class="ms-empty">未找到匹配产品</div>';
      return;
    }
    list.innerHTML = items.map(function (p) {
      var checked = selectedIds.indexOf(p.id) !== -1 ? ' checked' : '';
      return '<label class="ms-item">' +
        '<input type="checkbox" value="' + p.id + '"' + checked + '>' +
        '<span class="ms-name">' + (p.short || p.name) + '</span>' +
        '<em>' + p.regCode + '</em>' +
        '</label>';
    }).join('');
  }

  function openPanel() {
    var trigger = document.getElementById('ms-trigger');
    var panel = document.getElementById('ms-panel');
    if (!trigger || !panel) return;
    panel.hidden = false;
    var search = document.getElementById('ms-search');
    if (search) search.focus();
    var r = trigger.getBoundingClientRect();
    var pw = panel.offsetWidth;
    var ph = panel.offsetHeight;
    var left = Math.max(16, Math.min(r.left, window.innerWidth - pw - 16));
    var top = r.bottom + 8;
    if (top + ph > window.innerHeight - 12) top = Math.max(12, r.top - ph - 8);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    trigger.setAttribute('aria-expanded', 'true');
  }

  function closePanel() {
    var panel = document.getElementById('ms-panel');
    var trigger = document.getElementById('ms-trigger');
    if (panel) panel.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }

  var NP_UI = { channel: '' };
  var NP_COLORS = ['#0e5a73', '#2f6f9f', '#8a5a2b', '#3f6f56', '#6b4c8a'];

  function ymd(d) {
    var m = d.getMonth() + 1, dd = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (dd < 10 ? '0' + dd : dd);
  }

  function mdText(s) {
    return s ? s.slice(5).replace('-', '.') : '';
  }

  function quotaText(w) {
    if (w === null || w === undefined || isNaN(w)) return '';
    w = Number(w);
    return w >= 10000 ? (Math.round(w / 100) / 100) + '亿' : w + '万';
  }

  // 统一简称规则：机构简称 + 产品系列 + 持有期 + 期数，去掉「理财/固收类/最低持有/产品」等修饰词
  function npShortName(p, channel) {
    var base = (p.short || p.name || '—')
      .replace(/（[^）]*最低持有[^）]*）/g, '')
      .replace(/固定收益类|固收类/g, '')
      .replace(/最低持有|最短持有/g, '')
      .replace(/理财产品/g, '')
      .replace(/产品(?=第\d+期|$)/g, '')
      .trim();
    var org = (channel || '').replace(/理财(有限责任公司)?$/g, '').trim();
    if (org && base.indexOf(org) !== 0) base = org + base;
    return base || '—';
  }

  function renderNewProds() {
    var head = document.getElementById('np-head');
    var box = document.getElementById('np-lanes');
    if (!head || !box) return;

    var NP = window.NEW_PRODUCTS || { lanes: [] };
    var lanes = NP.lanes || [];
    // 查漏补缺：成立日 <= 今天的产品已不算「新品预告」，直接在此拦截（云端/本地数据同口径）
    var _todayKey = ymd(new Date());
    lanes = lanes.map(function (l) {
      return {
        channel: l.channel,
        products: (l.products || []).filter(function (p) {
          return !(p.establish && p.establish <= _todayKey);
        })
      };
    }).filter(function (l) { return l.products.length; });
    var winStart = (NP.window && NP.window.start) || DATA.asOf;
    var winEnd = (NP.window && NP.window.end) || winStart;
    var days = [];
    var cur = parseDate(winStart), endTs = parseDate(winEnd).getTime();
    while (cur.getTime() <= endTs && days.length < 14) {
      days.push(ymd(cur));
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
    }
    if (!days.length) days.push(winStart);
    var N = days.length;
    var last = N - 1;
    var wd = ['日', '一', '二', '三', '四', '五', '六'];

    var opts = ['<option value="">代销机构</option>'];
    lanes.forEach(function (l) {
      opts.push('<option' + (NP_UI.channel === l.channel ? ' selected' : '') + '>' + l.channel + '</option>');
    });
    head.style.gridTemplateColumns = '124px repeat(' + N + ',minmax(0,1fr))';
    head.innerHTML = '<div class="ts-cell ts-org"><select id="np-org-sel" aria-label="按代销机构筛选">' +
      opts.join('') + '</select></div>' +
      days.map(function (ds, idx) {
        var dd = parseDate(ds);
        return '<div class="ts-cell' + (idx === 0 ? ' is-today' : '') + '"><b>' + mdText(ds) +
          (idx === 0 ? '<em>今天</em>' : '') + '</b><span>周' + wd[dd.getDay()] + '</span></div>';
      }).join('');

    var totalCnt = 0;
    var out = [];
    lanes.forEach(function (lane, li) {
      if (NP_UI.channel && lane.channel !== NP_UI.channel) return;
      var color = NP_COLORS[li % NP_COLORS.length];
      var chips = [];
      (lane.products || []).forEach(function (p) {
        var s = p.raiseStart || p.raiseEnd;
        var e = p.raiseEnd || p.raiseStart;
        if (!s || !e || s > days[last]) return;
        // 起始取「首个 ≥ 募集起始」的日期列，结束取「最后一个 ≤ 募集结束」的日期列；
        // 募集期已结束（成立日在今天及以后）时整体贴到首列，避免被窗口裁掉
        var c1 = -1, c2 = -1;
        days.forEach(function (ds, idx) { if (c1 < 0 && ds >= s) c1 = idx; });
        for (var k = last; k >= 0; k--) { if (days[k] <= e) { c2 = k; break; } }
        if (c1 < 0) c1 = last;
        if (c2 < 0) c2 = 0;
        if (c2 < c1) { if (e < days[0]) { c1 = 0; c2 = 0; } else { c2 = c1; } }
        // 单日募集也至少占两列，避免产品名被压缩成省略号；右侧贴边时整体左移
        if (c2 - c1 + 1 < 2) {
          if (c1 + 1 > last) { c1 = Math.max(0, last - 1); c2 = last; }
          else { c2 = c1 + 1; }
        }
        chips.push({ p: p, c1: c1, c2: c2 });
        totalCnt++;
      });
      chips.sort(function (a, b) { return a.c1 - b.c1 || a.c2 - b.c2; });

      var rows = [];
      chips.forEach(function (ch) {
        var r = 0;
        for (; ; r++) {
          if (!rows[r]) rows[r] = [];
          var free = rows[r].every(function (x) { return ch.c2 < x[0] || ch.c1 > x[1]; });
          if (free) { rows[r].push([ch.c1, ch.c2]); ch.row = r; break; }
        }
      });

      var body = '<div class="org"><span class="dot"></span>' + lane.channel + '</div>';
      chips.forEach(function (ch) {
        var p = ch.p;
        var q = quotaText(p.quotaWan);
        var rk = (p.risk || '').toUpperCase();
        var tip = [p.name || p.short, p.regCode ? '登记编码 ' + p.regCode : '登记编码未披露',
          '募集 ' + (p.raiseStart ? mdText(p.raiseStart) : '—') + ' 至 ' + (p.raiseEnd ? mdText(p.raiseEnd) : '—'),
          '成立 ' + (p.establish ? mdText(p.establish) : '—'),
          rk ? rk : '风险等级未披露',
          q ? '额度 ' + q + ' 元' : '额度未披露',
          p.source ? '来源 ' + p.source : ''].filter(Boolean).join('｜');
        body += '<div class="nchip" style="grid-column:' + (ch.c1 + 2) + ' / span ' + (ch.c2 - ch.c1 + 1) +
          ';grid-row:' + (ch.row + 1) + '" title="' + tip.replace(/"/g, '&quot;') + '">' +
          '<span class="nr">' + mdText(p.raiseStart) + (p.raiseEnd && p.raiseEnd !== p.raiseStart ? '-' + mdText(p.raiseEnd) : '') + '</span>' +
          '<span class="nmid"><span class="nm">' + npShortName(p, lane.channel) + '</span>' +
          (q ? '<span class="na">' + q + '</span>' : '<span class="na na-none">—</span>') +
          (rk ? '<span class="rk' + (rk === 'R3' ? ' r3' : rk === 'R4' || rk === 'R5' ? ' r4' : '') + '">' + rk + '</span>' : '') +
          '</span><span class="ne">' + (p.establish ? mdText(p.establish) : '') + '</span></div>';
      });

      // 无新品日期：整列灰底占位（跨全部行）
      var covered = [];
      chips.forEach(function (ch) { for (var c = ch.c1; c <= ch.c2; c++) covered[c] = 1; });
      var g = 0;
      while (g < N) {
        if (covered[g]) { g++; continue; }
        var h = g;
        while (h + 1 < N && !covered[h + 1]) h++;
        body += '<span class="gapfill" style="grid-column:' + (g + 2) + ' / span ' + (h - g + 1) +
          ';grid-row:1/-1"><em>' + (chips.length ? '无新品' : '暂无已披露新品') + '</em></span>';
        g = h + 1;
      }

      var rowCount = Math.max(1, rows.length);
      out.push('<div class="ts-lane' + (rowCount > 1 ? ' two' : '') + '" data-org="' + lane.channel +
        '" style="--c:' + color + ';grid-template-columns:124px repeat(' + N + ',minmax(0,1fr))' +
        (rowCount > 1 ? ';grid-template-rows:repeat(' + rowCount + ',42px)' : '') + '">' +
        body + '</div>');
    });

    box.innerHTML = out.join('') || '<div class="ts-lane" style="--c:#0e5a73"><div class="org"><span class="dot"></span>暂无</div>' +
      '<span class="gapfill" style="grid-column:2/-1;grid-row:1/-1"><em>暂无已披露新品</em></span></div>';

    var tEl = document.getElementById('np-total');
    if (tEl) tEl.textContent = totalCnt;
    var oEl = document.getElementById('np-orgs');
    if (oEl) oEl.textContent = (NP_UI.channel ? 1 : lanes.length);
    var sEl = document.getElementById('np-src');
    if (sEl && NP.source) sEl.textContent = '数据源：' + NP.source;

    var sel = document.getElementById('np-org-sel');
    if (sel) sel.onchange = function () { NP_UI.channel = this.value; renderNewProds(); };
  }

  function renderAll() {
    refreshAggregate();
    updatePickerLabel();
    renderPickerList();
    renderProfitTable();
    resetCalendarMonth();
    renderCalendar();
    renderTrend();
    renderProductTable();
    populateOrgSelect();
    renderTradeSummary();
    populateFlowSelects();
    renderFlows();
    renderNewProds();
  }

  function applySelection() {
    refreshAggregate();
    updatePickerLabel();
    renderProfitTable();
    resetCalendarMonth();
    renderCalendar();
    renderTrend();
    if (window.__syncPickerToggle) window.__syncPickerToggle();
  }

  function initPicker() {
    var trigger = document.getElementById('ms-trigger');
    var panel = document.getElementById('ms-panel');
    var list = document.getElementById('ms-list');
    if (!trigger || !panel || !list) return;
    renderPickerList();
    updatePickerLabel();

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      if (panel.hidden) openPanel(); else closePanel();
    });
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { closePanel(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel();
    });

    list.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || t.type !== 'checkbox') return;
      var idx = selectedIds.indexOf(t.value);
      if (t.checked && idx === -1) {
        selectedIds.push(t.value);
      } else if (!t.checked && idx !== -1) {
        selectedIds.splice(idx, 1);
      }
      applySelection();
    });

    var search = document.getElementById('ms-search');
    if (search) search.addEventListener('input', function () {
      pickerQuery = search.value;
      renderPickerList();
    });

    var toggleBtn = panel.querySelector('[data-act="toggle"]');
    function syncPickerToggle() {
      if (!toggleBtn) return;
      var total = pickableProducts().length;
      var all = total > 0 && selectedIds.length >= total;
      toggleBtn.textContent = all ? '反选' : '全选';
    }
    window.__syncPickerToggle = syncPickerToggle;
    syncPickerToggle();
    if (toggleBtn) toggleBtn.addEventListener('click', function () {
      var ids = pickableProducts().map(function (p) { return p.id; });
      var all = selectedIds.length >= ids.length;
      selectedIds = all ? [] : ids;
      renderPickerList();
      applySelection();
      syncPickerToggle();
    });
  }

  /* ---------------- 手动更新数据 ---------------- */
  function rebuildAll(data) {
    if (!data || !Array.isArray(data.products) || !data.products.length) {
      throw new Error('数据为空');
    }
    DATA = data;
    window.REPORT_DATA = data;
    computeModel(data);
    computeLibrary();
    computeHoldings();

    var ids = pickableProducts().map(function (p) { return p.id; });
    syncPickerScope();
    if (!selectedIds.length && ids.length) selectedIds = ids.slice();

    refreshAggregate();
    updatePickerLabel();
    renderPickerList();
    renderProfitTable();
    resetCalendarMonth();
    renderCalendar();
    renderTrend();
    renderProductTable();
    populateOrgSelect();
    renderTradeSummary();
    populateFlowSelects();
    renderFlows();
    renderNewProds();
  }

  function bindRefresh() {
    var btn = document.getElementById('refresh-data');
    if (!btn) return;
    var labelEl = btn.querySelector('.update-label');
    var defaultLabel = labelEl ? labelEl.textContent : '数据抓取';
    var defaultTitle = '重新抓取全部产品的最新数据，并刷新所有模块';
    var timer = null;
    var prevAsOf = DATA.asOf;
    // file:// 下页面没有同源后端，指向本地服务；http 下走同源
    var API_BASE = location.protocol === 'file:' ? 'http://127.0.0.1:8765' : '';

    function settle(cls, text, detail) {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.classList.add(cls);
      if (labelEl) labelEl.textContent = text;
      btn.title = detail || defaultTitle;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        btn.classList.remove(cls);
        if (labelEl) labelEl.textContent = defaultLabel;
        btn.title = defaultTitle;
        timer = null;
      }, 4000);
    }

    // 用 script 标签重新加载数据文件，兼容 file:// 与静态托管；query 用于避开缓存
    function loadScript(urls, i, done) {
      if (i >= urls.length) { done(new Error('数据文件加载失败')); return; }
      var script = document.createElement('script');
      script.src = urls[i];
      script.onload = function () {
        if (script.parentNode) script.parentNode.removeChild(script);
        done(null);
      };
      script.onerror = function () {
        if (script.parentNode) script.parentNode.removeChild(script);
        loadScript(urls, i + 1, done);
      };
      document.head.appendChild(script);
    }

    function reloadData() {
      return new Promise(function (resolve, reject) {
        var t = '?t=' + Date.now();
        var urls = location.protocol === 'file:'
          ? ['assets/data.js', 'assets/newproducts.js', 'assets/risk_levels.js', 'assets/library.js']
          : ['assets/data.js' + t, 'assets/newproducts.js' + t, 'assets/risk_levels.js' + t, 'assets/library.js' + t];
        loadScript(urls, 0, function (err) {
          if (err) { reject(err); return; }
          try {
            rebuildAll(window.REPORT_DATA);
            resolve();
          } catch (e) { reject(e); }
        });
      });
    }

    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      prevAsOf = DATA.asOf;
      btn.disabled = true;
      btn.classList.remove('done', 'error');
      btn.classList.add('loading');
      if (labelEl) labelEl.textContent = '抓取中…';

      fetch(API_BASE + '/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      }).then(function (resp) {
        return resp.json().then(function (json) {
          return { status: resp.status, json: json || {} };
        });
      }).then(function (res) {
        var j = res.json;
        if (!j.ok) {
          var msg = j.message || '抓取失败，已保留原数据';
          settle('error', j.running ? '任务进行中' : '抓取失败', msg);
          if (window.console && console.warn) console.warn('[净值抓取失败]', j);
          return;
        }
        reloadData().then(function () {
          var n = j.failedCount || 0;
          var detail = '成功 ' + (j.success || 0) + '/' + (j.total || 0)
            + '，数据日期 ' + (j.dataDate || '—')
            + '，当日万收总计 ' + (j.totalPer10k === null || j.totalPer10k === undefined ? '—' : j.totalPer10k);
          if (n > 0) {
            detail += '\n失败产品（保留旧值）：' + (j.failed || []).map(function (f) {
              return f.short + '：' + f.error;
            }).join('；');
            if (window.console && console.warn) console.warn('[部分产品抓取失败]', j.failed);
            settle('error', '部分更新 ' + (j.success || 0) + '/' + (j.total || 0), detail);
          } else {
            settle('done', DATA.asOf === prevAsOf ? '已是最新' : '已更新', detail);
          }
        }).catch(function (err) {
          if (window.console && console.error) console.error('[数据重载失败]', err);
          settle('error', '更新失败', String((err && err.message) || err));
        });
      }).catch(function (err) {
        if (window.console && console.error) console.error('[抓取服务不可用]', err);
        settle('error', '服务未启动', '请在项目目录运行 python daily/serve.py 后重试；页面数据未变化。');
      });
    });
  }

  /* ---------------- init ---------------- */
  function init() {
    populateOrgSelect();
    initPicker();
    bindProfitSort();
    bindSumSort();
    bindDataFilter();
    bindRefresh();
    bindCalendar();
    bindTrend();
    bindProductFilters();
    bindTrade();
    bindTradeModal();
    initDatePicker();
    bindAddModal();
    renderAll();

    var wasCompact = (window.innerWidth || 1200) < 480;
    window.addEventListener('resize', function () {
      if (trendChart) trendChart.resize();
      var nowCompact = (window.innerWidth || 1200) < 480;
      if (nowCompact !== wasCompact) { wasCompact = nowCompact; renderCalendar(); }
    });
  }

  /* 云端后台刷新完成后由页面调用，重新计算持仓并重绘（等首屏 init 完成后再跑） */
  function refreshFromStore() {
    function run() {
      mergeManualProducts();
      computeHoldings();
      syncPickerScope();
      renderAll();
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(run, 0); });
    } else {
      setTimeout(run, 0);
    }
  }
  window.DASHBOARD_REFRESH = refreshFromStore;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
