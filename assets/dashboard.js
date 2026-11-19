(function () {
  var DATA = window.REPORT_DATA;
  if (!DATA || !Array.isArray(DATA.products)) return;

  var DAY = 86400000;
  var THUMB_UP = '👍';
  var THUMB_DOWN = '👎';

  /* 披露节奏红色角标（+N）：净值日 T 的净值为何晚于 T+1 披露，按登记编码人工核定后登记到这里，
     优先级高于自动推断。格式：'登记编码': N（工作日）。未登记的产品走 disclosureLagOf 的自动推断。
     口径与 PDF 一致：+N 表示净值披露节奏（T 日净值于 T+N 工作日披露），与份额确认 T+1/T+2 无关；
     周频/停止更新的产品不标注。 */
  var DISCLOSURE_LAG_OVERRIDE = {
    /* 例：'Z7001926001090': 2  // 中邮鸿锦7天45号：说明书约定 T+2 披露 */
  };

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
    /* 成交净值按申购日（T 日）：T 日净值已披露即可确认，不要求确认日净值披露 */
    var navDay = t.applyDate || d;
    if (p && p.latestDate && navDay > p.latestDate) return '在途';
    return '已确认';
  }

  function txPendingReason(t) {
    var d = t.confirmDate || t.applyDate;
    if (d > isoDate(new Date())) return '确认日期未到，净值未披露';
    var p = findProductById(t.pid);
    var navDay = t.applyDate || d;
    if (p && p.latestDate && navDay > p.latestDate) return '申购日净值尚未披露';
    return '';
  }

  /* 当前可卖份额：只认已确认的持仓，已清仓为 0 */
  function sellableShares(pid) {
    var map = HOLD_BY_PID || {};
    var h = map[canonicalPidById(pid)] || map[pid];
    return h && h.shares > 0.000001 ? h.shares : 0;
  }

  /* 是否已有在途清仓单（确认日未到或净值未披露），避免重复清仓 */
  function hasPendingClear(pid) {
    var items = (window.TRANSACTIONS && window.TRANSACTIONS.items) || [];
    return items.some(function (t) {
      return samePid(t.pid, pid) && t.type === '清仓' && txStatus(t) === '在途';
    });
  }

  /* 是否有任意在途交易（申购/赎回/清仓），与交易流水的「在途」状态联动 */
  function hasInflightTx(pid) {
    var items = (window.TRANSACTIONS && window.TRANSACTIONS.items) || [];
    return items.some(function (t) {
      return samePid(t.pid, pid) && txStatus(t) === '在途';
    });
  }

  /* 产品在指定日期披露的净值，未披露返回 null */
  function navOnDate(p, date) {
    if (!p || !p.dates || !date) return null;
    var i = p.dates.indexOf(date);
    return i === -1 ? null : p.nav[i];
  }

  /* 确认日成交净值：当日已披露直接取；未披露时取确认日之后最近一日，
     都没有才回落到最新净值（即「确认日已到、净值未披露」按最新净值估算） */
  function navForConfirm(p, date) {
    if (!p || !p.nav || !p.nav.length) return null;
    var v = navOnDate(p, date);
    if (v !== null) return v;
    if (!date) return p.nav[p.nav.length - 1];
    for (var i = 0; i < p.dates.length; i++) {
      if (p.dates[i] > date && typeof p.nav[i] === 'number') return p.nav[i];
    }
    for (var j = p.dates.length - 1; j >= 0; j--) {
      if (p.dates[j] < date && typeof p.nav[j] === 'number') return p.nav[j];
    }
    return p.nav[p.nav.length - 1];
  }

  /* 确认日成交净值：只认交易已记录的净值，或确认日当天已披露的净值；未披露返回 0（显示「待确认」） */
  function txConfirmNav(t, p) {
    var v = Number(t.confirmNav);
    if (v > 0) return v;
    /* 与录入表单口径一致：成交净值取申购日（T 日）净值；T 日缺失时兼容旧数据取确认日 */
    var n = navOnDate(p, t.applyDate || t.confirmDate);
    if (!(typeof n === 'number' && n > 0)) n = navOnDate(p, t.confirmDate);
    return typeof n === 'number' && n > 0 ? n : 0;
  }

  /* 交易份额：未记录时按成交净值折算；净值未披露返回 null（显示为 —） */
  function txShares(t, p) {
    var sh = Number(t.shares);
    if (sh > 0) return sh;
    var nav = txConfirmNav(t, p);
    var amt = Number(t.amount) || 0;
    return (nav > 0 && amt > 0) ? amt / nav : null;
  }

  /* 交易金额：未记录时按份额 × 成交净值折算；净值未披露返回 null（显示「待确认」，披露后自动更新） */
  function txAmount(t, p) {
    var amt = Number(t.amount);
    if (amt > 0) return amt;
    var sh = Number(t.shares);
    var nav = txConfirmNav(t, p);
    return (sh > 0 && nav > 0) ? sh * nav : null;
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

  /* 真实成立日：产品成立日 ≠ 首个净值日（成立日通常早 1 天，募集结束次日成立、次日起披露净值）。
     优先级：产品库（说明书要素抓取）成立日 > 数据里的 inception > 首个净值日；
     且成立日不可能晚于首个净值日，晚于则视为脏数据回退首净值日，避免出现"成立晚于净值"。 */
  function inceptionDateOf(p) {
    if (!p) return '';
    var first = p.dates && p.dates.length ? p.dates[0] : '';
    var libInc = '';
    if (p.regCode) {
      var items = (typeof PRODUCT_LIBRARY !== 'undefined' && PRODUCT_LIBRARY.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].regCode === p.regCode) { libInc = items[i].inception || ''; break; }
      }
    }
    var cand = libInc || p.inception || first;
    if (first && cand > first) cand = first;
    return cand || first || '';
  }

  /* 成立天数：真实成立日到今天（当日）的自然日数 */
  function listingDaysOf(p) {
    if (!p || p.manual) return null;
    var start = inceptionDateOf(p);
    if (!start) return null;
    var d = dayDiff(parseDate(start), parseDate(isoDate(new Date())));
    return d >= 0 ? d : null;
  }

  function mmdd(s) {
    return s ? s.slice(5) : '—';
  }

  /* 两个工作日之间相隔的工作日数（周一~周五），用于按净值日推断披露节奏 lag。
     a=净值日、b=基准日，返回 (a,b] 区间内的工作日天数；b 为周末时不计入。 */
  function workdayGap(a, b) {
    if (!a || !b) return 0;
    var s = parseDate(a), e = parseDate(b), n = 0;
    if (s > e) return 0;
    s = new Date(s.getTime() + DAY);
    while (s <= e) {
      var wd = s.getDay();
      if (wd !== 0 && wd !== 6) n += 1;
      s = new Date(s.getTime() + DAY);
    }
    return n;
  }

  /* 找到产品对应的「持仓产品对象」（data.js 来源）。持有产品统一以持仓对象为准判定 lag，
     这样盈亏汇总/持仓汇总/产品库对同一产品结论一致，不受各自数据源 asOf/净值日不同步影响。
     非持仓产品、已清仓产品返回 null（按需求：仅对当前持仓产品标识 +N）。 */
  function heldProductOf(p) {
    if (!p) return null;
    var keys = Object.keys(HOLD_BY_PID);
    for (var i = 0; i < keys.length; i++) {
      var h = HOLD_BY_PID[keys[i]];
      if (h.cleared) continue;
      var hp = h.product;
      if (hp === p) return hp;
      if (p.regCode && hp.regCode && p.regCode === hp.regCode) return hp;
      if (p.id && hp.id && samePid(p.id, hp.id)) return hp;
    }
    return null;
  }

  /* 产品披露节奏 lag（工作日）：+2 表示净值日 T 的净值在 T+2 工作日才披露。
     ① 仅对当前持仓产品标识（heldProductOf），不限模块；非持仓/已清仓不标。
     ② 登记编码在 DISCLOSURE_LAG_OVERRIDE 中 → 用人工核定值（最高优先）。
     ③ 否则自动推断：统一用持仓产品的净值日相对看板抓取当天 DATA.asOf 的工作日差。
        恰好 2 个工作日才标 +2：1 个是正常 T+1，≥3 多为周频/停止更新（按 PDF 规则不标注）。
     ④ 无净值日/新品（净值序列<2）不标注。 */
  function disclosureLagOf(p) {
    var hp = heldProductOf(p);
    if (!hp) return 0;
    var reg = hp.regCode || '';
    if (DISCLOSURE_LAG_OVERRIDE[reg]) return DISCLOSURE_LAG_OVERRIDE[reg];
    var latest = hp.latestDate || (hp.dates && hp.dates.length ? hp.dates[hp.dates.length - 1] : '');
    if (!latest) return 0;
    var gap = workdayGap(latest, DATA.asOf || '');
    return gap === 2 ? 2 : 0;
  }

  /* 净值日期单元格的红色 +N 角标 HTML（N=2 时显示 +2）。无 lag 返回空串。 */
  function navLagBadge(p) {
    var lag = disclosureLagOf(p);
    if (!lag) return '';
    return '<sup class="nav-lag" title="净值披露节奏：净值日 T 的净值于 T+' + lag +
      ' 个工作日披露">+' + lag + '</sup>';
  }

  /* 角标 absolute 需要一个 positioned 锚点；仅当确有角标时包裹，避免无谓 DOM 变化。
     锚点宽度只等于文本本身，角标浮于右上角，日期/数值的居中对齐不再被角标挤偏。 */
  function withBadge(text, badge) {
    return badge ? '<span class="lag-anchor">' + text + badge + '</span>' : text;
  }

  function calc(p) {
    var n = p.dates.length;
    var latest = parseDate(p.dates[n - 1]);
    var incep = parseDate(p.dates[0]);
    var days = dayDiff(incep, latest);
    var sinceAnn = (p.nav[n - 1] / p.nav[0] - 1) * 365 / days * 100;
    /* 今日万收统一为市值口径（每万元市值当日收益 = 每万份收益 ÷ 昨日净值）。
       份额在分子分母中约掉，故无持仓的产品库产品同样可算；per10k 缺失时退回净值差。 */
    var prevNav0 = p.nav[n - 2];
    var lastPer0 = p.per10k && p.per10k.length ? p.per10k[n - 1] : null;
    var todayPer = prevNav0 > 0
      ? (lastPer0 !== null && lastPer0 !== undefined ? lastPer0 / prevNav0 : (p.nav[n - 1] - prevNav0) / prevNav0 * 10000)
      : null;
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
        /* 日均万收统一为市值口径：收益 ÷ 起始市值 × 10000 ÷ 天数 = ret*10000/span，
           与年化(ret*365/span*100)严格自洽：日均万收 × 3.65 = 年化%。 */
        per: ret * 10000 / span,
        ann: ret * 365 / span * 100,
        span: span,
        start: p.dates[idx],
        fallback: fallback
      };
    });
    return {
      latestDate: p.dates[n - 1],
      latestNav: p.nav[n - 1],
      /* 展示用成立日取真实成立日；收益/年化的区间起点仍用首净值日 p.dates[0]（上面 days/sinceAnn） */
      inception: inceptionDateOf(p),
      navStart: p.dates[0],
      days: days,
      sinceAnn: sinceAnn,
      todayPer: todayPer,
      windows: windows
    };
  }

  var MODEL = [];
  var HOLDINGS = [];
  var HOLD_BY_PID = {};

  /* 双源净值对齐：同一登记编码在产品库(library)与持仓底稿(data.js)用不同 id，
     抓取链路可能只在 library 更新到 T-1、data.js 仍停在 T-2。这里在建模前按
     regCode 把 library 中较新的净值点补进 data.products，让指标/日历/收益都
     基于同一份最新数据；只追加更新的点，不回退，共有日净值不一致则跳过该产品。 */
  function alignNavFromLibrary(data) {
    var lib = (window.PRODUCT_LIBRARY && window.PRODUCT_LIBRARY.items) || [];
    if (!lib.length || !data || !Array.isArray(data.products)) return;
    var byReg = Object.create(null);
    lib.forEach(function (it) {
      if (!it || !it.regCode) return;
      var k = String(it.regCode);
      if (!byReg[k] || String(it.latestDate || '') > String(byReg[k].latestDate || '')) byReg[k] = it;
    });
    data.products.forEach(function (p) {
      if (!p || !p.regCode) return;
      var src = byReg[String(p.regCode)];
      if (!src || !src.dates || !src.nav) return;
      var sdate = String(src.latestDate || (src.dates.length ? src.dates[src.dates.length - 1] : ''));
      var ddate = String(p.latestDate || (p.dates && p.dates.length ? p.dates[p.dates.length - 1] : ''));
      if (!sdate || sdate <= ddate) return;
      if (!p.dates || !p.nav || p.dates.length !== p.nav.length) return;
      /* 共有日期净值必须一致，否则视为两套口径，跳过避免污染 */
      var dmap = Object.create(null);
      p.dates.forEach(function (d, i) { dmap[d] = p.nav[i]; });
      for (var j = 0; j < src.dates.length; j++) {
        if (dmap[src.dates[j]] !== undefined &&
            Math.abs(Number(dmap[src.dates[j]]) - Number(src.nav[j])) > 0.000001) return;
      }
      var pers = p.per10k || [];
      var sn = src.per10k || [];
      for (var i2 = 0; i2 < src.dates.length; i2++) {
        var d2 = src.dates[i2];
        if (d2 <= ddate) continue;
        p.dates.push(d2);
        p.nav.push(Math.round(Number(src.nav[i2]) * 1000000) / 1000000);
        pers.push(sn[i2] !== null && sn[i2] !== undefined ? Math.round(Number(sn[i2]) * 100) / 100 : null);
      }
      p.per10k = pers;
      p.latestDate = sdate;
      p.latestNav = p.nav[p.nav.length - 1];
    });
  }

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
  alignNavFromLibrary(DATA);
  computeModel(DATA);

  // 产品库扩容数据：8.1 后成立的产品（真实抓取，仅用于产品库展示）
  var LIB_MODEL = [];
  function computeLibrary() {
    var lib = (window.PRODUCT_LIBRARY && window.PRODUCT_LIBRARY.items) || [];
    var blank = { per: null, ann: null, fallback: false };
    LIB_MODEL = lib.filter(function (p) {
      return !!p;
    }).map(function (p) {
      /* 尚无净值（或仅有 1 条）的新品也展示，净值与区间指标显示「待披露」 */
      if (!p.nav || !p.dates || p.dates.length < 2) {
        return {
          product: p,
          pending: true,
          m: {
            latestDate: p.latestDate || '',
            latestNav: p.latestNav != null ? p.latestNav : null,
            inception: p.inception || '', days: 0, sinceAnn: null, todayPer: null,
            windows: [blank, blank, blank, blank, blank, blank]
          }
        };
      }
      p.dailyAnn = p.nav.map(function (v, i) {
        if (i === 0) return null;
        return (v / p.nav[i - 1] - 1) * 365 * 100;
      });
      var mm = calc(p);
      if (p.manual) {
        /* 手工产品没有「成立日期」，不展示首条净值日冒充成立日 */
        mm.inception = '';
      }
      return { product: p, m: mm };
    });
    window.DASHBOARD_LIBRARY = LIB_MODEL;
  }
  computeLibrary();

  /* 手工产品正式入库后，旧手工 id -> 正式产品 id 的别名映射。
     历史交易可能仍引用手工 id，靠登记编码桥接让它们联动到正式产品 */
  var PID_ALIAS = {};

  /* 全站统一身份：登记编码(Z7)优先，正式持仓数据 > 正式产品库 > 手工产品。
     同一 Z7 在持仓/交易/筛选/产品库必须归一到同一个 canonical id。 */
  var REG_CANONICAL = {};
  function buildCanonicalIds() {
    REG_CANONICAL = {};
    function reg(p, priority) {
      if (!p || !p.regCode || !p.id) return;
      var old = REG_CANONICAL[p.regCode];
      if (!old || priority < old.priority) REG_CANONICAL[p.regCode] = { id: p.id, priority: priority };
    }
    (DATA.products || []).forEach(function (p) { reg(p, 0); });
    var libItems = (window.PRODUCT_LIBRARY && window.PRODUCT_LIBRARY.items) || [];
    libItems.forEach(function (p) { if (!p.manual) reg(p, 1); });
    libItems.forEach(function (p) { if (p.manual) reg(p, 2); });
    /* 所有非 canonical id（含旧交易引用的 LZ… 与手工 id）都登记为别名 */
    (DATA.products || []).concat(libItems).forEach(function (p) {
      if (!p || !p.regCode || !p.id) return;
      var c = REG_CANONICAL[p.regCode];
      if (c && c.id !== p.id) PID_ALIAS[p.id] = c.id;
    });
  }
  buildCanonicalIds();

  function canonicalPidById(pid) {
    var id = pid, guard = 0;
    while (PID_ALIAS[id] && guard++ < 8) id = PID_ALIAS[id];
    return id;
  }
  function canonicalPid(p) {
    if (!p) return '';
    if (p.regCode && REG_CANONICAL[p.regCode]) return REG_CANONICAL[p.regCode].id;
    return canonicalPidById(p.id);
  }
  function samePid(a, b) {
    if (a === b) return true;
    var ca = canonicalPidById(a), cb = canonicalPidById(b);
    return !!ca && ca === cb;
  }
  window.REG_CANONICAL_IDS = (function () {
    var o = {};
    Object.keys(REG_CANONICAL).forEach(function (k) { o[k] = REG_CANONICAL[k].id; });
    return o;
  })();

  /* 手工添加的产品（云端 MANUAL_PRODUCTS）合并进产品库，按 id 去重 */
  function manualToProduct(m) {
    if (!m || !m.id || !m.name) return null;
    var date = m.navDate || '';
    var nav = Number(m.nav);
    /* 每日自动抓取会回填 history（[{date, nav}]），有多点时用于区间收益计算 */
    var hist = (m.history || []).filter(function (h) {
      return h && h.date && Number(h.nav) > 0;
    }).slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
    var dates = hist.length ? hist.map(function (h) { return h.date; }) : (date ? [date] : []);
    var navs = hist.length ? hist.map(function (h) { return Number(h.nav); }) : (date && nav > 0 ? [nav] : []);
    if (date && nav > 0 && (!dates.length || dates[dates.length - 1] < date)) {
      dates = dates.concat([date]);
      navs = navs.concat([nav]);
    }
    return {
      id: m.id,
      name: m.name,
      short: m.name,
      org: m.org || '',
      orgShort: orgShort(m.org || '') || '手工添加',
      regCode: m.regCode || '',
      risk: m.risk || '',
      saleChannel: m.saleChannel || '',
      link: m.link || '',
      inception: '',
      raiseStart: '', raiseEnd: '',
      dates: dates,
      nav: navs,
      per10k: dates.map(function () { return null; }),
      latestDate: dates[dates.length - 1] || date,
      latestNav: navs[navs.length - 1] || null,
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
    var formalByReg = {};
    items.forEach(function (p) {
      seen[p.id] = 1;
      if (p.regCode) { seen['R:' + p.regCode] = 1; formalByReg[p.regCode] = p.id; }
    });
    list.forEach(function (m) {
      var p = manualToProduct(m);
      if (!p || seen[p.id]) return;
      /* 正式库已按登记编码收录的产品，不再重复显示手工条目（正式数据更全）。
         但要把手工 id 记入别名表，让引用旧 id 的历史交易仍能联动到正式产品 */
      if (p.regCode && seen['R:' + p.regCode]) {
        var canon = REG_CANONICAL[p.regCode];
        if (canon) PID_ALIAS[p.id] = canon.id;
        else if (formalByReg[p.regCode]) PID_ALIAS[p.id] = formalByReg[p.regCode];
        return;
      }
      seen[p.id] = 1;
      if (p.regCode) {
        seen['R:' + p.regCode] = 1;
        if (!REG_CANONICAL[p.regCode]) {
          REG_CANONICAL[p.regCode] = { id: p.id, priority: 2 };
          window.REG_CANONICAL_IDS[p.regCode] = p.id;
        }
      }
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
    var pool = tradeProducts();
    /* 历史交易可能引用旧手工 id 或产品库的 LZ… id：先归一到 canonical id 再找 */
    var id = canonicalPidById(pid);
    var hit = pool.filter(function (p) { return p.id === id; })[0];
    if (!hit && id !== pid) hit = pool.filter(function (p) { return p.id === pid; })[0];
    return hit || null;
  }

  // 产品库中已产生交易的产品，纳入统计与盈亏明细
  function libHeldProducts() {
    return LIB_MODEL.filter(function (x) { return !!HOLD_BY_PID[x.product.id]; })
      .map(function (x) { return x.product; });
  }

  /* 截至某净值日已起息的份额：只累计起息日 <= 该净值日的批次。
     银行规则：份额自确认日（T+1）当日净值起享有收益，此前净值涨跌不归属该批次。 */
  function vestedShares(lots, navDate) {
    if (!lots || !lots.length || !navDate) return 0;
    var s = 0;
    for (var i = 0; i < lots.length; i++) {
      if (lots[i].date <= navDate) s += lots[i].shares;
    }
    return s;
  }

  /* 组合现金流（只记与持仓同口径的已生效交易）：申购为负、赎回/清仓为正。
     供「累计收益年化（XIRR）」使用，口径与持仓计算保持完全一致。 */
  var PORTFOLIO_FLOWS = [];

  /* 累计收益年化 = XIRR：把组合全部已生效现金流按实际发生日折现，
     求净现值为 0 的内部收益率。与「持仓年化」的区别是它把已落袋收益、
     分批投入的时点、中途赎回都计入，是真正意义上的「这笔钱从入场到现在的年化」。 */
  function portfolioXirr(endValue, endDate, keepPid) {
    var flows = PORTFOLIO_FLOWS.filter(function (f) {
      return !keepPid || keepPid[f.pid];
    });
    if (!flows.length || !endDate) return null;
    if (endValue > 0) flows.push({ d: endDate, v: endValue });
    flows.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
    var t0 = flows[0].d;
    var pos = 0, neg = 0;
    flows.forEach(function (f) { if (f.v > 0) pos += f.v; else neg -= f.v; });
    /* 只有投入没有回收（或反之）时无解，直接返回空 */
    if (!(pos > 0) || !(neg > 0)) return null;
    function npv(r) {
      var s = 0;
      for (var i = 0; i < flows.length; i++) {
        s += flows[i].v / Math.pow(1 + r, dayDiff(parseDate(t0), parseDate(flows[i].d)) / 365);
      }
      return s;
    }
    /* NPV 随 r 单调递减，二分即可；区间下界贴近 -100%，上界 1000% 足够覆盖 */
    var lo = -0.9999, hi = 10, mid = 0;
    for (var k = 0; k < 200; k++) {
      mid = (lo + hi) / 2;
      if (npv(mid) > 0) lo = mid; else hi = mid;
      if (hi - lo < 1e-10) break;
    }
    return isFinite(mid) ? mid * 100 : null;
  }

  // 交易底稿 → 持仓：申购累加份额，赎回/清仓按确认净值扣减，起息日 = 首次确认日
  function computeHoldings() {
    var tx = ((window.TRANSACTIONS && window.TRANSACTIONS.items) || []).slice();
    var cashFlows = [];
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
        var pp0 = findProductById(t.pid);
        var knownNav = Number(t.confirmNav) || (pp0 ? navForConfirm(pp0, t.applyDate || t.confirmDate) : 0) || 0;
        /* 赎回/清仓在净值披露前不落地，避免用占位净值算出错误收益；净值抓取到后自动生效 */
        if (!(t.type === '清仓' && knownNav > 0 && cd && cd <= todayStr)) return;
      }
      var p = findProductById(t.pid);
      if (!p) return;
      var rec = acc[p.id];
      if (!rec) rec = acc[p.id] = { product: p, shares: 0, cost: 0, invested: 0, realized: 0, startDate: null, lots: [], lastTx: t };
      /* 成交净值缺失时按确认日净值兜底，净值披露后自动生效 */
      var nav = Number(t.confirmNav) || navForConfirm(p, t.applyDate || t.confirmDate) || 1;
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
        /* 赎回款：整笔赎回优先用底稿金额（银行实际到账），部分赎回按成交净值折算 */
        var proceeds = (sell >= sh - 1e-6 && Number(t.amount) > 0) ? Number(t.amount) : sell * nav;
        cashFlows.push({ d: t.confirmDate || t.applyDate, v: proceeds, pid: p.id });
        /* 赎回/清仓按先进先出扣减份额批次，保证剩余批次的起息日归属正确 */
        var remain = sell;
        for (var li = 0; li < rec.lots.length && remain > 1e-9; li++) {
          var take = Math.min(rec.lots[li].shares, remain);
          rec.lots[li].shares -= take;
          remain -= take;
        }
        rec.lots = rec.lots.filter(function (l) { return l.shares > 1e-9; });
      } else {
        /* 清仓后重新申购：起息日按本次确认日重新计算 */
        if (!(rec.shares > 0.000001)) rec.startDate = t.confirmDate;
        /* 每笔买入记为独立份额批次，起息日 = 该笔确认日（T+1）。
           银行规则：T 日按 T 日净值成交、T+1 确认起息；一批份额的收益从
           「确认日当日净值」开始归属，确认日之前的净值涨跌与其无关。 */
        rec.lots.push({ date: t.confirmDate || t.applyDate, shares: sh });
        rec.shares += sh;
        var paid = Number(t.amount) || sh * nav;
        rec.cost += paid;
        /* 累计投入：累计收益率的分母（含已赎回部分本金） */
        rec.invested += paid;
        cashFlows.push({ d: t.confirmDate || t.applyDate, v: -paid, pid: p.id });
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
      /* 持仓天数按建行理财口径：持仓天数 = t 日 − 起息日（t 日 = 今天）。
         起息日 = 份额确认日（T 日申购按 T 日净值成交，T+1 确认份额并起息）。
         确认日早于产品首个净值日时（新发产品成立当天确认、次日起才有净值），
         起息日按首个净值日计：产品没有净值的日子不可能产生收益，也不能算进持有期。
         例：信银安盈象14天165号 08-25 成立并确认、08-26 首个净值日，
         持仓天数按 08-26 起算（84 天），与建行 App 一致；成立天数仍按 08-25 算（85 天）。
         年化分母另用「计息天数 = 最新净值日 − 起息日」：收益只覆盖到最新净值日，
         若拿今天当分母，会把尚未披露收益的那一天也算进持有期、系统性低估年化。 */
      var accrualEnd = p.latestDate || todayStr;
      var daysStart = rec.startDate;
      /* 起息日下限取「产品成立日」，不再用「首个净值日」截断：
         募集期认购的份额自成立日当天起息，首净值日常常晚 1 天
         （信银安盈象14天165号 08-25 成立并确认、08-26 才披露首净值），
         用首净值日截断会系统性少算 1 天。成立日仍晚于确认日的脏数据以成立日为准，
         避免把募集期算进持有期。 */
      var incep = inceptionDateOf(p);
      if (incep && daysStart && daysStart < incep) daysStart = incep;
      var days = alive ? Math.max(0, dayDiff(parseDate(daysStart), parseDate(todayStr))) : 0;
      var accrualDays = alive ? Math.max(0, dayDiff(parseDate(daysStart), parseDate(accrualEnd))) : 0;
      var costNav = alive ? rec.cost / rec.shares : 0;
      var lastPer = p.per10k[n - 1];
      /* 「持仓收益」只算当前仍持有份额的盈亏（市值 − 剩余成本），与建行 App 口径一致；
         已赎回部分落袋的收益归入「累计收益」，两列并列展示。
         因此收益率、年化的分子都用持仓收益、分母都用当前持仓成本，三者自洽。 */
      var invested = rec.invested > 0 ? rec.invested : rec.cost;
      var unrealized = mv - rec.cost;
      /* 今日收益按「截至最新净值日已起息的份额」计算（而非全部持仓份额）：
         追加申购的新份额在自身确认日之前不产生收益，避免把未起息份额算进当日收益。 */
      var incomeShares = alive ? vestedShares(rec.lots, p.latestDate) : 0;
      var incomePending = !(incomeShares > 1e-9) || lastPer === null || lastPer === undefined;
      var h = {
        tx: rec.lastTx,
        product: p,
        shares: rec.shares,
        cost: rec.cost,
        costNav: costNav,
        latestNav: latestNav,
        latestDate: p.latestDate,
        startDate: rec.startDate,
        /* 实际起息日：首次确认日，但不早于产品成立日 */
        effStartDate: daysStart,
        mv: mv,
        /* profit = 累计收益（持仓收益 + 已赎回已实现）；unrealized = 持仓收益 */
        profit: profit,
        realized: rec.realized,
        unrealized: unrealized,
        invested: invested,
        profitRate: rec.cost > 0 ? unrealized / rec.cost * 100 : null,
        ann: (accrualDays > 0 && rec.cost > 0) ? unrealized / rec.cost * 365 / accrualDays * 100 : null,
        days: days,
        accrualDays: accrualDays,
        income: incomePending ? 0 : lastPer * incomeShares / 10000,
        incomeShares: incomeShares,
        incomePending: incomePending,
        lots: rec.lots,
        cleared: !alive
      };
      HOLDINGS.push(h);
      HOLD_BY_PID[p.id] = h;
    });
    /* 同步对外暴露的引用：computeHoldings 会整体重建数组，旧引用会一直指向过期数据 */
    window.DASHBOARD_HOLDINGS = HOLDINGS;
    PORTFOLIO_FLOWS = cashFlows;
  }
  computeHoldings();

  // 当前选中的产品（顶部“覆盖产品”多选）
  /* 顶部产品多选的可选范围：与「交易汇总」联动，列出汇总中的全部产品（含当日清仓、在途申购） */
  function pickableProducts() {
    var seen = {};
    var out = [];
    summaryRows().forEach(function (r) {
      var p = r && r.product;
      if (!p || !p.id || seen[p.id]) return;
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

  /* 顶部「覆盖产品」是全站筛选：选中全部代表不收窄（产品库/历史流水仍展示全量产品），
     只勾选部分产品时，交易汇总、交易流水、产品库都必须同步收窄到这几种产品。 */
  function inGlobalScope(pid) {
    var total = pickableProducts().length;
    if (selectedIds.length >= total) return true;
    var p = findProductById(pid);
    var canon = p ? canonicalPid(p) : canonicalPidById(pid);
    return selectedIds.indexOf(canon) !== -1 || selectedIds.indexOf(pid) !== -1;
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
        /* 历史每日收益按「当日已起息份额」计算：多笔买入时，各批次从自身确认日起
           才参与收益，避免用当前总份额回溯计算导致历史收益虚高。 */
        var shOnDay = h.lots ? vestedShares(h.lots, dt) : (dt < h.startDate ? 0 : h.shares);
        if (!(shOnDay > 1e-9)) continue;
        var cum = (p.nav[i] - h.costNav) * shOnDay;
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
    /* 每个披露点对应的收益区间 = 上一个披露点 → 当前披露点（首个点区间为 0 天）。
       记录期初日期与自然日间隔，供月/年/趋势统一按自然日口径摊销收益。 */
    var prevDates = dates.map(function (d, i) { return i ? dates[i - 1] : d; });
    var gaps = dates.map(function (d, i) {
      return Math.max(1, dayDiff(parseDate(prevDates[i]), parseDate(d)));
    });
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
      /* 单日年化也要除以该收益实际跨越的自然日数，否则周末/节假日的合并涨幅会被高估 */
      ann: dates.map(function (d, i) {
        return prevs[d] > 0 ? Math.round(sums[d] / prevs[d] * 365 / gaps[i] * 100 * 100) / 100 : null;
      }),
      prevMv: dates.map(function (d) { return prevs[d]; }),
      prevDates: prevDates,
      gaps: gaps,
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
    return v === null || v === undefined || isNaN(v) ? '—' : v.toFixed(2);
  }

  /* 带符号两位小数：正数显示 +，负数自带 -，0 不带符号 */
  function fmtSigned2(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(2);
  }

  function fmtSigned(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(2);
  }

  function fmtAnn(v) {
    return v === null || v === undefined || isNaN(v) ? '—' : v.toFixed(2) + '%';
  }

  function fmtNav(v) {
    return v === null || v === undefined || isNaN(v) ? '—' : v.toFixed(6);
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
    if (v === null || v === undefined || isNaN(v)) return '—';
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

    var today = 0, todayCnt = 0, todayBase = 0;
    hs.forEach(function (h) {
      var p = h.product;
      if (h.income !== null) { today += h.income; todayCnt += 1; }
      /* 今日万收与「本月日均万收」「盈亏日历日均万收」统一为组合市值加权口径：
         组合万收 = 组合当日收益(元) ÷ 组合前一日市值(元) × 10000。
         原口径对各产品 per10k 做等权算术平均（小市值产品与大市值产品同权），
         既与市值加权的组合表现不符，也无法与「今日收益(元)」互相换算。
         分子只统计已起息在持产品的收益，分母用同一批产品的昨日市值，避免
         清仓/未起息产品进分母稀释组合万收。 */
      if (h.cleared || h.incomePending) return;
      var n = p.per10k.length;
      if (n >= 2 && p.nav && p.nav[n - 2] > 0) {
        todayBase += (h.incomeShares || h.shares) * p.nav[n - 2];
      }
    });
    var avg = todayBase > 0 ? today / todayBase * 10000 : null;

    /* 昨日收益 = 前一净值日的当日收益：每万份收益 per10k[n-2] × 当日已起息份额 ÷ 10000。
       昨日万收与今日同口径（市值加权）= 昨日收益 ÷ 前一日市值(nav[n-3]) × 10000。
       份额用昨日净值日的已起息份额（vestedShares），避免把当日追加/未起息份额算进昨日；
       清仓产品不计入。净值非每日披露时「昨日」即上一披露日。 */
    var yest = 0, yestCnt = 0, yestBase = 0;
    hs.forEach(function (h) {
      if (h.cleared) return;
      var p = h.product;
      var nn = p.nav.length;
      if (nn < 2) return;
      var prevPer = p.per10k ? p.per10k[nn - 2] : null;
      if (prevPer === null || prevPer === undefined) return;
      var prevDate = p.dates[nn - 2];
      var prevShares = h.lots ? vestedShares(h.lots, prevDate) : (prevDate < h.startDate ? 0 : h.shares);
      if (!(prevShares > 1e-9)) return;
      yest += prevPer * prevShares / 10000;
      yestCnt += 1;
      if (nn >= 3 && p.nav && p.nav[nn - 3] > 0) {
        yestBase += prevShares * p.nav[nn - 3];
      }
    });
    var yavg = yestBase > 0 ? yest / yestBase * 10000 : null;

    var ym = DATA.asOf.slice(0, 7);
    /* 本月日均万收必须与盈亏日历同口径：组合万收 = 当日收益 ÷ 前一日市值 × 10000，
       逐日折算后取平均。原先用各产品 per10k 简单算术平均（等权），与按市值加权的组合
       实际表现不符，导致看板 0.65 / 日历 0.61 对不上；现统一为市值加权口径。 */
    var month = 0, mCnt = 0;
    if (AGG) {
      AGG.dates.forEach(function (d, i) {
        if (d.indexOf(ym) !== 0) return;
        var v = AGG.raw ? AGG.raw[i] : AGG.per10k[i];
        if (v === null || v === undefined) return;
        month += v;
        mCnt += 1;
      });
    }
    /* 本月日均万收统一为自然日口径：本月收益 ÷ 期初市值 ÷ 区间实际自然日数。
       不再按披露点数量平均，避免周末/节假日不披露导致日均虚高。 */
    var mStats = AGG ? cumulativePeriodStats(AGG, ym + '-') : null;
    var mWanAvg = mStats ? mStats.avg : null;

    var cost = 0, holdProfit = 0, totalProfit = 0, mv = 0, invested = 0;
    hs.forEach(function (h) {
      cost += h.cost;
      holdProfit += (h.unrealized || 0);
      totalProfit += h.profit;
      mv += h.mv;
      invested += (h.invested > 0 ? h.invested : h.cost);
    });

    /* 持仓收益率 = 持仓收益 ÷ 当前持仓成本，与「持仓收益」同口径（不含已赎回部分）。
       累计收益只在指标卡提示里补充，不参与主数值。 */
    var profitRate = cost > 0 ? holdProfit / cost * 100 : null;

    /* 持仓年化 = 各产品年化按持仓市值加权（单产品年化仍按计息天数折算，
       组合层面即「这些钱当前的平均年化」，不被小市值产品等权拉偏） */
    var annW = 0, annMv = 0;
    hs.forEach(function (h) {
      if (h.ann === null || h.ann === undefined || !isFinite(h.ann)) return;
      if (!(h.mv > 0)) return;
      annW += h.ann * h.mv;
      annMv += h.mv;
    });
    var portAnn = annMv > 0 ? annW / annMv : null;

    var el = document.getElementById('metric-today');
    if (el) {
      el.innerHTML = todayCnt ? fmtSigned(today) + '<em>元</em>' : '—';
      el.className = 'v ' + colorBy(todayCnt ? today : null);
    }
    el = document.getElementById('metric-avg');
    if (el) {
      el.textContent = fmtSigned2(avg);
      el.className = colorBy(avg) || 'ink';
    }

    el = document.getElementById('metric-yest');
    if (el) {
      el.innerHTML = yestCnt ? fmtSigned(yest) + '<em>元</em>' : '—';
      el.className = 'v ' + colorBy(yestCnt ? yest : null);
    }
    el = document.getElementById('metric-yavg');
    if (el) {
      el.textContent = fmtSigned2(yavg);
      el.className = colorBy(yavg) || 'ink';
    }

    el = document.getElementById('metric-month');
    if (el) {
      el.innerHTML = mCnt ? fmtSigned(month) + '<em>元</em>' : '—';
      el.className = 'v ' + colorBy(mCnt ? month : null);
    }
    el = document.getElementById('metric-month-avg');
    if (el) {
      el.textContent = fmtSigned2(mWanAvg);
      el.className = colorBy(mWanAvg) || 'ink';
    }

    el = document.getElementById('metric-profit');
    if (el) {
      el.innerHTML = hs.length ? fmtSigned(holdProfit) + '<em>元</em>' : '—';
      el.className = 'v ' + colorBy(hs.length ? holdProfit : null);
      el.title = hs.length
        ? '持仓收益（仅当前持仓份额）= 市值 ' + fmtMoney(mv) + ' − 持仓成本 ' + fmtMoney(cost) +
          (Math.abs(totalProfit - holdProfit) >= 0.005 ? '；累计收益 ' + fmtSigned(totalProfit) + ' 元（含已赎回部分）' : '')
        : '';
    }
    el = document.getElementById('metric-momprofit');
    if (el) {
      el.textContent = profitRate === null ? '—'
        : (profitRate > 0 ? '+' : '') + profitRate.toFixed(2) + '%';
      el.className = colorBy(profitRate) || 'ink';
      el.title = profitRate === null ? ''
        : '持仓收益率 = 持仓收益 ' + fmtSigned(holdProfit) + ' 元 ÷ 当前持仓成本 ' + fmtMoney(cost) + ' 元' +
          (Math.abs(totalProfit - holdProfit) >= 0.005 ? '（累计收益 ' + fmtSigned(totalProfit) + ' 元，含已赎回部分）' : '');
    }
    /* 累计收益卡：主值 = 累计收益（含已赎回部分已实现），副标 = 累计年化（XIRR） */
    var cumEnd = '', cumPids = {};
    hs.forEach(function (h) {
      cumPids[h.product.id] = 1;
      if (h.latestDate && h.latestDate > cumEnd) cumEnd = h.latestDate;
    });
    var cumAnn = hs.length ? portfolioXirr(mv, cumEnd, cumPids) : null;
    el = document.getElementById('metric-cum');
    if (el) {
      el.innerHTML = hs.length ? fmtSigned(totalProfit) + '<em>元</em>' : '—';
      el.className = 'v ' + colorBy(hs.length ? totalProfit : null);
      el.title = hs.length
        ? '累计收益 = 持仓收益 ' + fmtSigned(holdProfit) +
          (Math.abs(totalProfit - holdProfit) >= 0.005
            ? ' + 已赎回部分已实现 ' + fmtSigned(totalProfit - holdProfit) : '') +
          '；累计投入 ' + fmtMoney(invested) + ' 元' +
          (invested > 0 ? '，累计收益率 ' + (totalProfit >= 0 ? '+' : '') + (totalProfit / invested * 100).toFixed(2) + '%' : '')
        : '';
    }
    el = document.getElementById('metric-cumann');
    if (el) {
      el.textContent = cumAnn === null ? '—'
        : (cumAnn > 0 ? '+' : '') + cumAnn.toFixed(2) + '%';
      el.className = colorBy(cumAnn) || 'ink';
      el.title = cumAnn === null ? ''
        : '累计年化（XIRR）= 每笔申购记负、赎回与当前市值记正，按实际发生日折现求出的资金加权内部收益率；' +
          '已落袋收益与资金进出时点都已计入，与只算当前持仓的「持仓年化」不同';
    }
    el = document.getElementById('metric-value');
    if (el) el.innerHTML = hs.length ? fmtMoney(mv) + '<em>元</em>' : '—';
    el = document.getElementById('metric-mom');
    if (el) {
      el.textContent = portAnn === null ? '—'
        : (portAnn > 0 ? '+' : '') + portAnn.toFixed(2) + '%';
      el.className = colorBy(portAnn) || 'ink';
      el.title = portAnn === null ? ''
        : '持仓年化 = 各持仓产品年化按持仓市值加权（组合口径，非单产品等权平均）';
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
    name: function (h) { return prodDispName(h.product); },
    navdate: function (h) { return h.latestDate || ''; },
    nav: function (h) { return h.latestNav; },
    shares: function (h) { return h.shares; },
    mv: function (h) { return h.mv; },
    profit: function (h) { return h.holdProfit; },
    total: function (h) { return h.profit; },
    ann: function (h) { return h.ann; },
    days: function (h) { return h.days; },
    listdays: function (h) { return listingDaysOf(h.product); }
  };
  var WINDOW_SORT = { w7: 0, w14: 1, w30: 2, w60: 3, w90: 4, w365: 5 };

  /* 盈亏汇总表「今日万收」= 看板指标卡同口径（市值加权）：
     单产品 = 今日收益(元) ÷ 前一日市值(元) × 10000 = per10k_last ÷ 昨日净值。
     份额在分子分母中约掉，与是否持仓无关；产品库表 m.todayPer 已同步为同口径（见 calc），
     故看板/盈亏汇总/产品库三处今日万收数值一致。
     未起息/清仓/无昨日净值时返回 null（与看板 todayBase 判空一致，显示「—」）。 */
  function todayWanOf(p) {
    var h = HOLD_BY_PID[p.id];
    if (!h || h.cleared || h.incomePending) return null;
    if (h.income === null || h.income === undefined) return null;
    var n = p.nav ? p.nav.length : 0;
    if (n < 2 || !(p.nav[n - 2] > 0)) return null;
    var base = (h.incomeShares || h.shares) * p.nav[n - 2];
    if (!(base > 0)) return null;
    return h.income / base * 10000;
  }

  function profitSortValue(row, key) {
    var m = row.item.m;
    var h = HOLD_BY_PID[row.item.product.id];
    if (key === 'name') return prodDispName(row.item.product);
    if (key === 'navdate') return m.latestDate;
    if (key === 'today') return todayWanOf(row.item.product);
    if (key === 'income') return h ? h.income : null;
    if (key === 'profit') return h ? h.unrealized : null;
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

    /* 与「交易汇总」联动：同样列出汇总中的全部产品（含当日清仓、在途申购），并按顶部多选过滤 */
    var allModels = MODEL.concat(LIB_MODEL);
    var models = summaryRows().map(function (r) {
      var id = r.product.id;
      for (var i = 0; i < allModels.length; i++) {
        if (allModels[i].product.id === id) return allModels[i];
      }
      return null;
    }).filter(function (x) { return !!x && selectedIds.indexOf(x.product.id) !== -1; });

    /* 净值日期筛选：选项来自当前所选产品的真实披露日，单选，选一个就只看该日披露的产品 */
    var dateOpts = [];
    models.forEach(function (x) {
      var dd0 = (x.m && x.m.latestDate) || '';
      if (dd0 && dateOpts.indexOf(dd0) === -1) dateOpts.push(dd0);
    });
    dateOpts.sort().reverse();
    populateDateFilter(dateOpts);
    if (profitDateSel.length) {
      models = models.filter(function (x) {
        return profitDateSel.indexOf((x.m && x.m.latestDate) || '') !== -1;
      });
    }
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
    var maxIncome = null, minIncome = null;
    rows.forEach(function (row) {
      var v = todayWanOf(row.item.product);
      if (v !== null && v !== undefined) {
        if (maxV === null || v > maxV) maxV = v;
        if (minV === null || v < minV) minV = v;
      }
      var hh = HOLD_BY_PID[row.item.product.id];
      /* 未起息产品今日收益记 0，但不参与「今日收益最低」排名，避免刚确认的持仓被误挂灰👎 */
      var inc = (hh && !hh.incomePending) ? hh.income : null;
      if (inc !== null && inc !== undefined && isFinite(inc)) {
        if (maxIncome === null || inc > maxIncome) maxIncome = inc;
        if (minIncome === null || inc < minIncome) minIncome = inc;
      }
    });

    var html = '';
    rows.forEach(function (row, i) {
      var p = row.item.product;
      var m = row.item.m;
      var h = HOLD_BY_PID[p.id];

      var badge = '';
      var tv = todayWanOf(p);
      if (tv !== null && tv !== undefined && maxV !== minV) {
        if (Math.abs(tv - maxV) < 1e-9) badge = '<span class="thumb-under" title="今日万收最高">' + THUMB_UP + '</span>';
      }
      var downBadge = '';
      if (minIncome !== null && maxIncome !== minIncome && h && !h.incomePending && h.income !== null
          && h.income !== undefined && isFinite(h.income)
          && Math.abs(h.income - minIncome) < 1e-9) {
        downBadge = '<span class="thumb-under thumb-down" title="今日收益最低">' + THUMB_DOWN + '</span>';
      }

      var dual = holdMetric === 'both';
      var rs = dual ? ' rowspan="2"' : '';
      var lbl = holdMetric === 'ann' ? '年化' : '日均万收';
      html += '<tr class="ma' + (dual ? ' dual' : '') + '">';
      var mvUnder = (h && h.mv !== null && h.mv !== undefined && !isNaN(h.mv))
        ? '<span class="mv-under" title="持仓市值 ¥' + fmtMoney(h.mv) + '">¥' + fmtMoney(h.mv) + '</span>' : '';
      html += '<td class="c num"' + rs + '>' + (i + 1) + '</td>';
      html += '<td' + rs + '><div class="pname"><a class="plink" href="javascript:void(0)" data-goto-trade="' + p.id + '" title="查看「' + (p.name || '') + '」的交易记录">' + prodDispName(p) + '</a>' + badge + downBadge + mvUnder + '</div></td>';
      html += '<td class="c num"' + rs + '>' + (m.latestDate ? withBadge(mmdd(m.latestDate), navLagBadge(p)) : '—') + '</td>';
      html += '<td class="r num today-col ' + colorBy(tv) + '"' + rs + '>' + fmtSigned(tv) + '</td>';
      html += '<td class="r num income-col ' + colorBy(h && !h.incomePending ? h.income : null) + '"' + rs +
        ' title="' + (h && h.incomePending ? '确认日 ' + (h.startDate || '') + ' 起息，首笔收益待下一净值日披露' : '') + '">' +
        (h && h.incomePending ? '<span class="muted">—</span>' : fmtSigned(h ? h.income : null)) + '</td>';
      var holdTip = h
        ? '持仓收益（仅当前持仓份额）= 市值 ' + fmtMoney(h.mv) + ' − 剩余成本 ' + fmtMoney(h.cost)
        : '暂无持仓';
      html += '<td class="r num ' + colorBy(h ? h.unrealized : null) + '"' + rs + ' title="' + holdTip + '">' +
        fmtSigned(h ? h.unrealized : null) + '</td>';
      html += '<td class="r num ' + colorBy(h ? h.ann : null) + '"' + rs + '>' + fmtAnn(h ? h.ann : null) + '</td>';
      var listDays = listingDaysOf(p);
      var daysTip = (h ? '持仓天数 ' + h.days + ' 天 = 今天 − 起息日 ' + (h.effStartDate || '') +
          '；年化按计息 ' + h.accrualDays + ' 天（至最新净值日 ' + (h.latestDate || '') + '）折算' : '') +
        (listDays !== null ? (h ? '；' : '') + '成立天数 ' + listDays + ' 天 = 今天 − 成立日 ' +
          (inceptionDateOf(p) || '') : '');
      html += '<td class="c num dcell daystack"' + rs + ' title="' + daysTip + '">' +
        (h ? '<span class="days">' + h.days + '</span>' : '—') +
        (listDays !== null ? '<span class="dsep"></span><span class="days sub">' + listDays + '</span>' : '') + '</td>';
      html += '<td class="c mlabel">' + lbl + '</td>';

      var perCells = '';
      var annCells = '';
      m.windows.forEach(function (w) {
        var mark = w.fallback ? '<sup class="dag">†</sup>' : '';
        var perTip = w.per === null ? '历史区间不足'
          : w.per.toFixed(4) + ' 元 / 万元市值（' + w.start + ' 至 ' + m.latestDate + '，' + w.span + ' 天）' +
            (w.fallback ? '；成立不足 1 年，按成立以来计算' : '');
        var annTip = w.ann === null ? '历史区间不足'
          : w.ann.toFixed(4) + '%（' + w.start + ' 至 ' + m.latestDate + '，按 ' + w.span + ' 天年化）' +
            (w.fallback ? '；成立不足 1 年，按成立以来计算' : '');
        perCells += '<td class="c num pwin ' + colorBy(w.per) + '" title="' + perTip + '">' + withBadge(fmt2(w.per), mark) + '</td>';
        annCells += '<td class="c num awin ' + colorBy(w.ann) + '" title="' + annTip + '">' + withBadge(fmtAnn(w.ann), mark) + '</td>';
      });
      html += holdMetric === 'ann' ? annCells : perCells;

      html += scoreCell(row, 'c', dual ? 2 : 0);
      html += '</tr>';

      if (dual) html += '<tr class="mb"><td class="c mlabel">年化</td>' + annCells + '</tr>';
    });

    tbody.innerHTML = html || '<tr><td colspan="16" class="c muted" style="padding:28px">未选择产品，请在顶部「覆盖产品」中选择</td></tr>';

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

  /* ---------------- 盈亏汇总「净值日期」筛选 ---------------- */
  /* 表头就是与「数据」列同款的原生下拉：首项「净值日期」＝全部，其余为各披露日。
     单选，点选即收起（原生 select 行为），选一个日期就只看该日披露的产品。 */
  var profitDateSel = [];   /* 至多一个日期；空 = 全部 */
  var dateSelEl = null;

  function dateSelRef() {
    if (!dateSelEl || !dateSelEl.isConnected) dateSelEl = document.getElementById('hold-date-sel');
    return dateSelEl;
  }

  function populateDateFilter(dates) {
    var s = dateSelRef();
    if (!s) return;
    var keep = profitDateSel[0] || '';
    if (keep && dates.indexOf(keep) === -1) { keep = ''; profitDateSel = []; }
    /* 选项集合没变就不重建 DOM，避免移动端下拉被反复重绘 */
    var sig = dates.join('|');
    if (s.getAttribute('data-sig') !== sig) {
      var html = '<option value="">净值日期</option>';
      dates.forEach(function (d) {
        html += '<option value="' + d + '">' + mmdd(d) + '</option>';
      });
      s.innerHTML = html;
      s.setAttribute('data-sig', sig);
    }
    s.value = keep;
    s.classList.toggle('on', !!keep);
  }

  function bindDateFilter() {
    var s = dateSelRef();
    if (!s) return;
    s.addEventListener('change', function () {
      profitDateSel = s.value ? [s.value] : [];
      renderProfitTable();
    });
    /* 点下拉只筛选，不触发整列排序 */
    s.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    s.addEventListener('click', function (e) { e.stopPropagation(); });
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

  /* 自然日口径的统一区间统计：逐段按「该段收益 ÷ 该段期初市值」折算万收，
     再按各段真实跨越的自然日天数加权平均（时间加权）。
     —— 必须逐段用自己的期初市值：组合里陆续申购/赎回时，若拿「区间首日市值」当固定分母，
        后续加仓的收益会被摊到首日的小市值上（严重高估），赎回后的收益会被摊到大市值上（低估）。
        这正是本次 2026 年度 14.40%、10 月 14.33%、11 月 11.27% 偏高的原因。
     —— 周末/节假日不披露净值，其累计涨跌按该段真实跨越的自然日摊销。
     —— 首段可能跨月/跨年，只把落在本期内的天数与对应收益计入本期。
     年化严格由日均万收换算：日均万收 × 3.65 = 年化%。 */
  function cumulativePeriodStats(p, prefix) {
    var idxs = [];
    for (var i = 0; i < p.dates.length; i++) {
      if (p.dates[i].indexOf(prefix) === 0) idxs.push(i);
    }
    if (!idxs.length) return { avg: null, ann: null, days: 0, sum: 0 };
    var periodStart = prefix + (/^\d{4}-$/.test(prefix) ? '01-01' : '01');
    var sum = 0, acc = 0, days = 0;
    idxs.forEach(function (i) {
      var raw = p.raw ? p.raw[i] : p.per10k[i];
      if (raw === null || raw === undefined) return;
      sum += raw;
      var base = p.prevMv && p.prevMv[i] > 0 ? p.prevMv[i] : 0;
      var segStart = (p.prevDates && p.prevDates[i]) || p.dates[i];
      var gap = p.gaps && p.gaps[i] > 0 ? p.gaps[i] : 1;
      var v = raw;
      if (segStart < periodStart) {
        var inside = dayDiff(parseDate(periodStart), parseDate(p.dates[i]));
        if (!(inside > 0)) return;
        v = raw * inside / gap;
        gap = inside;
      }
      if (!(base > 0) || !(gap > 0)) return;
      /* v/base 是「该段累计收益率」（段内 gap 天合计），先按段累加收益率，
         最后统一除以总天数：avg = Σ(段收益率) / Σ(段天数) × 10000。
         不能写成 Σ(段收益率 × 天数)：段收益率本身已含 gap 天，再乘天数会把周更产品的权重放大 gap 倍。 */
      acc += v / base;
      days += gap;
    });
    if (!(days > 0)) return { avg: null, ann: null, days: 0, sum: sum };
    var avg = acc / days * 10000;
    return { avg: avg, ann: avg * 3.65, days: days, sum: sum };
  }

  function monthStats(p, perMap, y, m) {
    var prefix = y + '-' + String(m + 1).padStart(2, '0') + '-';
    var sum = 0, cnt = 0, pos = 0, neg = 0, flat = 0;
    p.dates.forEach(function (dt) {
      if (dt.indexOf(prefix) !== 0) return;
      var v = perMap[dt];
      if (v === undefined) return;
      sum += v;
      cnt += 1;
      if (v > 0.005) pos += 1;
      else if (v < -0.005) neg += 1;
      else flat += 1;
    });
    var st = cumulativePeriodStats(p, prefix);
    return {
      sum: sum,
      avg: st.avg,
      cnt: cnt,
      pos: pos,
      neg: neg,
      flat: flat,
      ann: st.ann
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
    /* 月度合计改用未取整的原始收益累加，避免逐日四舍五入后求和产生 0.01~0.02 元偏差 */
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
        return { m: m, st: monthStats(p, sumMap, calState.y, m) };
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
          '<span class="rate-cell ' + rateLevel(st.ann) + '" style="--w:' + barW(st.ann) + '">' + fmtAnn(st.ann) + thumb + '</span>' +
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
    var minV = defined.length ? Math.min.apply(null, defined) : null;

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
      var worst = (minV !== null && maxV !== minV && Math.abs(v - minV) < 1e-9);
      // 手机端格子窄，两位小数会被截断，绝对值≥10 时收一位
      var txt = (compact && Math.abs(v) >= 10) ? (v > 0 ? '+' : '') + v.toFixed(1) : fmtSigned(v);
      cells.push('<div class="cell' + (best ? ' best' : '') + '">' +
        '<div class="d">' + d2 + (best ? '<span class="thumb">' + THUMB_UP + '</span>' : '')
          + (worst ? '<span class="thumb thumb-down" title="今日收益最低">' + THUMB_DOWN + '</span>' : '') + '</div>' +
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

  /* 年化数据条宽度：5% 年化满格，按绝对值取比例，最小 8% 保证可见 */
  function barW(v) {
    if (v === null || v === undefined || !isFinite(v)) return '0%';
    var r = Math.abs(v) / 5 * 100;
    return Math.max(8, Math.min(100, r)).toFixed(1) + '%';
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
      if (!map[y]) map[y] = { sum: 0, cnt: 0, pos: 0, neg: 0 };
      map[y].sum += v;
      map[y].cnt += 1;
      if (v > 0.005) map[y].pos += 1;
      else if (v < -0.005) map[y].neg += 1;
    });
    var years = Object.keys(map).sort().reverse();
    var latestYear = years[0];
    tbody.innerHTML = years.map(function (y) {
      var s = map[y];
      /* 年度日均万收/年化统一为自然日口径，与产品库「成立至今」一致 */
      var st = cumulativePeriodStats(AGG, y + '-');
      var ann = st.ann;
      var avgWan = st.avg;
      return '<tr data-year="' + y + '" class="' + (y === latestYear ? 'on' : '') + '">' +
        '<td class="ym">' + y + '</td>' +
        '<td class="r num ' + colorBy(s.sum) + '">' + (s.sum > 0 ? '+' : '') + fmtMoney(s.sum) + '</td>' +
        '<td class="r num cnt">' + (avgWan === null ? '—' : (avgWan > 0 ? '+' : '') + avgWan.toFixed(2)) + '</td>' +
        '<td class="num cnt">' + s.pos + '</td>' +
        '<td class="num cnt">' + s.neg + '</td>' +
        '<td></td>' +
        '<td><div class="rate-cell ' + rateLv(ann) + '" style="--w:' + barW(ann) + '">' + (ann === null ? '—' : ann.toFixed(2) + '%') + '</div></td>' +
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
    /* 区间摘要统一为自然日口径：用未取整收益累加，并除以实际跨越的自然日数，
       不再按披露点数量平均；期初市值与期初日期均取该区间首个收益点对应的区间起点。 */
    var rawSeries = p.raw || p.per10k;
    var sumRaw = 0;
    for (var ri = start; ri < p.dates.length; ri++) {
      var rv = rawSeries[ri];
      if (rv !== null && rv !== undefined) sumRaw += rv;
    }
    /* 区间日均收益（元/天）与区间年化都按自然日：年化逐段用各自期初市值加权，
       避免组合在区间内加仓/赎回时被单一首日市值放大或缩小。 */
    var spanStart = (p.prevDates && p.prevDates[start]) || firstDate;
    var spanDays = Math.max(1, dayDiff(parseDate(spanStart), parseDate(lastDate)));
    var avg = sumRaw / spanDays;
    var wanAcc = 0, wanDays = 0;
    for (var wi = start; wi < p.dates.length; wi++) {
      var wv = rawSeries[wi];
      var wb = p.prevMv ? p.prevMv[wi] : 0;
      var wg = p.gaps && p.gaps[wi] > 0 ? p.gaps[wi] : 1;
      if (wv === null || wv === undefined || !(wb > 0) || !(wg > 0)) continue;
      /* 同区间统计：累加段收益率，最后除以总天数 */
      wanAcc += wv / wb;
      wanDays += wg;
    }
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
      var rangeAnn = wanDays > 0 ? wanAcc / wanDays * 365 * 100 : null;
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
  var PROD_PAGE_SIZE = 10;
  var prodUi = {
    /* 多选筛选：数组为空表示不限；多选时按「命中任一」过滤 */
    sale: [], org: [], risk: [], term: [], incep: [], q: '',
    flagNew: false, flagFav: false,
    holdHolding: true, holdCleared: true, page: 1, pages: 1,
    mPer10k: true, mAnn: true,
    /* 表头排序：默认今日万收降序；sortTouched 表示用户手动点过表头 */
    sortKey: 'p10k', sortDir: 'desc', sortTouched: false
  };

  function favs() {
    try { return JSON.parse(localStorage.getItem('wealth3.favs') || '[]'); } catch (e) { return []; }
  }
  function saveFavs(list) {
    try { localStorage.setItem('wealth3.favs', JSON.stringify(list)); } catch (e) { /* 忽略 */ }
  }

  /* 持有期：优先取名称里明确的持有期天数（支持中文数字与「一个月/三个月」），
     其次识别日开/天天开放型产品，最后才回退占位符 */
  function termOf(p) {
    var s = String((p.short || '') + (p.name || ''))
      .replace(/一百八十/g, '180')
      .replace(/二十一/g, '21')
      .replace(/十四/g, '14')
      .replace(/三十/g, '30')
      .replace(/六十/g, '60')
      .replace(/九十/g, '90')
      .replace(/七/g, '7');
    var m = s.match(/(\d+)\s*天/);
    if (m) return (+m[1]) + '天';
    m = s.match(/([一二三四五六七八九十]+|\d+)\s*个月/);
    if (m) {
      var cn = { '一': 1, '二': 2, '三': 3, '六': 6, '九': 9, '十二': 12 }[m[1]];
      var months = cn || parseInt(m[1], 10);
      if (months) return (months * 30) + '天';
    }
    if (/日日开|天天利|天天盈|天天购|天添|天天|日日|每日开放|日开|现金管理类/.test(s)) return '日开';
    return '—';
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

  /* 产品库表头排序：取值 → 统一比较（空值始终排末尾） */
  function riskRank(v) {
    var m = String(v || '').match(/([1-5])/);
    return m ? +m[1] : null;
  }

  function termRank(term) {
    if (term === '日开') return 0;
    var n = parseInt(term, 10);
    return isNaN(n) ? null : n;
  }

  function prodSortValue(item, key) {
    var p = item.product || {};
    var m = item.m || {};
    var w = m.windows || [];
    function win(i) { return w[i] && typeof w[i].per === 'number' ? w[i].per : null; }
    switch (key) {
      case 'name': return prodDispName(p);
      case 'risk': return riskRank(riskOf(p));
      case 'term': return termRank(termOf(p));
      case 'p10k': return typeof m.todayPer === 'number' ? m.todayPer : null;
      case 'w7': return win(0);
      case 'w14': return win(1);
      case 'w30': return win(2);
      case 'ann': return typeof m.sinceAnn === 'number' ? m.sinceAnn : null;
      case 'nav': return typeof m.latestNav === 'number' ? m.latestNav : null;
      case 'navdate': return m.latestDate || '';
      case 'cdate': return m.inception || '';
      default: return null;
    }
  }

  function prodCompare(a, b, key, dir) {
    var av = prodSortValue(a, key);
    var bv = prodSortValue(b, key);
    var aEmpty = av === null || av === undefined || av === '';
    var bEmpty = bv === null || bv === undefined || bv === '';
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
    if (aEmpty) return 0;
    var r = av < bv ? -1 : av > bv ? 1 : 0;
    if (r === 0 && key !== 'name') {
      r = prodDispName(a.product).localeCompare(prodDispName(b.product), 'zh');
    }
    return dir === 'asc' ? r : -r;
  }

  function renderProductSortMarks() {
    var ths = document.querySelectorAll('#prod-table thead th[data-sort]');
    Array.prototype.forEach.call(ths, function (th) {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.getAttribute('data-sort') === prodUi.sortKey) {
        th.classList.add(prodUi.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      }
    });
  }

  function bindProdSort() {
    Array.prototype.forEach.call(document.querySelectorAll('#prod-table thead th[data-sort]'), function (th) {
      if (th.dataset.sortBound) return;
      th.dataset.sortBound = '1';
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (prodUi.sortKey === key && prodUi.sortTouched) {
          prodUi.sortDir = prodUi.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          /* 文本列首次点击升序，数值列首次点击降序 */
          var textCols = { name: 1, navdate: 1, cdate: 1 };
          prodUi.sortKey = key;
          prodUi.sortDir = textCols[key] ? 'asc' : 'desc';
        }
        prodUi.sortTouched = true;
        prodUi.page = 1;
        renderProductTable();
      });
    });
  }

  /* 新品挂标：成立日起 30 天内（含第 30 天） */
  function isNewProduct(p, m) {
    var inc = p.inception || (m && m.inception) || '';
    if (!inc) return false;
    var end = parseDate(inc).getTime() + 30 * DAY;
    var ref = DATA.asOf ? parseDate(DATA.asOf).getTime() : new Date().getTime();
    return ref <= end;
  }

  /* 全站产品展示名统一：发行机构简称 + 产品系列 + 持有期 + 期号。
     去掉括号修饰、系列子名前缀（优盛·/合盛多元·等）、冗余词（最短持有/持有期/固收类/理财产品）。
     已符合风格的短名（如「中邮鸿锦7天45号」）会保留机构前缀不重复添加。
     机构来源兼容三类数据：持仓 org、产品库 orgShort、新品 issuer。 */
  /* 产品库产品名称旁的可点击链接图标：仅 http/https 且来自手工产品 link 字段，
     用 encodeURI 做安全转义，新窗口打开并加 noopener/noreferrer。 */
  function prodLinkIcon(p) {
    var link = p && p.link;
    if (!link || !/^https?:\/\/\S+$/i.test(String(link))) return '';
    var url = String(link).replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
    return '<a class="prod-link" href="' + url + '" target="_blank" rel="noopener noreferrer" title="打开产品详情页">' +
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M6.5 3.5H3.2a1.2 1.2 0 0 0-1.2 1.2v8.1a1.2 1.2 0 0 0 1.2 1.2h8.1a1.2 1.2 0 0 0 1.2-1.2V9.5"></path>' +
      '<path d="M9 2.5h4.5V7M13 3L7 9"></path></svg></a>';
  }

  function prodDispName(p) {
    if (!p) return '—';
    var base = String(p.short || p.name || '—')
      .replace(/[（(][^）)]*[）)]/g, '')                 // 去所有括号修饰
      .replace(/[\u4e00-\u9fa5]{2,6}[·•\-－—]/, '')     // 去系列子名前缀（优盛·等）
      .replace(/最短持有|最低持有|持有期|固定收益类|固收类|理财产品|理财计划/g, '')
      /* 去风险收益定位词（非产品系列名）：固收稳利/增利稳健/固收增利等，系列名（安盈象/阳光金/稳富等）保留 */
      .replace(/固收稳利|增利稳健|固收增利|固收增强|固收精选|固收添益|固收/g, '')
      .replace(/产品(?=第\d+期|$)/g, '')                 // 去「产品」字样（如 添利产品第2期 → 添利第2期）
      .replace(/\s{2,}/g, ' ').trim();
    /* 机构简称：orgShort / org / issuer 依次兜底；去掉公司后缀与「理财」 */
    var org = String(p.orgShort || p.org || p.issuer || '')
      .replace(/(有限责任公司|股份有限公司|有限公司|公司)$/g, '')
      .replace(/理财$/g, '')
      .trim();
    /* 若短名尚未带机构简称，则补上；已带则避免重复 */
    if (org && base.indexOf(org) !== 0) base = org + base;
    return base || '—';
  }

  /* 产品库合并去重：同一登记编码（regCode）只保留一条，优先保留持仓产品（MODEL 在前）。
     无登记编码时退回 id。 */
  function mergeProductModels() {
    var seen = Object.create(null);
    var out = [];
    MODEL.concat(LIB_MODEL).forEach(function (item) {
      var p = item && item.product;
      if (!p) return;
      var key = p.regCode ? ('R:' + String(p.regCode)) : ('I:' + String(p.id));
      if (seen[key]) return;
      seen[key] = 1;
      out.push(item);
    });
    return out;
  }

  /* 全站统一的产品清单（各产品搜索框共用）：与「产品库」完全同一去重口径（按 regCode，持仓优先），
     保证搜索下拉里的产品名称与产品库展示名称联动一致，不再出现同一产品的新旧两个名字 */
  function allUniqueProducts() {
    return mergeProductModels().map(function (it) { return it.product; });
  }

  function renderProductTable() {
    var tbody = document.getElementById('prod-body');
    if (!tbody) return;
    var allModels = mergeProductModels();
    var peerAvg30 = peerAvg30Of(allModels);
    var favList = favs();

    var list = allModels.filter(function (item) {
      var p = item.product;
      if (!inGlobalScope(p.id)) return false;
      var h = HOLD_BY_PID[p.id];
      var term = termOf(p);
      var isNew = isNewProduct(p, item.m);
      var isFav = favList.indexOf(p.id) !== -1;
      if (prodUi.sale.length && prodUi.sale.indexOf(saleOf(p)) === -1) return false;
      if (prodUi.org.length && prodUi.org.indexOf(orgShort(p.org)) === -1) return false;
      if (prodUi.risk.length && prodUi.risk.indexOf(riskOf(p)) === -1) return false;
      if (prodUi.term.length && prodUi.term.indexOf(termBucket(term)) === -1) return false;
      /* 成立月份：按产品成立日所在月份筛选（手工添加/无成立日的不参与） */
      if (prodUi.incep.length && prodUi.incep.indexOf(String(p.inception || '').slice(0, 7)) === -1) return false;
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
        prodDispName(p).toLowerCase().indexOf(q) === -1 &&
        (p.regCode || '').toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    /* 搜索时先按「名称命中优先、编号命中最后」重排，再按表头排序列排序 */
    list = sortBySearch(list, prodUi.q, function (it) { return it.product; });
    if (!prodUi.q.trim() || prodUi.sortTouched) {
      list = list.slice().sort(function (a, b) {
        return prodCompare(a, b, prodUi.sortKey, prodUi.sortDir);
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
      var isNew = isNewProduct(p, m);
      var isFav = favList.indexOf(p.id) !== -1;

      var w7 = m.windows[0], w14 = m.windows[1], w30 = m.windows[2];
      function winCell(w) {
        var mark = w.fallback ? '<sup class="dag">†</sup>' : '';
        return '<td class="c st"><b class="m-p10k ' + colorBy(w.per) + '">' + withBadge(fmt2(w.per), mark) +
          '</b><i class="m-ann ' + colorBy(w.ann) + '">' + withBadge(fmtAnn(w.ann), mark) + '</i></td>';
      }

      return '<tr data-pid="' + p.id + '">' +
        '<td class="c"><button class="stars" data-fav="' + p.id + '" title="' +
          (isFav ? '取消收藏' : '收藏') + '">' + (isFav ? '★' : '☆') + '</button></td>' +
        '<td><div class="pname">' + (h ?
          '<a class="plink" href="javascript:void(0)" data-goto-trade="' + p.id + '" title="' + (p.name || '') + '">' +
            prodDispName(p) + '</a>' :
          '<span class="pname-t" title="' + (p.name || '') + '">' + prodDispName(p) + '</span>') +
          prodLinkIcon(p) +
          '<span class="ptags">' +
          (h ? (h.cleared ?
            '<span class="cleared-date">' +
              (h.tx && h.tx.confirmDate ? h.tx.confirmDate.slice(5) + ' ' : '') + '清仓</span>' :
            '<span class="tag new">持仓</span>') : '') +
          (isNew ? '<span class="tag np">新品</span>' : '') +
          (p.manual ? '<span class="tag" style="background:#f4f7f9;color:#7d939f" title="手工添加的产品">手工</span>' : '') +
          '</span>' +
          '</div></td>' +
        '<td class="c num">' + (m.latestDate ? withBadge(mmdd(m.latestDate), navLagBadge(p)) : '<span class="muted">待披露</span>') + '</td>' +
        '<td class="r num ' + colorBy(m.todayPer) + '" data-col="p10k">' + fmtSigned(m.todayPer) + '</td>' +
        winCell(w7) + winCell(w14) + winCell(w30) +
        '<td class="r num ' + colorBy(m.sinceAnn) + '" data-col="ann">' + fmtAnn(m.sinceAnn) + '</td>' +
        '<td class="c pmeta">' + (riskShort(p) || '—') + '</td>' +
        '<td class="c pmeta">' + term + '</td>' +
        '<td class="r num">' + (m.latestNav != null ? fmtNav(m.latestNav) : '<span class="muted">待披露</span>') + '</td>' +
        '<td class="c cdate">' + (m.inception && listingDaysOf(p) !== null ?
          '<span>' + m.inception + '</span><i>' + listingDaysOf(p) + ' 天</i>' :
          '<span class="muted">—</span>') + '</td>' +
        '<td class="c">' + (h ? '<button class="mini" data-detail="' + p.id + '">详情</button>' : '') +
          (p.manual ? '<button class="mini warn" data-del-product="' + p.id + '" style="margin-left:4px">删除</button>' : '') +
          (!h && !p.manual ? '<span class="muted">—</span>' : '') + '</td>' +
        '</tr>';
    }).join('');

    tbody.innerHTML = html || '<tr><td colspan="13" class="c muted" style="padding:28px">当前筛选条件下暂无产品</td></tr>';

    var totalEl = document.getElementById('prod-total');
    if (totalEl) totalEl.textContent = allModels.length;
    var hitEl = document.getElementById('prod-hit');
    if (hitEl) hitEl.textContent = hit;
    renderProdPager(pages, hit);

    applyProductCols();
    renderProductSortMarks();
  }

  var pgPop = null;
  var pgPopAt = 0;   /* 打开时间：忽略打开瞬间由点击带入视口产生的滚动，避免弹层刚出现就被关掉 */

  function closePagePop() {
    if (pgPop && pgPop.parentNode) pgPop.parentNode.removeChild(pgPop);
    pgPop = null;
  }

  /* 页码弹层：5 列小格子，最多 4 行高，手机和网页都不占屏 */
  function openPagePop(anchor) {
    closePagePop();
    var pages = prodUi.pages;
    var pop = document.createElement('div');
    pop.className = 'pg-pop';
    var html = '';
    for (var i = 1; i <= pages; i++) {
      html += '<button type="button" data-page="' + i + '"' + (i === prodUi.page ? ' class="on"' : '') + '>' + i + '</button>';
    }
    pop.innerHTML = html;
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    var top = r.top - h - 6;
    if (top < 8) top = r.bottom + 6;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-page]');
      if (!btn) return;
      var page = parseInt(btn.getAttribute('data-page'), 10);
      closePagePop();
      if (page && page !== prodUi.page) {
        prodUi.page = page;
        renderProductTable();
      }
    });
    pgPop = pop;
    pgPopAt = Date.now();
    var on = pop.querySelector('.on');
    if (on) pop.scrollTop = Math.max(0, on.offsetTop - 30);
  }

  function renderProdPager(pages, total) {
    var box = document.getElementById('prod-pages');
    var info = document.getElementById('prod-pager-info');
    if (info) info.textContent = '';
    prodUi.pages = pages;
    if (!box) return;
    /* 精简翻页：‹ 当前页 › / 总页数，点当前页弹出页码格子 */
    box.innerHTML =
      '<button data-page="' + (prodUi.page - 1) + '"' + (prodUi.page <= 1 ? ' disabled' : '') + ' aria-label="上一页">‹</button>' +
      (pages > 1 ? '<button type="button" class="pg-cur" aria-haspopup="true" aria-label="跳转页码">' + prodUi.page + '</button>' : '') +
      '<button data-page="' + (prodUi.page + 1) + '"' + (prodUi.page >= pages ? ' disabled' : '') + ' aria-label="下一页">›</button>' +
      (pages > 1 ? '<span class="pg-total">/ ' + pages + '</span>' : '');
  }

  function applyProductCols() {
    var tbl = document.getElementById('prod-table');
    if (!tbl) return;
    var on = { per10k: prodUi.mPer10k, ann: prodUi.mAnn };
    tbl.classList.toggle('only-ann', on.ann && !on.per10k);
    tbl.classList.toggle('only-p10k', on.per10k && !on.ann);
    tbl.querySelectorAll('.m-p10k').forEach(function (el) { el.style.display = on.per10k ? '' : 'none'; });
    tbl.querySelectorAll('.m-ann').forEach(function (el) { el.style.display = on.ann ? '' : 'none'; });
    tbl.classList.toggle('no-p10k', !on.per10k);
    tbl.querySelectorAll('[data-col="p10k"]').forEach(function (el) {
      /* 不能用 display:none：表头少一格会让整行单元格错位、数值压到相邻列上 */
      el.style.display = '';
      el.style.visibility = on.per10k ? '' : 'hidden';
      el.style.padding = on.per10k ? '' : '0';
    });
    var p10kCol = document.getElementById('prod-p10k-col');
    if (p10kCol) p10kCol.style.width = on.per10k ? '6.1%' : '0';
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
    var current = selValues(sel);
    sel.innerHTML = '<option value="">发行机构</option>' + orgs.map(function (o) {
      return '<option value="' + o + '">' + o + '</option>';
    }).join('');
    var restored = current.filter(function (v) { return orgs.indexOf(v) !== -1; });
    if (restored.length) {
      Array.prototype.forEach.call(sel.options, function (o, j) {
        o.selected = (j === 0) ? false : (restored.indexOf(o.value) !== -1);
      });
    } else {
      Array.prototype.forEach.call(sel.options, function (o, j) { o.selected = (j === 0); });
    }
    syncSelLabel(sel);
  }

  /* ---------------- 筛选下拉：自绘列表（原生 select 展开层字号不可控） ---------------- */
  var selPop = null;
  var selPopSel = null;
  var selPopAnchor = null;
  var selPopAt = 0;

  function closeSelPop() {
    if (selPop && selPop.parentNode) selPop.parentNode.removeChild(selPop);
    selPop = null;
    selPopSel = null;
    selPopAnchor = null;
  }

  /* 跟随锚点重新定位；锚点滚出视口时关闭 */
  function placeSelPop() {
    if (!selPop || !selPopSel) return;
    var anchor = selPopAnchor || selPopSel;
    var r = anchor.getBoundingClientRect();
    var vh = window.innerHeight;
    if (r.bottom < 0 || r.top > vh) { closeSelPop(); return; }
    var vw = window.innerWidth;
    var pw = selPop.offsetWidth;
    var ph = selPop.offsetHeight;
    var left = Math.max(8, Math.min(r.left, vw - pw - 8));
    var top = r.bottom + 6;
    if (top + ph > vh - 8) top = r.top - ph - 6;
    top = Math.max(8, Math.min(top, vh - ph - 8));
    selPop.style.left = left + 'px';
    selPop.style.top = top + 'px';
  }

  /* 读取多选下拉的选中值数组；「全部」项（value 为空/both）单独语义由调用方处理 */
  function selValues(sel) {
    var out = [];
    if (!sel) return out;
    Array.prototype.forEach.call(sel.options, function (o) {
      if ((o.value === '' || o.value === 'both') && sel.options.length && o === sel.options[0]) return;
      if (o.selected && o.value) out.push(o.value);
    });
    return out;
  }
  /* 是否处于「全部」态：第一项被选中，或无任何具体项选中 */
  function selIsAll(sel) {
    if (!sel || !sel.options.length) return true;
    if (sel.options[0].selected) return true;
    return selValues(sel).length === 0;
  }

  /* 产品库表头筛选：参考看板产品筛选 —— 点名称＝仅选该项并收起；点前置复选框＝多选增减（弹层保持打开）。
     首项（列名，如「风险等级」）＝全部；点空白处或按 Esc 收起，无「清除 / 完成」按钮。 */
  function openSelPop(sel, anchor, opts) {
    opts = opts || {};
    var anchorEl = anchor || sel;
    if (selPopSel === sel && selPopAnchor === anchorEl) { closeSelPop(); return; }
    closeSelPop();
    var pop = document.createElement('div');
    pop.className = 'sel-pop';
    pop.setAttribute('role', 'listbox');

    function selectAll() {
      Array.prototype.forEach.call(sel.options, function (o, j) { o.selected = (j === 0); });
    }
    /* 勾选态回写：首项＝全部，其余按 select 选中情况 */
    function paint() {
      Array.prototype.forEach.call(pop.querySelectorAll('.sel-opt'), function (row, j) {
        var all = (j === 0);
        var on = all ? selIsAll(sel) : (!!sel.options[j] && sel.options[j].selected && !selIsAll(sel));
        row.classList.toggle('on', on);
        row.setAttribute('aria-selected', on ? 'true' : 'false');
        var cb = row.querySelector('.mchk');
        if (cb) cb.checked = on;
      });
    }
    function commit() {
      paint();
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    Array.prototype.forEach.call(sel.options, function (opt, i) {
      var isAllItem = (i === 0);
      var row = document.createElement('label');
      row.className = 'sel-opt mopt';
      row.setAttribute('role', 'option');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'mchk';
      var txt = document.createElement('span');
      txt.className = 'mtxt';
      txt.textContent = opt.text;
      row.appendChild(cb);
      row.appendChild(txt);

      /* 点名称或行内任意空白：仅选这一项（首项＝全部），并立即收起。
         必须绑在整行上——只绑 span 时点到文字旁边的空白处会落进 label 默认行为，
         变成切换复选框（看起来就像「点名称还在多选」）。 */
      row.addEventListener('click', function (e) {
        if (e.target === cb) return;   /* 复选框自己处理多选 */
        e.preventDefault();
        e.stopPropagation();
        if (isAllItem) selectAll();
        else {
          Array.prototype.forEach.call(sel.options, function (o) { o.selected = false; });
          opt.selected = true;
        }
        commit();
        closeSelPop();
      });

      /* 点复选框：多选增减，弹层保持打开，与看板产品筛选一致 */
      cb.addEventListener('click', function (e) {
        e.stopPropagation();           /* 不触发整行的「仅选」 */
      });
      cb.addEventListener('change', function (e) {
        e.stopPropagation();
        if (isAllItem) selectAll();
        else {
          opt.selected = cb.checked;
          sel.options[0].selected = false;
          if (selValues(sel).length === 0) sel.options[0].selected = true;
        }
        commit();
        placeSelPop();
      });

      pop.appendChild(row);
    });
    paint();

    document.body.appendChild(pop);
    selPop = pop;
    selPopSel = sel;
    selPopAnchor = anchorEl;
    selPopAt = Date.now();

    var r = anchorEl.getBoundingClientRect();
    pop.style.minWidth = Math.max(r.width, 132) + 'px';
    placeSelPop();
  }

  /* 下拉当前值：由自绘标签居中展示（原生 select 文本无法居中）；多选时显示「已选 N 项」 */
  function syncSelLabel(sel) {
    var wrap = sel && sel.parentNode;
    if (!wrap || !wrap.classList || !wrap.classList.contains('sel-wrap')) return;
    var label = wrap.querySelector('.sel-label');
    if (!label) return;
    var allItem = sel.options[0];
    var firstText = allItem ? allItem.text : '';
    if (selIsAll(sel)) {
      label.textContent = firstText;
    } else {
      var vals = selValues(sel);
      if (vals.length === 1) {
        var hit = null;
        Array.prototype.forEach.call(sel.options, function (o) { if (o.selected && o.value) hit = o.text; });
        label.textContent = hit || firstText;
      } else {
        label.innerHTML = firstText + ' <span class="mcount">' + vals.length + '</span>';
      }
    }
    sizeSelWrap(sel);
  }

  /* 发行机构选项文字过长（如「贝莱德建信理财」）时按实测宽度加宽，避免当前值被截断 */
  function sizeSelWrap(sel) {
    var wrap = sel && sel.parentNode;
    if (!sel || sel.id !== 'org-sel') return;
    if (!wrap || !wrap.classList || !wrap.classList.contains('sel-wrap')) return;
    var cv = document.createElement('canvas');
    var ctx = cv.getContext ? cv.getContext('2d') : null;
    if (!ctx) return;
    ctx.font = '12px ' + getComputedStyle(sel).fontFamily;
    var needW = 0;
    Array.prototype.forEach.call(sel.options, function (o) {
      needW = Math.max(needW, ctx.measureText(o.text).width);
    });
    /* 左右内距 6 + 17、边框 2，另留 5px 余量；不足 80px 时保持统一宽度 */
    var w = Math.ceil(needW) + 30;
    wrap.style.width = (w > 80 ? w : 80) + 'px';
  }

  function beautifyFilterSelects() {
    Array.prototype.forEach.call(document.querySelectorAll('.filters select'), function (sel) {
      if (sel.parentNode && sel.parentNode.classList && sel.parentNode.classList.contains('sel-wrap')) return;
      /* 多选下拉默认选中首项（「全部」），保证初始标签与筛选态一致 */
      if (sel.multiple && selValues(sel).length === 0 && !sel.options[0].selected) {
        Array.prototype.forEach.call(sel.options, function (o, j) { o.selected = (j === 0); });
      }
      var wrap = document.createElement('span');
      wrap.className = 'sel-wrap';
      sel.parentNode.insertBefore(wrap, sel);
      wrap.appendChild(sel);
      var label = document.createElement('span');
      label.className = 'sel-label';
      wrap.appendChild(label);
      var hit = document.createElement('button');
      hit.type = 'button';
      hit.className = 'sel-hit';
      hit.setAttribute('aria-haspopup', 'listbox');
      hit.setAttribute('aria-label', sel.getAttribute('aria-label') || '筛选');
      hit.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openSelPop(sel);
      });
      wrap.appendChild(hit);
      sizeSelWrap(sel);
      sel.addEventListener('change', function () { syncSelLabel(sel); });
      syncSelLabel(sel);
    });

    document.addEventListener('click', function (e) {
      if (!selPop) return;
      if (selPop.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.sel-wrap')) return;
      closeSelPop();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') closeSelPop();
    });
    window.addEventListener('resize', closeSelPop);
    window.addEventListener('scroll', function (e) {
      if (!selPop) return;
      /* 下拉列表自身滚动、以及打开瞬间由点击带入视口造成的滚动，都不关闭 */
      if (e.target === selPop || (e.target && e.target.nodeType === 1 && selPop.contains(e.target))) return;
      if (Date.now() - selPopAt < 400) return;
      placeSelPop();
    }, true);
  }

  /* ---------------- 产品库搜索：输入时弹出候选，点选即筛选 ---------------- */
  var prodSugPop = null;
  var prodSugIdx = 0;

  function closeProdSug() {
    if (prodSugPop && prodSugPop.parentNode) prodSugPop.parentNode.removeChild(prodSugPop);
    prodSugPop = null;
    prodSugIdx = 0;
  }

  function prodSugItems(kw) {
    var q = (kw || '').trim().toLowerCase();
    if (!q) return [];
    var hit = allUniqueProducts().filter(function (p) {
      return (p.name || '').toLowerCase().indexOf(q) !== -1 ||
        (p.short || '').toLowerCase().indexOf(q) !== -1 ||
        prodDispName(p).toLowerCase().indexOf(q) !== -1 ||
        (p.regCode || '').toLowerCase().indexOf(q) !== -1;
    });
    return sortBySearch(hit, kw).slice(0, 8);
  }

  /* 弹层跟随输入框定位：滚动/键盘弹出导致视口变化时重新贴靠，不关闭列表 */
  function placeProdSug() {
    var input = document.getElementById('prod-search');
    if (!prodSugPop || !input) return;
    var r = input.getBoundingClientRect();
    prodSugPop.style.minWidth = Math.max(r.width, 220) + 'px';
    var pw = prodSugPop.offsetWidth;
    var ph = prodSugPop.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - pw - 8));
    var top = r.bottom + 6;
    if (top + ph > vh - 8) top = r.top - ph - 6;
    top = Math.max(8, Math.min(top, vh - ph - 8));
    prodSugPop.style.left = left + 'px';
    prodSugPop.style.top = top + 'px';
  }

  function openProdSug() {
    var input = document.getElementById('prod-search');
    if (!input) return;
    var items = prodSugItems(input.value);
    closeProdSug();
    if (!items.length) return;

    var pop = document.createElement('div');
    pop.className = 'sel-pop prod-sug';
    pop.setAttribute('role', 'listbox');
    items.forEach(function (p, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sel-opt' + (i === prodSugIdx ? ' on' : '');
      b.setAttribute('role', 'option');
      /* 只展示统一名称，名称命中优先，编号仅作为命中兜底且不在列表露出 */
      b.textContent = prodDispName(p);
      b.setAttribute('title', p.name || '');
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        input.value = prodDispName(p);
        closeProdSug();
        prodUi.q = input.value;
        prodUi.page = 1;
        renderProductTable();
      });
      pop.appendChild(b);
    });
    document.body.appendChild(pop);
    prodSugPop = pop;
    placeProdSug();
  }

  function bindProdSearchSuggest() {
    var input = document.getElementById('prod-search');
    if (!input) return;

    input.addEventListener('input', function () {
      prodSugIdx = 0;
      openProdSug();
    });
    input.addEventListener('focus', function () {
      if (input.value.trim()) { prodSugIdx = 0; openProdSug(); }
    });
    input.addEventListener('keydown', function (e) {
      if (!prodSugPop) return;
      var opts = Array.prototype.slice.call(prodSugPop.querySelectorAll('.sel-opt'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        prodSugIdx = e.key === 'ArrowDown' ?
          Math.min(opts.length - 1, prodSugIdx + 1) :
          Math.max(0, prodSugIdx - 1);
        opts.forEach(function (o, i) { o.classList.toggle('on', i === prodSugIdx); });
        if (opts[prodSugIdx]) opts[prodSugIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (opts[prodSugIdx]) opts[prodSugIdx].click();
      } else if (e.key === 'Escape' || e.key === 'Esc') {
        closeProdSug();
      }
    });

    document.addEventListener('click', function (e) {
      if (!prodSugPop) return;
      if (prodSugPop.contains(e.target)) return;
      if (e.target === input) return;
      closeProdSug();
    }, true);
    window.addEventListener('scroll', placeProdSug, true);
    window.addEventListener('resize', placeProdSug);
  }

  function populateIncepSelect() {
    var sel = document.getElementById('incep-sel');
    if (!sel) return;
    var months = [];
    MODEL.concat(LIB_MODEL).forEach(function (item) {
      var m = String(item.product.inception || '').slice(0, 7);
      if (m && months.indexOf(m) === -1) months.push(m);
    });
    months.sort().reverse();
    var current = sel.value;
    sel.innerHTML = '<option value="">成立月份</option>' + months.map(function (m) {
      return '<option value="' + m + '">' + m + '</option>';
    }).join('');
    sel.value = months.indexOf(current) !== -1 ? current : '';
    syncSelLabel(sel);
  }

  /* 把下拉多选状态汇总到 prodUi（各 change 统一调用，避免重复渲染） */
  function syncFilterState() {
    prodUi.sale = selValues(document.getElementById('sale-sel'));
    prodUi.org = selValues(document.getElementById('org-sel'));
    prodUi.risk = selValues(document.getElementById('risk-sel'));
    prodUi.term = selValues(document.getElementById('term-sel'));
    prodUi.incep = selValues(document.getElementById('incep-sel'));
    /* 持仓状态：holding / cleared 可多选；均为空等同全部 */
    var holdSel = document.getElementById('hold-sel');
    var hv = selValues(holdSel);
    prodUi.holdHolding = hv.length === 0 || hv.indexOf('holding') !== -1;
    prodUi.holdCleared = hv.length === 0 || hv.indexOf('cleared') !== -1;
    /* 数据展示：per10k / ann 可多选；均为空等同全部 */
    var mSel = document.getElementById('m-sel');
    var mv = selValues(mSel);
    prodUi.mPer10k = mv.length === 0 || mv.indexOf('per10k') !== -1;
    prodUi.mAnn = mv.length === 0 || mv.indexOf('ann') !== -1;
  }

  function bindProductFilters() {
    var ids = ['sale-sel', 'org-sel', 'risk-sel', 'term-sel', 'incep-sel', 'hold-sel', 'm-sel'];
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', function () {
        syncFilterState();
        prodUi.page = 1;
        if (id === 'm-sel') applyProductCols();
        else renderProductTable();
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

    var search = document.getElementById('prod-search');
    if (search) search.addEventListener('input', function () {
      prodUi.q = search.value;
      prodUi.page = 1;
      renderProductTable();
    });

    /* 一键重置：清空搜索、下拉筛选、标签与数据展示模式 */
    var resetBtn = document.getElementById('prod-reset');
    if (resetBtn) resetBtn.addEventListener('click', function () {
      if (search) search.value = '';
      closeProdSug();
      ['sale-sel', 'org-sel', 'risk-sel', 'term-sel', 'incep-sel', 'hold-sel', 'm-sel'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        Array.prototype.forEach.call(el.options, function (o, j) { o.selected = (j === 0); });
        syncSelLabel(el);
      });
      Array.prototype.forEach.call(document.querySelectorAll('.filters .chip[data-flag]'), function (b) {
        b.classList.remove('on');
      });
      prodUi.q = ''; prodUi.sale = []; prodUi.org = []; prodUi.risk = [];
      prodUi.term = []; prodUi.incep = [];
      prodUi.flagNew = false; prodUi.flagFav = false;
      prodUi.holdHolding = true; prodUi.holdCleared = true;
      prodUi.mPer10k = true; prodUi.mAnn = true;
      prodUi.page = 1;
      applyProductCols();
      renderProductTable();
    });

    var pager = document.getElementById('prod-pages');
    if (pager) pager.addEventListener('click', function (e) {
      var cur = e.target.closest('.pg-cur');
      if (cur) {
        if (pgPop) closePagePop(); else openPagePop(cur);
        return;
      }
      var btn = e.target.closest('[data-page]');
      if (!btn || btn.disabled) return;
      var page = parseInt(btn.getAttribute('data-page'), 10);
      if (!page || page === prodUi.page) return;
      prodUi.page = page;
      renderProductTable();
    });
    document.addEventListener('click', function (e) {
      if (!pgPop) return;
      if (pgPop.contains(e.target) || (e.target.closest && e.target.closest('.pg-cur'))) return;
      closePagePop();
    }, true);
    window.addEventListener('scroll', function (e) {
      if (!pgPop) return;
      if (Date.now() - pgPopAt < 400) return;
      if (e.target === pgPop || (e.target && e.target.nodeType === 1 && pgPop.contains(e.target))) return;
      closePagePop();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePagePop();
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
      var del = e.target.closest('[data-del-product]');
      if (del) {
        var pid = del.dataset.delProduct;
        confirmDialog('确认从产品库删除该手工产品？删除后本地与云端同时移除。', '删除').then(function (ok) {
          if (!ok) return;
          del.disabled = true;
          window.STORE.removeProduct(pid).then(function () {
            mergeManualProducts();
            computeHoldings();
            renderAll();
            renderAddHistory();
            toast('已删除');
          }).catch(function (err) {
            del.disabled = false;
            toast((err && err.message) || '删除失败，请检查网络');
          });
        });
        return;
      }
      var det = e.target.closest('[data-detail]');
      if (det) openTradeFor(det.dataset.detail);
    });

    var addBtn = document.getElementById('open-add');
    if (addBtn) addBtn.addEventListener('click', function () {
      resetAddModal();
      renderAddHistory();
      var m = document.getElementById('modal-add');
      if (m) m.hidden = false;
    });
  }

  /* ---------------- 添加产品 ---------------- */
  var addState = { image: '', filename: '' };

  /* 本地 OCR：Tesseract.js 引擎与中文语言包随站点一起发布，识别全程在本机浏览器完成，
     不联网、不注册、不需要任何密钥，永久免费。worker/core/lang 均走站点内的相对路径。 */
  var OCR_BASE = './_shared/js/ocr/';
  var ocrWorkerPromise = null;
  var ocrLibPromise = null;
  /* 把图片 dataURL 缩放到长边不超过 maxSide，返回压缩后的 jpeg dataURL。
     失败时回传 null，调用方回退用原图。手机大截图靠这一步避免内存溢出。 */
  function shrinkImage(dataUrl, maxSide, done) {
    try {
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          if (!w || !h) { done(null); return; }
          if (w <= maxSide && h <= maxSide) {
            /* 已经够小，无需缩放，直接用原图 */
            done(dataUrl); return;
          }
          var scale = maxSide / Math.max(w, h);
          var nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
          var c = document.createElement('canvas');
          c.width = nw; c.height = nh;
          var ctx = c.getContext('2d');
          if (!ctx) { done(null); return; }
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, nw, nh);
          ctx.drawImage(img, 0, 0, nw, nh);
          done(c.toDataURL('image/jpeg', 0.92));
        } catch (e) { done(null); }
      };
      img.onerror = function () { done(null); };
      img.src = dataUrl;
    } catch (e) { done(null); }
  }
  /* 把任意异常对象转成可读的错误描述（Tesseract worker 错误常没有 message） */
  function describeErr(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    var parts = [];
    if (e.message) parts.push(e.message);
    else if (e.status && typeof e.status === 'string') parts.push(e.status);
    if (e.name && e.name !== 'Error' && parts.indexOf(e.name) < 0) parts.push(e.name);
    if (!parts.length) {
      try {
        var s = JSON.stringify(e);
        if (s && s !== '{}') parts.push(s);
      } catch (_) {}
    }
    if (!parts.length) parts.push(String(e));
    return parts.join(' / ').slice(0, 240);
  }
  /* 首次点识别时才加载 66KB 的主库，不拖慢看板首屏；之后复用同一个已加载的脚本 */
  function loadOcrLib() {
    if (typeof Tesseract !== 'undefined') return Promise.resolve();
    if (ocrLibPromise) return ocrLibPromise;
    ocrLibPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = OCR_BASE + 'tesseract.min.js?v=20261119';
      s.onload = function () {
        if (typeof Tesseract !== 'undefined') resolve();
        else { ocrLibPromise = null; reject(new Error('OCR 引擎加载异常')); }
      };
      s.onerror = function () { ocrLibPromise = null; reject(new Error('OCR 引擎文件缺失，请刷新重试')); };
      document.head.appendChild(s);
    });
    return ocrLibPromise;
  }
  function getOcrWorker(onProgress) {
    if (ocrWorkerPromise) return ocrWorkerPromise;
    ocrWorkerPromise = loadOcrLib().then(function () {
      return Tesseract.createWorker('chi_sim', 1, {
        workerPath: OCR_BASE + 'worker.min.js',
        corePath: OCR_BASE,
        langPath: OCR_BASE,
        gzip: true,
        logger: function (m) {
          if (onProgress && m && m.status && /load|recogniz|initializ/i.test(m.status)) {
            onProgress(m.status + (typeof m.progress === 'number' ? ' ' + Math.round(m.progress * 100) + '%' : ''));
          }
        }
      });
    }).catch(function (e) {
      ocrWorkerPromise = null;
      throw e;
    });
    return ocrWorkerPromise;
  }
  function aiMsg(text, kind) {
    var el = document.getElementById('add-ai-msg');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.className = 'ai-msg ' + (kind || 'busy');
    el.textContent = text;
  }
  function fillAddForm(f) {
    var map = {
      'add-name': f.name, 'add-code': f.regCode, 'add-org': f.org,
      'add-risk': f.risk, 'add-nav': f.nav, 'add-navdate': f.navDate, 'add-link': f.link
    };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (el && map[id] !== null && map[id] !== undefined && map[id] !== '') el.value = String(map[id]);
    });
  }

  /* 从本地 OCR 出来的杂乱文字里抽取结构化字段。OCR 对中文小字可能有个别错字，
     因此尽量用「格式特征」而不是语义：登记编码=Z+13位数字、风险=R1~R5、
     日期=YYYY-MM-DD/YYYY.MM.DD/YYYY年M月D日、净值=1.xxxx 形式的数字。 */
  function parseOcrFields(text) {
    var t = String(text || '').replace(/[，,]/g, ',').replace(/：/g, ':').replace(/[（）]/g, '()');
    var lines = t.split(/[\r\n]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    /* OCR 会在每个汉字间插空格，另做一份"去空格全文"供编码/风险/日期匹配 */
    var flat = t.replace(/\s+/g, '');
    var out = { name: '', regCode: '', org: '', risk: '', nav: '', navDate: '' };

    /* 登记编码：优先 Z 开头 + 13 位数字（理财网登记编码，容忍 O/0、I/1 混淆）。
       OCR 常把 Z 认成 2、把 0 认成 O，做字符归一后再匹配。 */
    var codeFlat = flat.replace(/O/g, '0').replace(/I/g, '1').replace(/l/g, '1');
    var mReg = codeFlat.match(/[Z2]\d{12,14}/);
    if (mReg) out.regCode = mReg[0].toUpperCase();
    if (!out.regCode) {
      /* 代销内部代码：形如 260INB045A00000000（数字+字母混合，长度 14~20）。
         必须是「同时含字母和数字」的串，避免把市值/日期/份额等纯数字误当编码。
         优先取靠近"代销/编码/代码"字样的行。 */
      var candidates = [];
      lines.forEach(function (ln) {
        var s = ln.replace(/\s+/g, '');
        var re = /(?=[0-9A-Za-z]{14,22}\b)(?=[0-9A-Za-z]*[A-Za-z])(?=[0-9A-Za-z]*[0-9])[0-9A-Za-z]{14,22}/g, mm;
        while ((mm = re.exec(s)) !== null) {
          candidates.push({ v: mm[0].toUpperCase(), near: /代销|编码|代码|产品代码/.test(ln) });
        }
      });
      if (candidates.length) {
        candidates.sort(function (a, b) { return (b.near ? 1 : 0) - (a.near ? 1 : 0); });
        out.regCode = candidates[0].v;
      }
    }

    /* 风险等级：R1~R5（去空格后直接找 Rn） */
    var mRisk = flat.match(/R([1-5])(?!\d)/i);
    if (mRisk) out.risk = 'R' + mRisk[1];

    /* 日期：OCR 常把分隔符 "/" "-" "." 认成 V、空格、字母等（如 2026/11V17、2026 11 17），
       故分隔符放宽为「1~3 个非数字字符」；两种数字分支把两位数放前面，避免 "11" 被截成 "1"。 */
    var mDate = flat.match(/(20\d{2})\D{1,3}(1[0-2]|0[1-9]|[1-9])\D{1,3}(3[01]|[12]\d|0[1-9]|[1-9])(?!\d)/) ||
                flat.match(/(20\d{2})(1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/);
    if (mDate) {
      function p2(n) { return n.length < 2 ? '0' + n : n; }
      out.navDate = mDate[1] + '-' + p2(mDate[2]) + '-' + p2(mDate[3]);
    }

    /* 净值：1.xxxx ~ 1.xxxxxxxx 形式，优先出现在"净值"字样附近的行。
       OCR 常把小数点认成空格/逗号/句号，或数字间夹空格，这里统一容错后再匹配。 */
    var navCandidates = [];
    lines.forEach(function (ln) {
      /* OCR 会在字间插空格（"单 位 净 值"），先整体去空格再判断是否净值行 */
      var flat = ln.replace(/\s+/g, '');
      var near = /净值|万份|收益/.test(flat);
      /* 关键：净值常与净值日期同一行（如 "1.002300 2026/11/17"），去空格后会粘成
         "1.0023002026/11/17"，若不先把日期剔除，净值正则会把年份数字吞进去。 */
      var noDate = flat.replace(/20\d{2}\D{1,3}\d{1,2}\D{1,3}\d{1,2}\D?/g, '');
      var cleaned = noDate.replace(/[。，,]/g, '.');
      /* 情形 A：小数点还在，形如 1.0045。净值小数位通常是 4 或 6 位，
         用 (?!\d) 防止贪婪吞掉后面粘连的数字。 */
      var re = /1[.]\d{4}(?:\d{2})?(?!\d)/g, mm;
      while ((mm = re.exec(cleaned)) !== null) navCandidates.push({ v: mm[0], near: near, strong: true });
      /* 情形 B：小数点被 OCR 吞掉，净值为 1xxxx 的 5 位数字（如 10045 -> 1.0045）。
         只在"净值"行里做这种补全，避免把编码/日期误判成净值。 */
      if (near) {
        var re2 = /\b1\d{4,7}\b/g, m2;
        while ((m2 = re2.exec(cleaned)) !== null) {
          navCandidates.push({ v: m2[0].slice(0, 1) + '.' + m2[0].slice(1), near: near, strong: false });
        }
      }
    });
    if (navCandidates.length) {
      navCandidates.sort(function (a, b) {
        if (a.near !== b.near) return (b.near ? 1 : 0) - (a.near ? 1 : 0);
        return (b.strong ? 1 : 0) - (a.strong ? 1 : 0);
      });
      out.nav = navCandidates[0].v;
    }

    /* 先识别发行机构：形如"XX理财 / XX银行 / XX理财有限责任公司"的短行，
       只认以理财/银行结尾的短行，排除带其它字段标签的行。
       例："中邮理财有限责任公司"、"招银理财"、"建信理财" */
    var orgNoise = /净值|日期|风险|编码|代码|名称|基准|收益|类型|期限|天|号|期/;
    var orgIdx = -1;
    var orgRe = /[\u4e00-\u9fa5]{2,10}(理财|银行|理财有限责任公司|理财股份有限公司|银行股份有限公司|银行有限责任公司)(有限责任公司|有限公司|股份有限公司)?/;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].replace(/^(发行机构|管理人|产品发行|发行人)[:：]?\s*/, '');
      /* 优先整行就是机构名（最干净） */
      if (/^[\u4e00-\u9fa5]{2,10}(理财|银行)(有限责任公司|有限公司|股份有限公司)?$/.test(ln) &&
          !orgNoise.test(ln)) {
        out.org = ln.trim(); orgIdx = i; break;
      }
    }
    /* 退而求其次：机构名与编码/代销等混在同一行时，从行内抠出机构名。
       例："260INB045A00000000 代销 | 中邮理财有限责任公司"。
       注意此时不要把该行标记为 orgIdx，否则若这行恰好也是产品名行
       （如"中邮理财优盛.鸿锦...7天45号"含"中邮理财"），会把真正的产品名行排除掉。 */
    if (!out.org) {
      for (var k = 0; k < lines.length; k++) {
        var mm = lines[k].match(orgRe);
        /* 只在机构名后面跟着"代销/有限公司/有限责任公司"等明确机构标识时采信，
           避免从纯产品名中抠出前缀 */
        if (mm && /代销|理财有限责任公司|理财股份有限公司|银行股份有限公司|银行有限责任公司/.test(lines[k])) {
          out.org = mm[0];
          break;
        }
      }
    }

    /* 产品名称：
       1) 优先带"产品名称:"标签的行（最可靠）；
       2) 否则取含"数字+天/号/期"或产品关键词、且不是机构行的最长行；
       3) 排除纯机构名、字段标签行、含净值/日期的行。 */
    var labeled = -1;
    for (var j = 0; j < lines.length; j++) {
      if (/^(产品名称|名称)\s*[:：]/.test(lines[j])) { labeled = j; break; }
    }
    if (labeled >= 0) {
      out.name = lines[labeled].replace(/^(产品名称|名称)\s*[:：]?\s*/, '').trim();
    } else {
      var noise = /^(净值|单位净值|累计净值|日期|净值日期|风险等级|产品代码|登记编码|产品名称|发行机构|产品类型|七日年化|业绩比较基准)/;
      var scored = lines.map(function (ln, idx) {
        var s = 0;
        if (idx === orgIdx) return { ln: ln, s: -99 };
        /* 排除手机状态栏时间（"17:59 HS"）、不含任何中文/字母的纯数字符号行。
           注意不能用 /^[\W\d]+$/：非 unicode 模式下中文也落入 \W，会误杀产品名。 */
        if (/^\d{1,2}:\d{2}/.test(ln) || !/[\u4e00-\u9fa5A-Za-z]/.test(ln)) return { ln: ln, s: -99 };
        if (/\d+\s*(天|号|期)/.test(ln)) s += 5;
        if (/添利|嘉鑫|安盈|悦享|鸿锦|金鼎|睿|固收|现金管理/.test(ln)) s += 3;
        if (/理财|产品/.test(ln)) s += 1;
        if (noise.test(ln)) s -= 6;
        if (/\d{4}[-./年]/.test(ln) || /1[.。]\d{3}/.test(ln) || /[Zz]\d{10}/.test(ln)) s -= 4;
        if (ln.length >= 6 && ln.length <= 60) s += 1;
        return { ln: ln, s: s };
      }).sort(function (a, b) { return b.s - a.s; });
      if (scored.length && scored[0].s > 0) {
        out.name = scored[0].ln.replace(/^(产品名称|名称)[:：]?\s*/, '').trim();
      }
    }
    /* OCR 常在中英文/数字间插入空格（"合 盛 多 元 30 天"），
       去掉中文之间、中文与数字之间的空格，保留必要的英文词组空格 */
    if (out.name) {
      out.name = out.name.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2')
                         .replace(/([\u4e00-\u9fa5])\s+(\d)/g, '$1$2')
                         .replace(/(\d)\s+([\u4e00-\u9fa5])/g, '$1$2')
                         .replace(/\s{2,}/g, ' ').trim();
    }
    return out;
  }

  function resetAddModal() {
    ['add-name', 'add-code', 'add-org', 'add-nav', 'add-navdate', 'add-link'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    var risk = document.getElementById('add-risk');
    if (risk) risk.value = '';
    addState.image = ''; addState.filename = '';
    var imgText = document.getElementById('add-image-text');
    if (imgText) imgText.textContent = '上传截图识别';
    var lbl = document.getElementById('add-image-label');
    if (lbl) lbl.classList.remove('has-img');
    var file = document.getElementById('add-image');
    if (file) file.value = '';
    aiMsg('');
  }

  /* 本地 OCR 识别截图：全程在本机浏览器完成，不联网、不用密钥、永久免费。 */
  function runOcr() {
    var run = document.getElementById('add-ocr-run');
    if (!addState.image) { aiMsg('请先上传一张产品详情页截图', 'err'); return; }
    if (run) run.disabled = true;
    aiMsg('正在加载本地识别引擎（首次约需几秒）…', 'busy');
    /* 识别超时保护：手机上 wasm/内存问题可能让 worker 卡住不返回，60 秒后主动失败 */
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      aiMsg('识别超时，可能是当前设备性能或内存不足。请关闭其它应用后重试，或直接手工填写', 'err');
      if (run) run.disabled = false;
    }, 60000);
    getOcrWorker(function (p) {
      if (!timedOut) aiMsg('本地识别中 ' + p, 'busy');
    }).then(function (worker) {
      if (timedOut) return;
      return worker.recognize(addState.image).then(function (res) {
        if (timedOut) return;
        clearTimeout(timer);
        var text = res && res.data && res.data.text ? res.data.text : '';
        window.__lastOcrText = text;
        var f = parseOcrFields(text);
        var filled = [f.name, f.regCode, f.nav, f.navDate].filter(Boolean).length;
        if (!filled) {
          aiMsg('没识别出有效字段。请换一张更清晰的截图（正对屏幕、文字完整），或直接手工填写', 'err');
          return;
        }
        fillAddForm(f);
        var got = [];
        if (f.name) got.push('名称'); if (f.regCode) got.push('编码');
        if (f.risk) got.push('风险'); if (f.nav) got.push('净值'); if (f.navDate) got.push('日期');
        aiMsg('已识别并填入：' + got.join('、') + '。OCR 可能有个别错字，请核对后再保存', 'ok');
      });
    }).catch(function (e) {
      if (timedOut) return;
      clearTimeout(timer);
      /* 诊断信息尽量暴露真实原因，避免只显示"未知错误"无从排查 */
      var detail = describeErr(e);
      var hint = /memory|allocate|out of memory|buffer/i.test(detail)
        ? '设备内存不足，请关闭其它应用或换小图重试'
        : /simd|wasm|webassembly|compile/i.test(detail)
          ? '当前浏览器不支持所需特性，请换用较新的浏览器（如最新版 Chrome/Edge/Safari）'
          : '可换一张更清晰的截图重试';
      aiMsg('本地识别失败：' + detail + '。' + hint + '；也可直接手工填写', 'err');
    }).finally(function () {
      clearTimeout(timer);
      if (run) run.disabled = false;
    });
  }

  /* 添加产品历史记录：云端 MANUAL_HISTORY（添加 / 删除） */
  function histEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function fmtHistTime(s) {
    var d = new Date(s);
    if (isNaN(d.getTime())) return '';
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function renderAddHistory() {
    var box = document.getElementById('add-hist');
    var list = document.getElementById('add-hist-list');
    if (!box || !list) return;
    var hist = (window.MANUAL_HISTORY || []).slice(0, 15);
    box.hidden = !hist.length;
    list.innerHTML = hist.map(function (r) {
      var isDel = r.action === 'del';
      var meta = [r.regCode, r.saleChannel].filter(Boolean).join(' · ');
      return '<li><b class="' + (isDel ? 'del' : 'add') + '">' + (isDel ? '删除' : '添加') + '</b>' +
        '<span title="' + histEsc(r.name || '') + '">' + histEsc(r.name || '—') + '</span>' +
        (meta ? '<em>' + histEsc(meta) + '</em>' : '') +
        '<i>' + fmtHistTime(r.at) + '</i></li>';
    }).join('');
  }

  function bindAddModal() {
    var submit = document.getElementById('submit-add');
    if (!submit || submit.dataset.bound) return;
    submit.dataset.bound = '1';
    var busy = false;

    /* 图片识别：上传截图转 dataURL，一键识别填表，配置面板开关 */
    var fileEl = document.getElementById('add-image');
    if (fileEl) fileEl.addEventListener('change', function () {
      var f = fileEl.files && fileEl.files[0];
      if (!f) return;
      if (!/^image\//.test(f.type)) { aiMsg('请选择图片文件', 'err'); return; }
      if (f.size > 8 * 1024 * 1024) { aiMsg('图片请小于 8MB', 'err'); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var raw = String(reader.result || '');
        /* 大图（手机截图常 1200×2600）直接喂给本地 OCR 极易在手机上内存溢出/超时，
           这里先把长边压到 1600px 再识别，速度与稳定性都大幅提升，文字清晰度足够。 */
        shrinkImage(raw, 1600, function (small) {
          addState.image = small || raw;
          addState.filename = f.name;
          var txt = document.getElementById('add-image-text');
          if (txt) txt.textContent = '已选：' + (f.name.length > 12 ? f.name.slice(0, 12) + '…' : f.name);
          var lbl = document.getElementById('add-image-label');
          if (lbl) lbl.classList.add('has-img');
          aiMsg('截图已就绪，点「一键识别填入」提取信息（本地识别，无需联网）', 'ok');
        });
      };
      reader.onerror = function () { aiMsg('图片读取失败', 'err'); };
      reader.readAsDataURL(f);
    });
    var ocrBtn = document.getElementById('add-ocr-run');
    if (ocrBtn) ocrBtn.addEventListener('click', runOcr);
    submit.addEventListener('click', function () {
      if (busy) return;
      var name = (document.getElementById('add-name').value || '').trim();
      var code = (document.getElementById('add-code').value || '').trim();
      var org = (document.getElementById('add-org').value || '').trim();
      var risk = document.getElementById('add-risk').value || '';
      var channel = document.getElementById('add-channel').value || '';
      var nav = Number((document.getElementById('add-nav').value || '').trim());
      var navDate = (document.getElementById('add-navdate').value || '').trim();
      var link = (document.getElementById('add-link').value || '').trim();
      if (link && !/^https?:\/\//i.test(link)) { toast('产品链接需以 http:// 或 https:// 开头'); return; }
      if (!name) { toast('请填写产品名称'); return; }
      /* 登记编码、净值、净值日期均选填：只填名称即可添加，系统每天按名称反查编码并抓净值。
         但若填了净值就必须同时给日期，否则前端无法定位净值点、会显示为空。 */
      if (nav > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(navDate)) { toast('填了最新净值，请同时选择净值日期'); return; }
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
        navDate: navDate,
        link: link
      };
      submit.disabled = true;
      busy = true;
      window.STORE.addProduct(item).then(function () {
        busy = false;
        submit.disabled = false;
        mergeManualProducts();
        computeHoldings();
        /* 清空产品库搜索与页码，保证刚添加的产品立即可见 */
        var si = document.getElementById('prod-search');
        if (si) si.value = '';
        prodUi.q = '';
        prodUi.page = 1;
        renderAll();
        resetAddModal();
        renderAddHistory();
        document.getElementById('modal-add').hidden = true;
        toast('已加入产品库');
      }).catch(function (e) {
        busy = false;
        submit.disabled = false;
        toast((e && e.message) || '保存失败，请检查网络');
      });
    });
  }

  /* ---------------- 交易 ---------------- */
  var flowState = { pid: '', year: '', month: '', type: '', status: '' };
  var flowOpenMonths = {};
  /* 交易流水批量删除：勾选态 + 当前列表 id（用于全选与计数） */
  var flowSel = {};
  var flowIds = [];
  var flowIdMonth = {};

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

  /* 站内确认框：只有点击「确定」才 resolve(true)，删除等危险操作一律先等确认 */
  function confirmDialog(msg, okText) {
    return new Promise(function (resolve) {
      var modal = document.getElementById('modal-confirm');
      var txt = document.getElementById('confirm-text');
      var ok = document.getElementById('confirm-ok');
      var cancel = document.getElementById('confirm-cancel');
      if (!modal || !txt || !ok || !cancel) { resolve(false); return; }
      txt.textContent = msg;
      ok.textContent = okText || '确定';
      modal.hidden = false;
      function done(v) {
        modal.hidden = true;
        ok.onclick = null;
        cancel.onclick = null;
        modal.onclick = null;
        resolve(v);
      }
      ok.onclick = function () { done(true); };
      cancel.onclick = function () { done(false); };
      modal.onclick = function (e) { if (e.target === modal) done(false); };
    });
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
    var items = sortBySearch(allUniqueProducts().filter(function (p) {
      return (p.short || '').toLowerCase().indexOf(kw) !== -1 ||
        (p.name || '').toLowerCase().indexOf(kw) !== -1 ||
        prodDispName(p).toLowerCase().indexOf(kw) !== -1 ||
        (p.regCode || '').toLowerCase().indexOf(kw) !== -1;
    }), kw).slice(0, 6);
    var hid = document.getElementById('trade-prod');
    var cur = hid ? hid.value : '';
    list.innerHTML = items.map(function (p) {
      return '<div class="sr-row' + (p.id === cur ? ' on' : '') + '" data-pid="' + p.id + '" title="' + (p.name || '') + '"><span>' +
        prodDispName(p) + '</span></div>';
    }).join('') || '<div class="sr-row" style="cursor:default"><span class="muted">未找到匹配产品</span></div>';
  }

  /* 参考基金交易规则切换录入方向：申购填金额、系统折算份额；赎回/清仓填份额、系统折算金额 */
  function applyTradeMode() {
    var typeEl = document.getElementById('trade-type');
    var shEl = document.getElementById('trade-shares');
    var amtEl = document.getElementById('trade-amount');
    var applyEl = document.getElementById('trade-apply');
    var amtLabel = document.getElementById('trade-amount-label');
    var shLabel = document.getElementById('trade-shares-label');
    var applyLabel = document.getElementById('trade-apply-label');
    var t = (typeEl && typeEl.value) || '申购';
    var isBuy = t === '申购';
    if (amtLabel) amtLabel.textContent = isBuy ? '申购金额' : (t + '金额');
    if (shLabel) shLabel.textContent = isBuy ? '份额' : (t + '份额');
    if (applyLabel) applyLabel.textContent = t + '日期';
    if (applyEl) applyEl.placeholder = '请选择' + t + '日期';
    if (amtEl) {
      amtEl.readOnly = !isBuy;
      amtEl.placeholder = isBuy ? '填写申购金额，按成交净值折算份额' : '按份额与成交净值自动计算';
    }
    if (shEl) shEl.readOnly = isBuy || t === '清仓';
  }

  function syncTradeForm() {
    var p = tradeProduct();
    if (!p) return;
    var navEl = document.getElementById('trade-nav');
    var applyEl = document.getElementById('trade-apply');
    var dateEl = document.getElementById('trade-confirm');
    var typeEl = document.getElementById('trade-type');
    var shEl = document.getElementById('trade-shares');
    var amtEl = document.getElementById('trade-amount');
    var applyDate = applyEl ? applyEl.value : '';
    var confirmDate = nextWorkday(applyDate);
    /* 成交净值按申购日（T 日）净值；T 日净值未披露时显示「待确认」，不用最近净值预估。
       确认日期默认 T+1 工作日。两者均自动带出，用户可在提交前手工修改。 */
    var navOn = applyDate ? navOnDate(p, applyDate) : null;
    if (dateEl) dateEl.value = confirmDate;
    if (navEl) {
      navEl.value = navOn ? Number(navOn).toFixed(6) : '';
      navEl.placeholder = navOn ? '' : '待确认/手工填写';
      navEl.classList.toggle('pending', !navOn);
    }
    var navVal = Number(navEl && navEl.value) || 0;
    var h = HOLD_BY_PID[p.id];
    var t = (typeEl && typeEl.value) || '申购';
    var isBuy = t === '申购';
    applyTradeMode();
    if (shEl) {
      if (isBuy) shEl.placeholder = '按金额与成交净值自动计算';
      else if (t === '清仓') {
        shEl.value = h && h.shares > 0 ? h.shares.toFixed(2) : '';
        shEl.placeholder = '';
      } else {
        shEl.placeholder = '可卖 ' + ((h && h.shares) ? h.shares.toFixed(2) : '0.00') + ' 份';
      }
    }
    /* 赎回/清仓：金额 = 份额 × 成交净值 */
    if (!isBuy && shEl && shEl.value && navVal && amtEl) {
      amtEl.value = (Number(shEl.value) * navVal).toFixed(2);
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
    /* 新增/修改交易都写 canonical id，避免再产生 LZ… 与 p… 两套 pid */
    if (hid) hid.value = canonicalPidById((edit ? edit.pid : pid) || '');
    var qEl = document.getElementById('trade-prod-q');
    var curP = findProductById(hid ? hid.value : '');
    if (qEl) qEl.value = curP ? prodDispName(curP) : '';
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
      var edNav = Number(edit.confirmNav) > 0 ? Number(edit.confirmNav) : null;
      if (!(edNav > 0)) {
        var edP = findProductById(edit.pid);
        var edN = navOnDate(edP, edit.applyDate || edit.confirmDate);
        if (typeof edN === 'number' && edN > 0) edNav = edN;
      }
      var edShares = edit.shares || (edNav > 0 ? edit.amount / edNav : 0);
      if (shEl) shEl.value = edShares ? String(Math.round(edShares * 100) / 100) : '';
      if (amtEl) amtEl.value = edit.amount ? String(edit.amount) : '';
      if (navEl) {
        if (edNav > 0) {
          navEl.value = edNav.toFixed(6);
          navEl.placeholder = '';
          navEl.classList.remove('pending');
        } else {
          navEl.value = '';
          navEl.placeholder = '待确认';
          navEl.classList.add('pending');
        }
      }
      if (applyEl) applyEl.value = edit.applyDate || edit.confirmDate || '';
      if (dateEl) dateEl.value = edit.confirmDate || edit.applyDate || '';
      if (chEl) chEl.value = edit.saleChannel || '建设银行';
    } else {
      syncTradeForm();
      applyTypeLimits();
    }
    /* 成交净值与确认日期均可人工修改后再提交（自动带出默认值，允许覆盖） */
    if (navEl) navEl.readOnly = false;
    if (dateEl) dateEl.readOnly = false;
    applyTradeMode();
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
    if (tType === '申购') {
      if (!(shares > 0) && amount > 0 && nav > 0) shares = amount / nav;
      if (!(amount > 0) && shares > 0 && nav > 0) amount = shares * nav;
    } else if (shares > 0 && nav > 0) {
      /* 赎回/清仓以份额为准，金额一律由份额 × 成交净值算出 */
      amount = shares * nav;
    }
    if (!dateEl.value && applyEl && applyEl.value) dateEl.value = nextWorkday(applyEl.value);
    /* 净值待确认也可以先提交：申购记金额、赎回/清仓记份额，净值披露后自动折算并计入持仓 */
    var navPending = !(nav > 0);
    if (navPending) {
      if (tType === '申购') {
        if (!(amount > 0)) { toast('请填写申购金额'); return; }
      } else if (!(shares > 0)) {
        toast('请填写' + tType + '份额');
        return;
      }
    }
    if (!dateEl.value || (applyEl && !applyEl.value)) {
      toast('请选择' + tType + '日期');
      return;
    }
    if (!navPending && !(shares > 0)) {
      toast(tType === '申购' ? '请填写申购金额' : '请填写' + tType + '份额');
      return;
    }
    var btn = document.getElementById('trade-submit');
    if (btn) btn.disabled = true;
    var body = {
      pid: p.id,
      type: tType,
      shares: (navPending && tType === '申购') ? 0 : Math.round(shares * 100) / 100,
      amount: Math.round(amount * 100) / 100,
      confirmNav: nav > 0 ? nav : 0,
      applyDate: applyEl ? applyEl.value : dateEl.value,
      confirmDate: dateEl.value,
      saleChannel: chEl ? chEl.value : ''
    };
    var req = editId ? window.STORE.update(editId, body) : window.STORE.add(body);
    req.then(function (res) {
      if (btn) btn.disabled = false;
      if (!res || !res.ok) { toast((res && res.message) || '提交失败'); return; }
      toast(editId ? '交易已修改' : ('已录入 ' + typeEl.value + (navPending ? '（净值待确认，披露后自动更新）' : '')));
      refreshAfterWrite();
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
      if (hid) hid.value = canonicalPidById(pid);
      /* 选中后把产品名称回填到搜索框，并收起候选列表 */
      var picked = findProductById(pid);
      if (qEl) qEl.value = picked ? prodDispName(picked) : (row.querySelector('span') || {}).textContent || '';
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
      var sh0 = document.getElementById('trade-shares');
      if (sh0) sh0.value = '';
      var amt0 = document.getElementById('trade-amount');
      if (amt0) amt0.value = '';
      syncTradeForm();
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

  /* 重置交易流水的年月/类型/状态筛选（不改产品维度）。
     顶部「覆盖产品」选择变化时必须调用：否则流水会沿用默认的“最近交易月”，
     导致只有该月有交易的产品可见，其余产品被误判为「暂无符合条件的交易流水」。 */
  function resetFlowFilters() {
    flowState.year = '';
    flowState.month = '';
    flowState.type = '';
    flowState.status = '';
    var ys = document.getElementById('flow-year');
    var ms = document.getElementById('flow-month');
    var ts = document.getElementById('flow-type-sel');
    var ss = document.getElementById('flow-status-sel');
    if (ys) ys.value = '';
    if (ms) ms.value = '';
    if (ts) ts.value = '';
    if (ss) ss.value = '';
  }

  /* 交易流水按产品过滤（仅更新状态与渲染，不切换页签） */
  function filterFlowByProduct(pid) {
    flowState.pid = pid ? canonicalPidById(pid) : '';
    resetFlowFilters();
    /* 从产品库点进某只产品时，若它不在当前全局筛选范围内，先纳入选中，避免被全局筛选挡掉 */
    if (flowState.pid && selectedIds.indexOf(flowState.pid) === -1 &&
        pickableProducts().some(function (p) { return p.id === flowState.pid; })) {
      selectedIds.push(flowState.pid);
      applySelection();
    }
    /* 月份默认展开，折叠仅由人工点击月份行触发 */
    flowOpenMonths = {};
    renderFlows();
    renderTradeSummary();
  }

  function openTradeFor(pid) {
    filterFlowByProduct(pid);
    switchTab('trade');
    closePanel();
  }

  /* 持仓汇总的产品名 → 产品库：清空筛选，按产品名过滤并滚动到列表 */
  function gotoProduct(pid) {
    var p = findProductById(pid);
    if (!p) return;
    switchTab('prod');
    ['sale-sel', 'org-sel', 'risk-sel', 'term-sel', 'incep-sel', 'hold-sel'].forEach(function (id) {
      var sel = document.getElementById(id);
      if (!sel) return;
      Array.prototype.forEach.call(sel.options, function (o, j) { o.selected = (j === 0); });
      syncSelLabel(sel);
    });
    prodUi.sale = []; prodUi.org = []; prodUi.risk = []; prodUi.term = []; prodUi.incep = [];
    prodUi.flagNew = false; prodUi.flagFav = false;
    Array.prototype.forEach.call(document.querySelectorAll('.filters .chip[data-flag]'), function (b) {
      b.classList.remove('on');
    });
    prodUi.holdHolding = true; prodUi.holdCleared = true;
    var search = document.getElementById('prod-search');
    if (search) search.value = p.short || p.name;
    prodUi.q = p.short || p.name;
    prodUi.page = 1;
    renderProductTable();
    var tbl = document.getElementById('prod-table');
    var sec = tbl && tbl.closest('section');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        shares: h.shares, cost: h.cost, mv: h.mv, profit: h.profit, holdProfit: h.unrealized,
        realized: h.realized, ann: h.ann,
        days: h.days, accrualDays: h.accrualDays, cleared: h.cleared, tx: h.tx, pending: false
      });
    });
    var pend = {};
    ((window.TRANSACTIONS && window.TRANSACTIONS.items) || []).forEach(function (t) {
      if (t.type !== '申购' || txStatus(t) !== '在途') return;
      var p = findProductById(t.pid);
      if (!p) return;
      var latestNav = p.nav[p.nav.length - 1];
      var nav = Number(t.confirmNav) || navForConfirm(p, t.applyDate || t.confirmDate) || latestNav || 1;
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
        row.holdProfit = row.mv - row.cost;
        row.profit = row.holdProfit + (row.realized || 0);
        var accDays = row.accrualDays || row.days;
        row.ann = (accDays > 0 && row.cost > 0) ? row.holdProfit / row.cost * 365 / accDays * 100 : row.ann;
        row.pending = true;
      } else {
        rows.push({
          product: q.product, latestDate: q.latestDate, latestNav: q.latestNav,
          shares: q.shares, cost: q.cost, mv: q.shares * q.latestNav,
          profit: q.shares * q.latestNav - q.cost,
          holdProfit: q.shares * q.latestNav - q.cost, realized: 0,
          ann: null, days: 0, cleared: false, tx: q.tx, pending: true
        });
      }
    });
    return rows;
  }

  function renderTradeSummary() {
    var tbody = document.getElementById('sum-body');
    if (!tbody) return;
    var rows = summaryRows().filter(function (r) { return inGlobalScope(r.product.id); });
    if (flowState.pid) {
      rows = rows.filter(function (r) { return samePid(r.product.id, flowState.pid); });
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
      /* 在途标记与交易流水联动：申购待确认，或存在在途赎回/清仓单 */
      var inflight = !!h.pending || (!h.cleared && hasInflightTx(p.id));
      var inflightTip = h.pending
        ? ' title="申购待确认：确认日净值未披露，按最新净值估算计入"'
        : ' title="在途：确认日未到或确认日净值未披露，确认后自动更新"';
      return '<tr>' +
        '<td><div class="pname"><a class="plink" href="javascript:void(0)" data-goto-prod="' + p.id + '" title="在产品库中查看「' + (p.name || '') + '」">' +
          prodDispName(p) + '</a>' +
          '<span class="ptags">' +
          (inflight ? '<span class="tag np"' + inflightTip + '>在途</span>' : '') +
          (h.cleared ? '<span class="cleared-date">' +
            (h.tx && h.tx.confirmDate ? h.tx.confirmDate.slice(5).replace('-', '.') : '') + ' 清仓</span>' : '') +
          '</span>' +
          '</div></td>' +
        '<td class="c num">' + (h.latestDate ? withBadge(mmdd(h.latestDate), navLagBadge(h.product)) : '—') + '</td>' +
        '<td class="r num ' + colorBy(h.holdProfit) + '" title="持仓收益（仅当前持仓份额）= 市值 − 剩余成本">' + fmtSigned(h.holdProfit) + '</td>' +
        '<td class="r num ' + colorBy(h.ann) + '">' + fmtAnn(h.ann) + '</td>' +
        '<td class="r num ' + colorBy(h.profit) + '" title="累计收益 = 持仓收益 + 已赎回部分已实现">' + fmtSigned(h.profit) + '</td>' +
        '<td class="r num">' + fmtMoney(h.mv) + '</td>' +
        '<td class="c num">' + fmtNav(h.latestNav) + '</td>' +
        '<td class="r num">' + fmtMoney(h.shares) + '</td>' +
        '<td class="c num dcell" title="持仓天数 ' + h.days + ' 天 = 今天 − 起息日 ' + (h.effStartDate || '') +
          '；年化按计息 ' + (h.accrualDays || h.days) + ' 天（至最新净值日 ' + (h.latestDate || '') + '）折算">' +
          '<span class="days">' + h.days + '</span><i class="dunit">天</i></td>' +
        '<td class="c num dcell">' + (listingDaysOf(p) === null ? '—' :
          '<span class="days">' + listingDaysOf(p) + '</span><i class="dunit">天</i>') + '</td>' +
        '<td class="c"><button class="mini buy" data-act="add" data-pid="' + p.id + '">加购</button> ' +
          '<button class="mini sell" data-act="redeem" data-pid="' + p.id + '"' + (canSell ? '' : noShareTip) + '>赎回</button> ' +
          '<button class="mini warn" data-act="close" data-pid="' + p.id + '"' + (canClose ? '' : (canSell ? pendingTip : noShareTip)) + '>清仓</button></td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="11" class="c muted" style="padding:28px">' + (flowState.pid ? '该产品暂无持仓' : '暂无持仓') + '</td></tr>';

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
      if (flowState.pid && !samePid(t.pid, flowState.pid)) return;
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
      if (!inGlobalScope(t.pid)) return false;
      if (flowState.pid && !samePid(t.pid, flowState.pid)) return false;
      if (flowState.year && t.applyDate.slice(0, 4) !== flowState.year) return false;
      if (flowState.month !== '' && (+t.applyDate.slice(5, 7) - 1) !== +flowState.month) return false;
      if (flowState.type && (t.type || '申购') !== flowState.type) return false;
      if (flowState.status && txStatus(t) !== flowState.status) return false;
      return true;
    }).sort(function (a, b) { return b.applyDate.localeCompare(a.applyDate); });

    /* 当前筛选结果：供全选、按月全选、批量删除使用；切走的选择自动清理 */
    flowIds = items.map(function (t) { return t.id; });
    flowIdMonth = {};
    items.forEach(function (t) { flowIdMonth[t.id] = t.applyDate.slice(0, 7); });
    Object.keys(flowSel).forEach(function (id) {
      if (!flowIdMonth[id]) delete flowSel[id];
    });

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
      var open = flowOpenMonths[mk] !== false;
      var sum = {};
      list.forEach(function (t) {
        var k = t.type || '申购';
        if (!sum[k]) sum[k] = { n: 0, amt: 0 };
        sum[k].n += 1;
        sum[k].amt += txAmount(t, t._p) || 0;
      });
      var meta = ['申购', '赎回', '清仓'].filter(function (k) { return sum[k] && sum[k].n; })
        .map(function (k) { return k + ' ' + sum[k].n + ' 笔 ' + moneyBrief(sum[k].amt); })
        .join(' · ');
      var head = '<tr class="flow-month' + (open ? ' open' : '') + '" data-mk="' + mk + '">' +
        '<td colspan="10"><input type="checkbox" data-mk-chk="' + mk + '"' +
        (list.every(function (t) { return flowSel[t.id]; }) ? ' checked' : '') + '>' +
        '<span class="fm-caret">▸</span>' + mk.slice(0, 4) + '年' + (+mk.slice(5, 7)) + '月' +
        '<span class="fm-meta">共 ' + list.length + ' 笔 · ' + meta + '</span></td></tr>';
      var rows = list.map(function (t) {
        var p = t._p;
        var st = txStatus(t);
        return '<tr class="flow-detail"' + (open ? '' : ' hidden') + '>' +
          '<td class="chk-col"><input type="checkbox" data-chk="' + t.id + '"' +
            (flowSel[t.id] ? ' checked' : '') + '></td>' +
          '<td class="num">' + t.applyDate + '</td>' +
          '<td><div class="pname">' + (p ? prodDispName(p) : t.pid) + '</div></td>' +
          '<td class="c"><span class="tag' + (t.type === '赎回' || t.type === '清仓' ? ' new' : '') + '">' + t.type + '</span></td>' +
          '<td class="r num">' + fmtMoney(txShares(t, p)) + '</td>' +
          '<td class="r num">' + (st === '在途' ? '<span class="pending-nav">待确认</span>' : fmtNav(txConfirmNav(t, p))) + '</td>' +
          '<td class="r num">' + (txAmount(t, p) === null ? '<span class="pending-nav">待确认</span>' : fmtMoney(txAmount(t, p))) + '</td>' +
          '<td class="c num">' + t.confirmDate + '</td>' +
          '<td class="c"><span class="tag' + (st === '在途' ? ' np' : '') + '" title="' +
            (st === '在途' ? '在途：' + txPendingReason(t) + '，暂不计入持仓；净值披露后自动转为已确认' : '已确认并计入持仓') + '">' + st + '</span></td>' +
          '<td class="c"><button class="mini" data-edit="' + t.id + '">修改</button> ' +
            '<button class="mini warn" data-del="' + t.id + '">删除</button></td>' +
          '</tr>';
      }).join('');
      return head + rows;
    }).join('') || '<tr><td colspan="10" class="c muted" style="padding:28px">暂无符合条件的交易流水</td></tr>';

    var filterEl = document.getElementById('trade-filter');
    var nameEl = document.getElementById('trade-filter-name');
    if (filterEl) {
      var scopeActive = selectedIds.length < pickableProducts().length;
      if (flowState.pid || scopeActive) {
        filterEl.hidden = false;
        var parts = [];
        if (scopeActive) parts.push(selectedIds.length ? '已选 ' + selectedIds.length + ' 款' : '未选择产品');
        if (flowState.pid) parts.push(shortOf(flowState.pid));
        if (nameEl) nameEl.textContent = parts.join(' · ');
      } else {
        filterEl.hidden = true;
      }
    }
    updateFlowArrows();
    syncFlowSelBar();
  }

  /* 勾选计数 → 全选态、按月勾选态、批量删除按钮显隐 */
  function syncFlowSelBar() {
    var ids = Object.keys(flowSel);
    var n = ids.length;
    var btn = document.getElementById('flow-del-sel');
    if (btn) {
      btn.hidden = !n;
      btn.textContent = n ? '删除所选 ' + n : '删除所选';
    }
    var all = document.getElementById('flow-check-all');
    if (all) {
      all.checked = flowIds.length > 0 && n >= flowIds.length;
      all.indeterminate = n > 0 && n < flowIds.length;
    }
    Array.prototype.forEach.call(document.querySelectorAll('#flow-body [data-mk-chk]'), function (box) {
      var mk = box.getAttribute('data-mk-chk');
      var total = 0, hit = 0;
      flowIds.forEach(function (id) {
        if (flowIdMonth[id] !== mk) return;
        total++;
        if (flowSel[id]) hit++;
      });
      box.checked = total > 0 && hit === total;
      box.indeterminate = hit > 0 && hit < total;
    });
  }

  function selectedFlowIds() {
    return Object.keys(flowSel).filter(function (id) { return flowSel[id]; });
  }

  function bindTrade() {
    var ys = document.getElementById('flow-year');
    if (ys) ys.addEventListener('change', function () { flowState.year = ys.value; renderFlows(); });
    var ms = document.getElementById('flow-month');
    if (ms) ms.addEventListener('change', function () { flowState.month = ms.value; renderFlows(); });
    var ts = document.getElementById('flow-type-sel');
    if (ts) ts.addEventListener('change', function () { flowState.type = ts.value; renderFlows(); });
    var ss = document.getElementById('flow-status-sel');
    if (ss) ss.addEventListener('change', function () { flowState.status = ss.value; renderFlows(); });
    var mp = document.getElementById('flow-month-prev');
    if (mp) mp.addEventListener('click', function () { stepFlowMonth(-1); });
    var mn = document.getElementById('flow-month-next');
    if (mn) mn.addEventListener('click', function () { stepFlowMonth(1); });
    var yp = document.getElementById('flow-year-prev');
    if (yp) yp.addEventListener('click', function () { stepFlowYear(-1); });
    var yn = document.getElementById('flow-year-next');
    if (yn) yn.addEventListener('click', function () { stepFlowYear(1); });

    var clear = document.getElementById('clear-filter');
    if (clear) clear.addEventListener('click', function () {
      openTradeFor('');
      /* 全局产品筛选也一并恢复全选，否则清掉产品名后流水/汇总仍被顶部筛选挡住 */
      var ids = pickableProducts().map(function (p) { return p.id; });
      if (selectedIds.length !== ids.length) {
        selectedIds = ids.slice();
        applySelection();
      }
    });

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
      var chk = e.target.closest('[data-chk]');
      if (chk) {
        var cid = chk.getAttribute('data-chk');
        if (chk.checked) flowSel[cid] = 1; else delete flowSel[cid];
        syncFlowSelBar();
        return;
      }
      var mchk = e.target.closest('[data-mk-chk]');
      if (mchk) {
        var mkm = mchk.getAttribute('data-mk-chk');
        flowIds.forEach(function (id) {
          if (flowIdMonth[id] !== mkm) return;
          if (mchk.checked) flowSel[id] = 1; else delete flowSel[id];
        });
        renderFlows();
        return;
      }
      var mh = e.target.closest('tr.flow-month');
      if (mh) {
        var mk = mh.getAttribute('data-mk');
        flowOpenMonths[mk] = (flowOpenMonths[mk] === false);
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
        confirmDialog('确认删除该笔交易？删除后持仓与收益将重新计算。', '删除').then(function (ok) {
          if (!ok) return;
          window.STORE.remove(did).then(function (res) {
            if (!res || !res.ok) { toast((res && res.message) || '删除失败'); return; }
            toast('交易已删除');
            refreshAfterWrite();
          }).catch(function (err) { toast((err && err.message) || '删除交易失败，请检查网络后重试'); });
        });
      }
    });

    document.addEventListener('click', function (e) {
      var plink = e.target.closest ? e.target.closest('[data-goto-prod]') : null;
      if (plink) {
        e.preventDefault();
        var gpid = plink.getAttribute('data-goto-prod');
        gotoProduct(gpid);
        /* 同时联动交易流水：按该产品过滤（切到交易流水页签即可看到） */
        filterFlowByProduct(gpid);
        return;
      }
      var link = e.target.closest ? e.target.closest('[data-goto-trade]') : null;
      if (!link) return;
      e.preventDefault();
      openTradeFor(link.getAttribute('data-goto-trade'));
    });
  }

  /* 交易流水：全选 + 批量删除 */
  function bindFlowBulk() {
    var all = document.getElementById('flow-check-all');
    if (all) all.addEventListener('change', function () {
      if (all.checked) flowIds.forEach(function (id) { flowSel[id] = 1; });
      else flowSel = {};
      renderFlows();
    });

    var btn = document.getElementById('flow-del-sel');
    if (btn) btn.addEventListener('click', function () {
      var ids = selectedFlowIds();
      if (!ids.length || btn.disabled) return;
      if (!window.STORE || !window.STORE.removeMany) { toast('批量删除不可用'); return; }
      confirmDialog('确认删除选中的 ' + ids.length + ' 笔交易？删除后持仓与收益将重新计算。', '删除').then(function (ok) {
        if (!ok) return;
        btn.disabled = true;
        window.STORE.removeMany(ids).then(function (res) {
          btn.disabled = false;
          if (!res || !res.ok) { toast((res && res.message) || '批量删除失败'); return; }
          flowSel = {};
          toast(res.message || ('已删除 ' + ids.length + ' 笔交易'));
          refreshAfterWrite();
        }).catch(function (err) {
          btn.disabled = false;
          toast((err && err.message) || '批量删除失败，请检查网络后重试');
        });
      });
    });
  }

  /* ---------------- 顶部产品多选 ---------------- */
  function shortOf(id) {
    var list = pickableProducts();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return prodDispName(list[i]);
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
      prodDispName(p).toLowerCase().indexOf(q) !== -1 ||
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
      return '<div class="ms-item">' +
        '<label class="ms-pick">' +
        '<input type="checkbox" value="' + p.id + '"' + checked + '>' +
        '<span class="ms-name" title="' + (p.name || '') + '">' + prodDispName(p) + '</span>' +
        '</label>' +
        '<em>' + p.regCode + '</em>' +
        '</div>';
    }).join('');
  }

  function openPanel() {
    var trigger = document.getElementById('ms-trigger');
    var panel = document.getElementById('ms-panel');
    if (!trigger || !panel) return;
    panel.hidden = false;
    /* 每次打开先回到完整产品列表：清掉上次的搜索词与搜索结果态 */
    pickerQuery = '';
    var search = document.getElementById('ms-search');
    if (search) { search.value = ''; search.focus(); }
    renderPickerList();
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

  // 统一简称规则：与全站共用 prodDispName（发行机构简称 + 产品系列 + 持有期 + 期数）
  // 代销机构（如建设银行）不参与产品名拼接
  function npShortName(p) {
    return prodDispName(p);
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
          '<span class="nmid"><span class="nm">' + npShortName(p) + '</span>' +
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

  /* 产品身份一致性自检：同一登记编码只能有一个身份；持仓/交易必须能解析到产品库。
     暴露给 __auditProductIdentity 便于浏览器回归测试，异常只在控制台告警不影响渲染。 */
  function auditProductIdentity() {
    var issues = [];
    var merged = mergeProductModels();
    var byCanon = {};
    merged.forEach(function (x) {
      var c = canonicalPid(x.product);
      if (byCanon[c]) issues.push('产品库重复身份: ' + c);
      byCanon[c] = x.product;
    });
    Object.keys(HOLD_BY_PID).forEach(function (id) {
      var p = HOLD_BY_PID[id].product;
      var c = canonicalPid(p);
      if (!byCanon[c]) issues.push('持仓产品未出现在产品库: ' + (p.short || p.name) + ' (' + c + ')');
    });
    ((window.TRANSACTIONS && window.TRANSACTIONS.items) || []).forEach(function (t) {
      var p = findProductById(t.pid);
      if (!p) issues.push('交易无法解析产品: ' + t.pid);
      else if (!byCanon[canonicalPid(p)]) issues.push('交易产品未出现在产品库: ' + t.pid);
    });
    return { ok: issues.length === 0, issues: issues, canonicalIds: window.REG_CANONICAL_IDS };
  }
  window.__auditProductIdentity = auditProductIdentity;

  function renderAll(keepView) {
    refreshAggregate();
    updatePickerLabel();
    renderPickerList();
    renderProfitTable();
    if (!keepView) resetCalendarMonth();
    renderCalendar();
    renderTrend();
    renderProductTable();
    populateOrgSelect();
    populateIncepSelect();
    renderTradeSummary();
    populateFlowSelects();
    renderFlows();
    renderNewProds();
  }

  /* 交易写入后原地重绘：不整页刷新、不重新拉取云端，保留当前页签与筛选 */
  function refreshAfterWrite() {
    var modal = document.getElementById('modal-trade');
    if (modal) {
      modal.hidden = true;
      if (modal.dataset) delete modal.dataset.editId;
      modal.removeAttribute('data-edit-id');
    }
    /* 增删改交易会改变持仓，先重算持仓与产品选择范围，否则盈亏日历/持仓表仍是旧数据 */
    computeHoldings();
    syncPickerScope();
    renderAll(true);
  }

  function applySelection() {
    refreshAggregate();
    updatePickerLabel();
    renderProfitTable();
    resetCalendarMonth();
    renderCalendar();
    renderTrend();
    renderTradeSummary();
    /* 产品选择变了，交易流水必须回到「所选产品的全部记录」：
       清空此前默认定位的最近交易月，避免多选/单选时大部分产品被年月条件挡成空列表。 */
    resetFlowFilters();
    renderFlows();
    renderProductTable();
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

    /* 点产品名 = 只看这一只（原「仅选」按钮的职责，按钮已取消）。
       默认全选时复选框是勾选状态，直接点它反而会取消该产品；
       故把「点名称」统一定义为隔离选中并收起面板，勾选框仍负责多选增减。 */
    list.addEventListener('click', function (e) {
      var nameEl = e.target && e.target.closest ? e.target.closest('.ms-name') : null;
      if (!nameEl) return;
      var item = nameEl.closest('.ms-item');
      var cb = item ? item.querySelector('input[type="checkbox"]') : null;
      if (!cb) return;
      e.preventDefault();
      e.stopPropagation();
      selectedIds = [cb.value];
      applySelection();
      renderPickerList();
      updatePickerLabel();
      closePanel();
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
    alignNavFromLibrary(data);
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
    populateIncepSelect();
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

    /* 只有本机/内网服务才带抓取接口；手机打开线上 Pages 时直接走「重新拉取数据文件」 */
    function hasLocalApi() {
      if (location.protocol === 'file:') return false;
      var h = location.hostname;
      return h === 'localhost' || h === '127.0.0.1' ||
        /^192\.168\./.test(h) || /^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
    }

    /* 手机/静态托管（GitHub Pages）没有抓取后端：退化为重新拉取已发布的最新数据文件 */
    function fallbackReload() {
      reloadData().then(function () {
        var msg = DATA.asOf === prevAsOf ? '已是最新' : '已更新';
        settle('done', msg, '已获取最新已发布数据 · 数据日期 ' + (DATA.asOf || '—'));
        if (window.innerWidth < 760) toast(msg + ' · ' + (DATA.asOf || '').slice(5));
      }).catch(function (err) {
        settle('error', '刷新失败', String((err && err.message) || err));
      });
    }

    if (!hasLocalApi()) {
      defaultTitle = '刷新数据：重新获取线上最新已发布的数据';
      btn.title = defaultTitle;
      btn.setAttribute('aria-label', defaultTitle);
    }

    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      prevAsOf = DATA.asOf;
      btn.disabled = true;
      btn.classList.remove('done', 'error');
      btn.classList.add('loading');
      if (labelEl) labelEl.textContent = '抓取中…';

      if (!hasLocalApi()) { fallbackReload(); return; }

      fetch(API_BASE + '/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      }).then(function (resp) {
        /* 静态托管没有 /api/refresh，返回 404/HTML，走「重新拉取数据文件」 */
        if (!resp.ok) return null;
        return resp.json().then(function (json) {
          return { status: resp.status, json: json || {} };
        }, function () { return null; });
      }).then(function (res) {
        if (!res) { fallbackReload(); return; }
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
        if (location.protocol !== 'file:') { fallbackReload(); return; }
        if (window.console && console.error) console.error('[抓取服务不可用]', err);
        settle('error', '服务未启动', '请在项目目录运行 python daily/serve.py 后重试；页面数据未变化。');
      });
    });
  }

  /* ---------------- init ---------------- */
  /* 表格滚动链桥接：表格内部滚到顶/底后，同一次手势/滚轮继续滑动时，
     把滚动交给整页，避免「卡住、要松手再划一次」。CSS 的 overscroll-behavior 只能在
     下一次手势传递滚动链，这里补齐「同一次滚动越界即接续页面」的能力。
     - wheel：桌面滚轮在边界时 preventDefault 并手动滚动 window
     - touch：手指在边界继续滑动时 preventDefault 并手动滚动 window
     仅当表格真的可纵向滚动（scrollHeight>clientHeight）时才介入，短表不干扰。 */
  function bindTableScrollChain() {
    var els = document.querySelectorAll('.tbl-scroll');
    Array.prototype.forEach.call(els, function (el) {
      /* 桌面滚轮 */
      el.addEventListener('wheel', function (e) {
        if (e.ctrlKey) return;                       /* 缩放手势放行 */
        var d = e.deltaY;
        if (!d) return;                              /* 纯横向滚动放行 */
        var max = el.scrollHeight - el.clientHeight;
        if (max <= 1) return;
        var atBottom = el.scrollTop >= max - 1;
        var atTop = el.scrollTop <= 1;
        var deltaMode = e.deltaMode;
        if (deltaMode === 1) d = d * 16;             /* 行 -> 近似像素 */
        else if (deltaMode === 2) d = d * el.clientHeight;
        if ((d > 0 && atBottom) || (d < 0 && atTop)) {
          if (e.cancelable) e.preventDefault();
          window.scrollBy(0, d);
        }
      }, { passive: false });

      /* 手机触摸：touchmove 需非 passive 才能 preventDefault */
      var lastY = 0, lastX = 0;
      el.addEventListener('touchstart', function (e) {
        lastY = e.touches.length ? e.touches[0].clientY : 0;
        lastX = e.touches.length ? e.touches[0].clientX : 0;
      }, { passive: true });
      el.addEventListener('touchmove', function (e) {
        if (!e.touches.length) return;
        var y = e.touches[0].clientY;
        var x = e.touches[0].clientX;
        var dy = lastY - y;                          /* 手指向上 => dy>0 => 页面向下 */
        var dx = lastX - x;
        lastY = y; lastX = x;
        if (!dy) return;
        if (Math.abs(dx) > Math.abs(dy) * 1.2) return; /* 以横滑为主时放行，交给表格横向滚动 */
        var max = el.scrollHeight - el.clientHeight;
        if (max <= 1) return;
        var atBottom = el.scrollTop >= max - 1;
        var atTop = el.scrollTop <= 1;
        if ((dy > 0 && atBottom) || (dy < 0 && atTop)) {
          if (e.cancelable) e.preventDefault();
          window.scrollBy(0, dy);
        }
      }, { passive: false });
    });
  }

  function init() {
    populateOrgSelect();
    populateIncepSelect();
    initPicker();
    bindProfitSort();
    bindSumSort();
    bindDataFilter();
    bindDateFilter();
    bindRefresh();
    bindCalendar();
    bindTrend();
    bindProductFilters();
    bindProdSort();
    beautifyFilterSelects();
    bindProdSearchSuggest();
    bindTrade();
    bindFlowBulk();
    bindTradeModal();
    initDatePicker();
    bindAddModal();
    bindTableScrollChain();
    renderAll();
    var identityAudit = auditProductIdentity();
    if (!identityAudit.ok) console.warn('[产品身份自检]', identityAudit.issues);

    var wasCompact = (window.innerWidth || 1200) < 480;
    window.addEventListener('resize', function () {
      if (trendChart) trendChart.resize();
      var nowCompact = (window.innerWidth || 1200) < 480;
      if (nowCompact !== wasCompact) { wasCompact = nowCompact; renderCalendar(); }
    });

    /* 横竖屏切换：浏览器可能沿用旧布局宽度或缩放，强制重置视口并重排 */
    var vpMeta = document.querySelector('meta[name="viewport"]');
    var VP_CONTENT = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
    var rotTimer = null;
    window.addEventListener('orientationchange', function () {
      clearTimeout(rotTimer);
      rotTimer = setTimeout(function () {
        if (vpMeta) {
          vpMeta.setAttribute('content', 'width=device-width, initial-scale=1, minimum-scale=1, viewport-fit=cover');
          setTimeout(function () { vpMeta.setAttribute('content', VP_CONTENT); }, 200);
        }
        var scrollers = document.querySelectorAll('.tbl-scroll');
        for (var i = 0; i < scrollers.length; i++) scrollers[i].scrollLeft = 0;
        if (trendChart) trendChart.resize();
        renderCalendar();
      }, 260);
    });
  }

  /* 云端后台刷新完成后由页面调用，重新计算持仓并重绘（等首屏 init 完成后再跑） */
  function refreshFromStore() {
    function run() {
      mergeManualProducts();
      computeHoldings();
      syncPickerScope();
      renderAll();
      renderAddHistory();
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
