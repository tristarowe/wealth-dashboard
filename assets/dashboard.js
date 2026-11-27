(function () {
  /* 版本标记：index.html 的 boot() 据此识别旧缓存脚本并强制以时间戳重载 */
  window.__NP_LAYOUT_VERSION = '20261127f';
  var DATA = window.REPORT_DATA;
  if (!DATA || !Array.isArray(DATA.products)) return;

  var DAY = 86400000;
  /* 手势角标 2026-11-21 四轮（用户要求：向下的改为深灰色）：
     emoji 是彩色字体，Windows/部分内核不执行 CSS grayscale 滤镜，👎 会直接显示成黄色，
     导出图片（html2canvas）同样不支持滤镜。改为内联 SVG —— 颜色由 currentColor 决定，
     电脑/手机/导出图片三处完全一致。向上=品牌金，向下=深灰 #4d5964。 */
  var THUMB_PATH = '<path fill="currentColor" d="M2.1 6.6h1.9c.3 0 .5.2.5.5v7.3c0 .3-.2.5-.5.5H2.1a.6.6 0 0 1-.6-.6V7.2c0-.3.3-.6.6-.6Z"/>' +
    '<path fill="currentColor" d="M5.6 14.6V7.1c0-.2.1-.4.2-.6l2.5-3.2c.4-.5 1-.7 1.5-.5.6.2 1 .8.9 1.4l-.3 2.9h3.4c.8 0 1.4.7 1.3 1.5l-.7 5c-.1.6-.6 1-1.2 1H5.6Z"/>';
  var THUMB_UP = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' + THUMB_PATH + '</svg>';
  var THUMB_DOWN = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<g transform="translate(0,16) scale(1,-1)">' + THUMB_PATH + '</g></svg>';

  /* 披露节奏红色角标（+N）：净值日 T 的净值为何晚于 T+1 披露，按登记编码人工核定后登记到这里，
     优先级高于自动推断。格式：'登记编码': N（工作日）。未登记的产品走 disclosureLagOf 的自动推断。
     口径与 PDF 一致：+N 表示净值披露节奏（T 日净值于 T+N 工作日披露），与份额确认 T+1/T+2 无关；
     周频/停止更新的产品不标注。 */
  var DISCLOSURE_LAG_OVERRIDE = {
    /* 例：'Z7001926001090': 2  // 中邮鸿锦7天45号：说明书约定 T+2 披露 */
  };

  /* 份额确认节奏（工作日）：默认 T+1，只有说明书明确 T+2 的产品才偏移。
     与上面的净值披露节奏完全无关：披露晚不改写份额确认日，确认日以本表为准。
     2026-11-26 逐只核实 16 只持仓产品说明书：仅中邮「优盛·鸿锦最短持有」系列
     约定 T+2，其余（中银稳富/悦享、招银招睿、信银安盈象、建信嘉鑫、交银稳享、
     贝莱德贝淳、光大阳光金）均为 T+1。
       · 7天45号 Z7001926001090 建行 PDF：「客户申购受理日后第 2 个工作日确认」
         「赎回受理日后第 2 个工作日确认」，「资金到账日后 3 个工作日内」是另一口径；
       · 14天16号 2601NC016A 邮储 PDF：同样「受理日后第 2 个工作日确认」，
         同系列 14天23号/25号一并覆盖。
     编码表用于精确登记；SERIES 用产品名模糊匹配，覆盖同系列后续新品，避免漏登。
     募集期认购仍在 confirmDateFor 里按产品成立日处理，不受本表影响。 */
  var CONFIRM_WORKDAY_OFFSET = {
    'Z7001926001090': 2,  /* 中邮优盛·鸿锦最短持有7天45号 */
    'Z7001926001092': 2,  /* 中邮优盛·鸿锦最短持有14天23号 */
    'Z7001926001210': 2   /* 中邮优盛·鸿锦最短持有14天25号 */
  };
  /* 已核实的 T+2 产品系列（按名称片段匹配，命中即 T+2）。
     只收「优盛·鸿锦最短持有」——中邮其他系列（智盛/福瑞/合盛等封闭式）未核实，
     不在此列，仍走默认 T+1。 */
  var CONFIRM_T2_SERIES = ['优盛·鸿锦最短持有', '优盛鸿锦最短持有'];

  function confirmOffsetOf(p) {
    if (!p) return 1;
    if (p.regCode && CONFIRM_WORKDAY_OFFSET[p.regCode]) return CONFIRM_WORKDAY_OFFSET[p.regCode];
    var name = String(p.name || p.short || '');
    for (var i = 0; i < CONFIRM_T2_SERIES.length; i++) {
      if (name.indexOf(CONFIRM_T2_SERIES[i]) >= 0) return 2;
    }
    return 1;
  }

  function parseDate(s) {
    var p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function isoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* 交易状态按确认日期判定：确认日未到，或成交净值尚未披露，均为「在途」，不计入持仓。
     2026-11-25：新品（如招睿增鑫30天4号，成立日晚于申购日）尚未披露任何净值，
     旧逻辑只看 p.latestDate（空串）会把 confirmNav=0 的交易误判「已确认」，
     交易流水成交净值列随即把占位 0 渲染成 0.000000。这里补一条：没有任何净值
     且交易自身也没记成交净值时，一律在途，显示「待确认」。 */
  function txStatus(t) {
    var d = t && (t.confirmDate || t.applyDate);
    if (!d) return (t && t.status) || '已确认';
    if (d > isoDate(new Date())) return '在途';
    var p = findProductById(t.pid);
    /* 成交净值按申购日（T 日）：T 日净值已披露即可确认，不要求确认日净值披露 */
    var navDay = t.applyDate || d;
    if (p && p.latestDate && navDay > p.latestDate) return '在途';
    /* 净值未披露：交易无 confirmNav、产品也无任何净值点 → 待确认，不能按 0 计 */
    var hasOwnNav = Number(t.confirmNav) > 0;
    var hasProdNav = !!(p && p.nav && p.nav.length);
    if (!hasOwnNav && !hasProdNav) return '在途';
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

  /* 短样本阈值：计息天数少于此值时，年化属于「1~6 天的线性折算」，波动极大，
     只作参考（表格里加 * 并置灰）。2026-11-21 用户要求「以后不再出这类错」后新增。 */
  var SHORT_ANN_DAYS = 7;

  /* 年化口径不变量：起点=成交净值日、终点=最新净值日、天数=两者相差天数。
     违反即写 console.error 并记进 window.__ANN_GUARD_ERRORS__，供自动化回归断言抓取。
     2026-11-21 的事故（悦享天添24号 14.51% → 7.25%）就是「起点错用确认日」，
     这里把口径钉成可执行断言，避免再次静默算错。 */
  window.__ANN_GUARD_ERRORS__ = [];
  function assertHoldMath(p, rec, start, end, days) {
    if (!start || !end) return;
    var msgs = [];
    var calc = dayDiff(parseDate(start), parseDate(end));
    if (calc !== days) {
      msgs.push('计息天数与区间不符：' + start + '~' + end + ' 应为 ' + calc + ' 天，实际 ' + days);
    }
    if (p.latestDate && end !== p.latestDate) {
      msgs.push('计息终点应取最新净值日 ' + p.latestDate + '，实际 ' + end);
    }
    /* 起点必须等于「首个批次的成交净值日」（早于产品成立日时取成立日）：
       这条才是 14.51% 事故的直接防线——把起点改回确认日、或改回「今天 − 起息日」，这里立刻报错。 */
    var expect = rec.lots && rec.lots[0] && rec.lots[0].navDate;
    var incep = inceptionDateOf(p);
    if (expect && incep && expect < incep) expect = incep;
    if (expect && start !== expect) {
      msgs.push('计息起点应为首个批次成交净值日 ' + expect + '，实际 ' + start);
    }
    if (msgs.length) {
      var text = msgs.join('；');
      /* computeHoldings 可能因数据同步重算多次，同一产品同一问题只记一条 */
      var dup = window.__ANN_GUARD_ERRORS__.some(function (x) { return x.pid === p.id && x.msg === text; });
      if (!dup) {
        window.__ANN_GUARD_ERRORS__.push({ pid: p.id, name: p.name, msg: text });
        if (window.console && console.error) console.error('[ANN-GUARD] ' + (p.name || p.id) + '：' + text);
      }
    }
  }

  /* 年化单元格 tooltip：把算式和区间摊开，任何一格都能当场验算 */
  function annTipOf(h) {
    if (!h || h.ann === null || h.ann === undefined || !isFinite(h.ann)) return '计息天数不足，暂不折算年化';
    /* 盈亏汇总是 unrealized、交易汇总行是 holdProfit，两者同义（均为持仓收益） */
    var gain = (h.unrealized !== undefined && h.unrealized !== null) ? h.unrealized : h.holdProfit;
    var tip = '持仓年化 = 持仓收益 ' + fmtMoney(gain) + ' ÷ 持仓成本 ' + fmtMoney(h.cost) +
      ' × 365 ÷ 计息 ' + h.accrualDays + ' 天 = ' + h.ann.toFixed(2) + '%' +
      '；计息区间 ' + (h.accrualStart || '') + ' 至 ' + (h.latestDate || '') +
      '（起点为成交净值日，不是确认日）';
    if (h.annShort) tip += '；样本仅 ' + h.accrualDays + ' 天，线性折算波动大，仅供参考';
    return tip;
  }

  /* 产品在指定日期披露的净值，未披露返回 null */
  function navOnDate(p, date) {
    if (!p || !p.dates || !date) return null;
    var i = p.dates.indexOf(date);
    return i === -1 ? null : p.nav[i];
  }

  /* 成交净值日（2026-11-21）：T 日申购按 T 日（或其之前最近一日）披露的净值定价。
     年化分母必须与分子同口径 —— 分子是按成交净值买入后的市值变化，
     收益自「成交净值日之后」才开始累积；若拿确认日（T+1）当起点，
     会漏掉确认日当天的净值涨幅，新买入产品的年化被放大近一倍
     （例：中银悦享天添24号 11-17 定价、11-19 最新，实际计息 2 天）。 */
  function navDateAt(p, date) {
    if (!p || !p.dates || !p.dates.length || !date) return null;
    var hit = null;
    for (var i = 0; i < p.dates.length; i++) {
      if (p.dates[i] <= date) hit = p.dates[i]; else break;
    }
    return hit;
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

  /* 确认日按说明书偏移（默认 T+1，个别 T+2）自动换算，遇周末/法定节假日顺延至下一交易日 */
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

  /* 受理日后第 n 个工作日：n=1 即原 nextWorkday。产品级确认偏移（T+2）也走这里，
     遇到周末/法定节假日连续顺延，避免"T+2"落在周六。 */
  function addWorkdays(s, n) {
    var d = s ? parseDate(s) : null;
    if (!d || isNaN(d.getTime())) return '';
    var left = Math.max(1, Number(n) || 1);
    while (left > 0) {
      d = new Date(d.getTime() + DAY);
      if (!isMarketClosed(d)) left--;
    }
    return isoDate(d);
  }

  function nextWorkday(s) { return addWorkdays(s, 1); }

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

  /* 产品库要素（按登记编码）：募集起止日与成立日，用于判定「募集期认购」。
     2026-11-26：交易弹窗允许直接录入「今日新品」，这类产品要素在 newproducts.js、
     尚未进 PRODUCT_LIBRARY。旧实现只查产品库，导致 11-26 认购、12-01 成立的
     招睿添利日开30号被误判为存续期申购，确认日取 T+1 得 11-27（应为成立日 12-01）。
     这里把新品要素按同一结构补进来，募集期规则对两类产品完全一致。 */
  function libItemOf(p) {
    if (!p) return null;
    var items = (typeof PRODUCT_LIBRARY !== 'undefined' && PRODUCT_LIBRARY.items) || [];
    if (p.regCode) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].regCode === p.regCode) return items[i];
      }
    }
    var np = (window.NEW_PRODUCTS && window.NEW_PRODUCTS.items) || [];
    for (var j = 0; j < np.length; j++) {
      var hit = (p.regCode && String(np[j].regCode || '') === String(p.regCode)) ||
        (!p.regCode && p.name && np[j].name === p.name);
      if (hit) {
        return {
          regCode: np[j].regCode || '',
          /* 新品字段叫 establish，产品库叫 inception；confirmDateFor 两者都认 */
          establish: np[j].establish || '',
          inception: np[j].inception || np[j].establish || '',
          raiseStart: np[j].raiseStart || '',
          raiseEnd: np[j].raiseEnd || ''
        };
      }
    }
    return null;
  }

  /* ===== 份额确认日规则（2026-11-25 核对建行 App 后固化）=====
     ① 募集期认购（申购日落在产品募集期、且早于成立日）：份额在「产品成立日」确认，不是 T+1。
        实测：招银招睿增鑫30天4号（Z7001626001126）募集 11-24~11-26、11-27 成立，
        11-24 认购 4,997.00 元 → 建行 App「预计 2026-11-27 确认份额」。
        旧逻辑一律 nextWorkday(申购日) 得 11-25，比银行实际早 2 天，确认日/起息日/
        XIRR 现金流日全部偏前。
     ② 存续期开放日申购、赎回：默认 T+1 个工作日；说明书明确约定 T+2 的产品按
        CONFIRM_WORKDAY_OFFSET（精确编码）+ CONFIRM_T2_SERIES（系列名）取 T+2，
        遇周末与法定节假日顺延。2026-11-26 逐只核实 16 只持仓产品说明书，
        仅中邮「优盛·鸿锦最短持有」系列为 T+2：7天45号、14天23号、14天25号；
        11-26（周四）提交 → 11-27（周五）T+1 → 11-30（周一）T+2。
        其余持仓（中银/招银/信银/建信/交银/贝莱德/光大）说明书均为 T+1。
     ③ 成立日若恰逢非交易日，份额实际在下个交易日确认，故募集期取「成立日」与「T+1 工作日」较晚者。
     ④ 存量记录：人工填写的确认日一律保留；但若存的是旧版自动 T+1 值，
        且该产品说明书为 T+2，则视为过期默认值纠正为 T+2，否则交易流水会继续显示错误的 11-27。
     判定只用产品库要素表里的 raiseStart/raiseEnd/inception（说明书原文；新品数据里成立日字段名是
     establish），不拿首个净值日当成立日——净值序列可能被截断，用截断后的首点会把老产品误判成募集期。 */
  function confirmDateFor(p, applyDate, stored) {
    var offset = confirmOffsetOf(p);
    var auto = addWorkdays(applyDate, offset);
    var nd = nextWorkday(applyDate);
    if (!applyDate) return stored || auto || '';
    var it = p ? libItemOf(p) : null;
    /* 产品库把成立日存成 inception（说明书「成立日」），新品数据里叫 establish，两者都认 */
    var establish = it && (it.establish || it.inception);
    var rs = it && it.raiseStart;
    var re = it && it.raiseEnd;
    var inRaise = !!(establish && applyDate < establish &&
      (!rs || applyDate >= rs) && (!re || applyDate <= re));
    if (inRaise) return establish > nd ? establish : nd;
    if (offset > 1 && stored && stored === nd) return auto;
    return stored || auto;
  }

  /* 把「募集期认购」的存量交易确认日校正到成立日：只改内存渲染值，不写库，
     用户下次编辑并提交时才会落库。每次重算持仓前跑一遍，保证确认日列、
     起息日、XIRR 现金流日同源。 */
  function normalizeTxConfirmDates() {
    var items = (window.TRANSACTIONS && window.TRANSACTIONS.items) || [];
    items.forEach(function (t) {
      if (!t || !t.applyDate) return;
      var want = confirmDateFor(findProductById(t.pid), t.applyDate, t.confirmDate);
      if (want && want !== t.confirmDate) t.confirmDate = want;
    });
  }

  /* 测试钩子：仅在守卫绕过模式（专项脚本）下暴露，正式站不挂载。
     用来直接断言确认日偏移与存量纠正，避免只靠界面点击漏掉数据层口径。 */
  if (window.__GATE_BYPASS__) {
    window.__DASH_CONFIRM_TEST__ = { confirmDateFor: confirmDateFor, addWorkdays: addWorkdays, confirmOffsetOf: confirmOffsetOf };
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
    /* 2026-11-24 新品预告产品以 np:Z7 作临时 id；次日入库后Z7有了正式 id，
       旧交易里的 np:Z7 必须自动指向正式产品，避免交易记录变成孤儿。 */
    if (typeof id === 'string' && id.indexOf('np:') === 0) {
      var npReg = id.slice(3);
      if (npReg && REG_CANONICAL[npReg]) return REG_CANONICAL[npReg].id;
    }
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

  /* 2026-11-24：新品预告里的「今日新品」转成可交易产品原型。
     净值尚未披露，dates/nav 留空，录入时可走「净值待确认」流程；
     次日产品库入库后，canonicalPidById() 会把 np:Z7 自动指向正式 id。 */
  function tradeNewProductId(x) { return 'np:' + String((x && x.regCode) || x.name || ''); }
  function tradeNewProducts() {
    var list = (window.NEW_PRODUCTS && window.NEW_PRODUCTS.items) || [];
    if (!list.length) return [];
    var seen = Object.create(null);
    DATA.products.concat((window.PRODUCT_LIBRARY && window.PRODUCT_LIBRARY.items) || []).forEach(function (p) {
      if (!p) return;
      if (p.regCode) seen['R:' + String(p.regCode)] = 1;
      if (p.name) seen['N:' + String(p.name)] = 1;
    });
    return list.filter(function (x) {
      if (!x || (!x.regCode && !x.name)) return false;
      return !(x.regCode && seen['R:' + String(x.regCode)]) && !(x.name && seen['N:' + String(x.name)]);
    }).map(function (x) {
      return {
        id: tradeNewProductId(x),
        name: x.name || x.short || '',
        short: x.short || x.name || '',
        org: x.issuer || x.org || '',
        orgShort: x.issuer || x.orgShort || '',
        regCode: x.regCode || '',
        risk: x.risk || '',
        saleChannel: x.saleChannel || '',
        inception: x.establish || '',
        raiseStart: x.raiseStart || '', raiseEnd: x.raiseEnd || '',
        dates: [], nav: [], per10k: [],
        latestDate: '', latestNav: null,
        newProduct: true
      };
    });
  }

  // 产品数据源：持仓产品 + 产品库扩容产品 + 今日新品（仅交易录入使用，不改产品库表格）
  function tradeProducts() {
    var out = DATA.products.slice();
    var seen = {};
    out.forEach(function (p) { seen[p.id] = 1; });
    LIB_MODEL.forEach(function (x) {
      var p = x.product;
      if (p && !seen[p.id]) { seen[p.id] = 1; out.push(p); }
    });
    tradeNewProducts().forEach(function (p) {
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
     银行规则：份额自确认日（默认 T+1、说明书 T+2 的产品为 T+2）当日净值起享有收益，
     此前净值涨跌不归属该批次。 */
  function vestedShares(lots, navDate) {
    if (!lots || !lots.length || !navDate) return 0;
    var s = 0;
    for (var i = 0; i < lots.length; i++) {
      if (lots[i].date <= navDate) s += lots[i].shares;
    }
    return s;
  }

  /* 2026-11-26：按「完整份额批次时间线」计算某产品在某个净值日的收益与期初市值。
     lot.date = 确认日（自当日起息，含当日净值）；lot.soldDate = 卖出确认日（含当日净值）；
     lot.buyNav = 成交净值日(T日)净值，作为该批次首日的收益起点。
     这样已清仓份额在持有期内逐日计息，而不是把整笔已实现收益一次性砸在清仓确认日。 */
  function gainsOnDate(p, lots, i) {
    var inc = 0, base = 0, cnt = 0;
    var navToday = p.nav[i];
    var prevNav = i > 0 ? p.nav[i - 1] : null;
    var firstActiveDate = i > 0 ? p.dates[i - 1] : null;
    for (var k = 0; k < lots.length; k++) {
      var gl = lots[k];
      if (p.dates[i] < gl.date || (gl.soldDate && p.dates[i] > gl.soldDate)) continue;
      /* 批次首日：用成交净值作起点；其余日子用上一净值日。
         若确认日落在非披露日，首个披露日仍按成交净值起算。 */
      var isFirst = !prevNav || !firstActiveDate || firstActiveDate < gl.date;
      var fromNav = isFirst ? (Number(gl.buyNav) > 0 ? Number(gl.buyNav) : prevNav) : prevNav;
      if (!(fromNav > 0) || !(navToday > 0)) continue;
      inc += (navToday - fromNav) * gl.shares;
      base += fromNav * gl.shares;
      cnt += 1;
    }
    return { inc: inc, base: base, cnt: cnt };
  }

  /* 组合现金流（只记与持仓同口径的已生效交易）：申购为负、赎回/清仓为正。
     供「累计收益年化（XIRR）」使用，口径与持仓计算保持完全一致。 */
  var PORTFOLIO_FLOWS = [];
  /* 累计年化（XIRR）缓存：renderMetrics 算出后存这里，盈亏日历年度表最新行直接复用，
     保证「累计年化卡」与「年度年化」两个数字严格同源同值。 */
  var CUM_ANN_CACHE = null;

  /* XIRR 求解核心：把一组现金流按实际发生日折现，求净现值为 0 的年化内部收益率。
     现金流约定：申购/投入为负，赎回/回收为正；最后一笔通常是期末市值。
     公式：Σ Ci / (1+r)^((di - d0)/365) = 0，求 r。二分法（NPV 随 r 单调递减）。
     —— 全站「年化」统一走这个求解器，保证累计卡与盈亏日历口径、数值完全一致。 */
  function xirrSolve(flows) {
    if (!flows || flows.length < 2) return null;
    flows = flows.slice().sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
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

  /* 累计收益年化 = XIRR：把组合全部已生效现金流按实际发生日折现，
     求净现值为 0 的内部收益率。与「持仓年化」的区别是它把已落袋收益、
     分批投入的时点、中途赎回都计入，是真正意义上的「这笔钱从入场到现在的年化」。 */
  function portfolioXirr(endValue, endDate, keepPid) {
    var flows = PORTFOLIO_FLOWS.filter(function (f) {
      return !keepPid || keepPid[f.pid];
    });
    if (!flows.length || !endDate) return null;
    if (endValue > 0) flows.push({ d: endDate, v: endValue });
    return xirrSolve(flows);
  }

  /* 截至某日的「累计资金加权年化（XIRR）」——盈亏日历年度/月度年化的统一口径。
     与累计卡完全同源：现金流取「起始日之后、截止日（含）之前」的全部申赎，
     末值取组合在该截止日的持仓市值。这样每个月的年化都是「从第一笔投入到当月底」的
     真实资金加权年化，最后一个月自然收敛到累计卡的 2.49%，不会再出现
     「单月现金流稀疏 → XIRR 失真（±99%/1000%）」的问题。
     —— 起点用组合首笔现金流日（而不是 1 月 1 日），避免把建仓前的空档算进折现期。 */
  function xirrRangeAnn(endDate, keepPid, startDate) {
    if (!endDate) return null;
    var all = PORTFOLIO_FLOWS.filter(function (f) { return !keepPid || keepPid[f.pid]; });
    if (!all.length) return null;
    var start = startDate || all.reduce(function (a, f) { return f.d < a ? f.d : a; }, all[0].d);
    var flows = all.filter(function (f) { return f.d > start && f.d <= endDate; });
    /* 期初市值：start 当天组合的持仓市值，作为期初投入（负），
       使「截至当月底」的收益率起算点与该日真实在场资金对齐。 */
    var startMv = portfolioMvOn(start, keepPid);
    if (startMv > 0) flows.push({ d: start, v: -startMv });
    var endMv = portfolioMvOn(endDate, keepPid);
    if (endMv > 0) flows.push({ d: endDate, v: endMv });
    /* 稳健性保护：XIRR 对短期集中现金流极敏感。建仓初期跨度不足 45 天，
       净值与投入规模接近、折现期又短，会解出 ±90% 这类失真值（无经济意义）。
       这种情况显示「—」，并在悬浮说明里注明，避免误导判断。 */
    if (dayDiff(parseDate(start), parseDate(endDate)) < 45) return null;
    var ann = xirrSolve(flows);
    if (ann === null || !isFinite(ann) || Math.abs(ann) > 50) return null;
    return ann;
  }

  /* 组合在指定日期的持仓市值（按当日已起息份额 × 当日或之前最近披露净值）。
     用于区间 XIRR 的期初/期末市值锚点；只统计当前仍持有（未清仓）的产品，
     已落袋部分通过赎回现金流体现，避免重复计入。 */
  function portfolioMvOn(date, keepPid) {
    var total = 0;
    HOLDINGS.forEach(function (h) {
      if (keepPid && !keepPid[h.product.id]) return;
      if (!(h.shares > 0.000001)) return;
      var p = h.product;
      var nav = null, navDate = null;
      for (var i = 0; i < p.dates.length; i++) {
        if (p.dates[i] <= date) { nav = p.nav[i]; navDate = p.dates[i]; } else break;
      }
      if (!(nav > 0) || !navDate) return;
      var sh = h.lots ? vestedShares(h.lots, navDate) : (navDate < h.startDate ? 0 : h.shares);
      total += sh * nav;
    });
    return total;
  }

  // 交易底稿 → 持仓：申购累加份额，赎回/清仓按确认净值扣减，起息日 = 首次确认日
  function computeHoldings() {
    normalizeTxConfirmDates();
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
      if (!rec) rec = acc[p.id] = { product: p, shares: 0, cost: 0, invested: 0, realized: 0, startDate: null, lots: [], gainLots: [], lastTx: t };
      /* 成交净值缺失时按确认日净值兜底，净值披露后自动生效 */
      var nav = Number(t.confirmNav) || navForConfirm(p, t.applyDate || t.confirmDate) || 1;
      var sh = Number(t.shares);
      if (!(sh > 0)) sh = Number(t.amount) / nav;
      if (t.type === '赎回' || t.type === '清仓') {
        var sell = t.type === '清仓' ? rec.shares : Math.min(rec.shares, sh);
        /* 已无份额可卖（重复录入的清仓/赎回）直接忽略，避免覆盖真实清仓日 */
        if (!(sell > 0)) return;
        var avg = rec.shares > 0 ? rec.cost / rec.shares : nav;
        var realizedGain = sell * (nav - avg);
        rec.realized += realizedGain;
        rec.cost -= sell * avg;
        rec.shares -= sell;
        /* 赎回款：整笔赎回优先用底稿金额（银行实际到账），部分赎回按成交净值折算 */
        var proceeds = (sell >= sh - 1e-6 && Number(t.amount) > 0) ? Number(t.amount) : sell * nav;
        cashFlows.push({ d: t.confirmDate || t.applyDate, v: proceeds, pid: p.id });
        /* 赎回/清仓按先进先出扣减份额批次，保证剩余批次的起息日归属正确。
           2026-11-26：同时维护「收益时间线」gainLots——被卖出的份额不必删除，
           而是标记 soldDate（卖出成交净值日）转入已闭合段，之后由 buildAggregate
           按日计息，收益自然停在卖出当天，而不是整笔砸在确认日。 */
        var remain = sell;
        var sellDate = navDateAt(p, t.applyDate || t.confirmDate) || t.confirmDate || t.applyDate;
        for (var li = 0; li < rec.lots.length && remain > 1e-9; li++) {
          var take = Math.min(rec.lots[li].shares, remain);
          rec.lots[li].shares -= take;
          remain -= take;
        }
        rec.lots = rec.lots.filter(function (l) { return l.shares > 1e-9; });
        /* gainLots：把每个被卖批次拆成「持有段（含卖出当日）」+「剩余仍持有段」 */
        var glNext = [];
        var glRemain = sell;
        rec.gainLots.forEach(function (gl) {
          if (gl.soldDate || glRemain <= 1e-9) { glNext.push(gl); return; }
          var gt = Math.min(gl.shares, glRemain);
          glNext.push({ date: gl.date, buyNav: gl.buyNav, shares: gt, soldDate: sellDate });
          glRemain -= gt;
          if (gl.shares - gt > 1e-9) {
            glNext.push({ date: gl.date, buyNav: gl.buyNav, shares: gl.shares - gt, soldDate: null });
          }
        });
        rec.gainLots = glNext;
      } else {
        /* 清仓后重新申购：起息日按本次确认日重新计算 */
        if (!(rec.shares > 0.000001)) rec.startDate = t.confirmDate;
        /* 每笔买入记为独立份额批次，起息日 = 该笔确认日（默认 T+1，T+2 产品为 T+2）。
           银行规则：T 日按 T 日净值成交、确认日起息；一批份额的收益从
           「确认日当日净值」开始归属，确认日之前的净值涨跌与其无关。
           navDate 记录「成交净值日」（T 日），只用于年化分母，保证与按成交净值买入的分子同口径。 */
        var buyNavDate = navDateAt(p, t.applyDate || t.confirmDate) || t.confirmDate || t.applyDate;
        rec.lots.push({ date: t.confirmDate || t.applyDate, navDate: buyNavDate, shares: sh });
        /* 收益时间线：成交净值日(T日)的净值作为首日起息基准，确认日(批次 date)起计入收益 */
        rec.gainLots.push({
          date: t.confirmDate || t.applyDate,
          buyNav: Number(t.confirmNav) || navOnDate(p, buyNavDate) || nav,
          shares: sh,
          soldDate: null
        });
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
         起息日 = 份额确认日（T 日申购按 T 日净值成交，确认日起息）。
         确认日早于产品首个净值日时（新发产品成立当天确认、次日起才有净值），
         起息日按首个净值日计：产品没有净值的日子不可能产生收益，也不能算进持有期。
         例：信银安盈象14天165号 08-25 成立并确认、08-26 首个净值日，
         持仓天数按 08-26 起算（84 天），与建行 App 一致；成立天数仍按 08-25 算（85 天）。
         年化分母另用「计息天数 = 最新净值日 − 成交净值日」（见下方 accrualStart）：收益只覆盖到最新净值日，
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
      /* 计息起点用「成交净值日」（首个批次的 T 日），不用确认日：
         分子是按成交净值买入后的市值变化，已包含确认日当天的净值涨幅，
         分母若从确认日算会少算一天、把新买入产品的年化放大近一倍（2026-11-21 修正）。
         买入日早于产品成立日（募集期认购）时仍以成立日为下限。 */
      var accrualStart = (rec.lots && rec.lots[0] && rec.lots[0].navDate) || daysStart;
      if (incep && accrualStart && accrualStart < incep) accrualStart = incep;
      var accrualDays = alive ? Math.max(0, dayDiff(parseDate(accrualStart), parseDate(accrualEnd))) : 0;
      /* 计息天数必须与分子同口径的硬校验（2026-11-21）：分子 unrealized 是按成交净值买入后的
         市值变化，起点即「成交净值日」；若分母改用确认日会少算 1 天、把新仓年化放大近一倍
         （中银悦享天添24号曾因此显示 14.51%，实际 7.25%）。这里做一次不变量自检，
         任何后续改动把起点改回确认日、或把终点改成今天，都会在控制台直接报错。 */
      if (alive) assertHoldMath(p, rec, accrualStart, accrualEnd, accrualDays);
      var costNav = alive ? rec.cost / rec.shares : 0;
      var lastPer = p.per10k[n - 1];
      /* 「持仓收益」只算当前仍持有份额的盈亏（市值 − 剩余成本），与建行 App 口径一致；
         已赎回部分落袋的收益归入「累计收益」，两列并列展示。
         因此收益率、年化的分子都用持仓收益、分母都用当前持仓成本，三者自洽。 */
      var invested = rec.invested > 0 ? rec.invested : rec.cost;
      var unrealized = mv - rec.cost;
      /* 今日收益按「截至最新净值日已起息的份额」计算（而非全部持仓份额）：
         追加申购的新份额在自身确认日之前不产生收益，避免把未起息份额算进当日收益。
         2026-11-26：改为直接用收益时间线的净值差（与盈亏日历同一个 gainsOnDate），
         不再拿「已四舍五入到分的万份收益」乘份额 —— 万收 0.31 元本身就带了
         ±0.005 元的取舍误差，1.5 万份时正好放大到半厘，于是汇总 +0.47、
         日历 +0.46，同一个产品同一天差 0.01。净值差是原始精度，两边必然同值。 */
      var incomeShares = alive ? vestedShares(rec.lots, p.latestDate) : 0;
      var income = 0;
      if (incomeShares > 1e-9) {
        if (rec.gainLots && rec.gainLots.length) {
          var glm = gainsOnDate(p, rec.gainLots, n - 1);
          if (glm.cnt > 0) income = glm.inc;
        } else if (lastPer !== null && lastPer !== undefined) {
          /* 无收益时间线的老数据兜底：仍按万收折算 */
          income = lastPer * incomeShares / 10000;
        }
      }
      /* 2026-11-26：已清仓产品在「卖出当日」仍计息——用收益时间线算最新净值日的最后一日收益，
         不再因份额归零一律显示「—」。卖出后若净值日继续推进，已闭合段不会再贡献收益，
         income 自然为 0（显示为 0.00，符合「已无持仓、当日无收益」）。 */
      if (!alive && rec.gainLots && rec.gainLots.length) {
        var lg = gainsOnDate(p, rec.gainLots, n - 1);
        if (lg.cnt > 0 && Math.abs(lg.inc) > 1e-9) {
          income = lg.inc;
          incomeShares = rec.gainLots.reduce(function (s, gl) {
            return (gl.soldDate && gl.soldDate >= p.latestDate) ? s + gl.shares : s;
          }, 0);
        }
      }
      var incomePending = !(incomeShares > 1e-9) || (alive && (lastPer === null || lastPer === undefined));
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
        /* 计息区间与短样本标记：表格据此加 * 并置灰，tooltip 据此处摊开算式 */
        accrualStart: accrualStart,
        annShort: accrualDays > 0 && accrualDays < SHORT_ANN_DAYS,
        days: days,
        accrualDays: accrualDays,
        income: incomePending ? 0 : income,
        incomeShares: incomeShares,
        incomePending: incomePending,
        lots: rec.lots,
        gainLots: rec.gainLots,
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
    var sums = {}, prevs = {}, counts = {}, byPid = {};
    products.forEach(function (p) {
      var h = HOLD_BY_PID[p.id];
      if (!h) return;
      /* 2026-11-26：每日收益改按「完整份额批次时间线」逐日计息。
         已清仓份额的收益随着持有期按净值变动逐日计入（含卖出当日），
         不再把整笔已实现收益一次性补记到清仓确认日——那会让清仓当天
         收益/年化异常放大（如 25 号 +63.62、12.73%）。
         每个批次首日以成交净值日净值为起点，之后每日按相邻净值差 × 份额计息。 */
      var lots = (h.gainLots && h.gainLots.length) ? h.gainLots : null;
      for (var i = 0; i < p.dates.length; i++) {
        var dt = p.dates[i];
        var g = lots
          ? gainsOnDate(p, lots, i)
          : (function () { /* 兜底：无时间线的老数据沿用原已起息份额口径 */
              var sh = h.lots ? vestedShares(h.lots, dt) : (dt < h.startDate ? 0 : h.shares);
              if (!(sh > 1e-9)) return { inc: 0, base: 0, cnt: 0 };
              var cum = (p.nav[i] - h.costNav) * sh;
              return { inc: cum, base: h.cost, cnt: 1 };
            })();
        /* 2026-11-26：只按「该日有无已起息批次」判断披露点，收益恰为 0 的日子必须保留。
           旧写法 `Math.abs(g.inc) < 1e-12` 会在净值持平的净值日整条丢弃该日期，
           导致盈亏日历把它画成空白「—」、月度/年度「挂0」也无法计数
           （单产品视图里持仓天数少，几乎全是这种情况，挂0 恒为 0）。
           保留后：能画 0.00、计入挂0，正收益/回撤天数与收益合计均不受影响
           （0 收益日只是把一个 gap 拆成两段，日均与合计口径不变）。 */
        if (!(g.cnt > 0)) continue;
        /* 该产品确实产出了收益点：用于识别「有持仓却完全没进盈亏汇总」的产品（见 AGG_SKIPPED） */
        byPid[p.id] = 1;
        if (!(dt in sums)) { sums[dt] = 0; prevs[dt] = 0; counts[dt] = 0; }
        sums[dt] += g.inc;
        prevs[dt] += g.base;
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
      /* 整数分：用 roundMoney 统一「四舍五入」，避免 0.465 因浮点尾差被 Math.round 舍成 0.46，
         而汇总同一个金额显示 0.47（2026-11-26 中银稳富7天27号 11-25 的 0.01 差异） */
      per10k: dates.map(function (d) { return roundMoney(sums[d]); }),
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
      inception: dates[0],
      /* 哪些产品真的贡献了收益点：没进这里的持仓产品要在日历上显式说明原因，
         否则用户勾选了产品却看不到任何数据，会以为筛选坏了（11-26 贝淳/添利日开30号反馈）。 */
      byPid: byPid
    };
  }

  /* 有持仓但算不出每日收益的产品 → 日历底部给一句原因，不静默消失。
     典型：手工添加的产品只有最新一个净值点；或今天刚确认、净值还没更新到确认日。 */
  var AGG_SKIPPED = [];
  function whyNoDailyIncome(p) {
    var h = HOLD_BY_PID[p.id];
    if (!h) return '没有持仓';
    if (!p.dates || !p.dates.length) return '还没有净值数据';
    var firstLot = '';
    (h.gainLots || []).forEach(function (g) {
      if (g.soldDate) return;
      if (!firstLot || g.date < firstLot) firstLot = g.date;
    });
    if (!firstLot && h.startDate) firstLot = h.startDate;
    var last = p.latestDate || p.dates[p.dates.length - 1];
    if (firstLot && last < firstLot) return '最新净值 ' + last + '，还没到确认日 ' + firstLot;
    if (!(h.shares > 0)) return '已清仓，无在持份额';
    return '暂无可计算的收益点';
  }

  function refreshAggregate() {
    var prods = selectedProducts();
    AGG = buildAggregate(prods);
    AGG_SKIPPED = [];
    var inScope = {}, seen = {};
    prods.forEach(function (p) { inScope[p.id] = 1; });
    /* 用持仓汇总行（含「申购在途」行）判断谁没进 AGG：
       在途产品不在 HOLD_BY_PID 里，只看持仓索引会把它们彻底漏掉，
       而它们恰恰是用户最疑惑的「我明明勾选了，为什么汇总里没有」。 */
    summaryRows().forEach(function (r) {
      var p = r && r.product;
      if (!p || !inScope[p.id] || seen[p.id]) return;
      if (AGG && AGG.byPid && AGG.byPid[p.id]) return;
      seen[p.id] = 1;
      AGG_SKIPPED.push({
        name: p.short || p.name,
        why: r.pending ? '申购在途，净值披露后开始计息' : whyNoDailyIncome(p)
      });
    });
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

  /* 金额取整到分：统一「四舍五入」且不受浮点尾差影响。
     0.465 元在两个地方会算出 0.464999999998 和 0.4650000000000001，
     浏览器默认的 toLocaleString/toFixed 一个给 0.46、一个给 0.47，
     于是同一天同一笔钱在盈亏日历与汇总里差 0.01（2026-11-26 中银稳富7天27号）。
     先按 1e-7 的容差校正、再四舍五入，全站金额只有一种取整结果。 */
  function roundMoney(v) {
    var n = Number(v);
    if (!isFinite(n)) return n;
    var s = n < 0 ? -1 : 1;
    return s * Math.round(Math.abs(n) * 100 + 1e-7) / 100;
  }

  /* 带符号两位小数：正数显示 +，负数自带 -，0 不带符号。
     2026-11-26：千分位统一到这里 —— 年表「收益」原先走 fmtMoney（1,234.56），
     月表走 toFixed（1234.56），同一个数在两处格式不同。全站金额展示共用本函数，
     保证「+1,234.56 / -12.34 / 0.00」在两表、指标卡、日历汇总完全一致。 */
  function fmtSigned(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var n = roundMoney(v);
    var abs = Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n > 0 ? '+' : n < 0 ? '-' : '') + abs;
  }

  function fmtAnn(v) {
    return v === null || v === undefined || isNaN(v) ? '—' : v.toFixed(2) + '%';
  }

  /* 表格单元格专用年化：% 不参与对齐（2026-11-20 用户要求）
     % 包进 .pu（宽度 0、溢出可见），数字右边缘成为对齐基准，% 悬挂进 th/td 预留的右侧挂位。
     † 标记（成立不足 1 年）放在数字左侧：右对齐下不会移动数字右边缘，
     也就不会像原来那样越出单元格边框。 */
  function fmtAnnCell(v, badge) {
    /* 2026-11-26：% 放进 .mcf 末段，不再用零宽 .pu 挂位；
       小数点由 mcell 三段网格锁死，负号/†/% 均不影响点位。 */
    return fmtCellDecimal(v, '%', false, badge);
  }
  /* 日均万收单元格：† 放进整数段，不推小数点 */
  function fmtPerCell(v, badge) {
    return fmtCellDecimal(v, '', false, badge);
  }

  /* 2026-11-25：0 是「净值未披露」的占位哨兵（confirmNav: 0），银行理财净值不会为 0。
     旧版 fmtNav(0) 直接输出 0.000000，看起来像真实净值，极易误读。统一回退为 —。 */
  function fmtNav(v) {
    return !(Number(v) > 0) ? '—' : Number(v).toFixed(6);
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

  /* 2026-11-26：评分五档，阈值 8/6/4/2，各档独立色且避开涨跌红(#c0392b)/绿(#1e8449)。
     ① 优秀 >=8   亮金 #d4a000
     ② 良好 >=6   橙   #e67622
     ③ 中等 >=4   浅棕 #a67850
     ④ 一般 >=2   深棕 #514036
     ⑤ 偏弱 <2    官绿 #01a578
     无评分(sc-none)走中性灰，不计等级。文字与颜色同源：scoreCell 直接用 rating.cls，
     不再另算一套阈值（旧版文字/上色阈值不一致导致 4~5、6~7 区间文字颜色错位）。 */
  function ratingOf(s) {
    if (s >= 8) return { text: '优秀', cls: 'sc-best' };
    if (s >= 6) return { text: '良好', cls: 'sc-good' };
    if (s >= 4) return { text: '中等', cls: 'sc-mid' };
    if (s >= 2) return { text: '一般', cls: 'sc-low' };
    return { text: '偏弱', cls: 'sc-weak' };
  }

  /* 2026-11-26：收益表现按 7/14/30 日年化加权（25%/25%/50%），让短期表现进入评分。
     短窗 ann 缺失（成立不足窗口天数）时按剩余权重归一化；全部缺失则无评分。 */
  var BLEND_WINDOWS = [
    { idx: 0, label: '7日', w: 0.25 },
    { idx: 1, label: '14日', w: 0.25 },
    { idx: 2, label: '30日', w: 0.5 }
  ];
  function blendedAnn(m) {
    if (!m || !m.windows) return { ann: null, parts: [], wsum: 0 };
    var sum = 0, wsum = 0, parts = [];
    BLEND_WINDOWS.forEach(function (bw) {
      var a = m.windows[bw.idx] && m.windows[bw.idx].ann;
      if (a === null || a === undefined || !isFinite(a)) return;
      sum += a * bw.w;
      wsum += bw.w;
      parts.push(bw.label + ' ' + a.toFixed(2) + '%×' + Math.round(bw.w * 100) + '%');
    });
    if (!(wsum > 0)) return { ann: null, parts: [], wsum: 0 };
    return { ann: sum / wsum, parts: parts, wsum: wsum };
  }

  // 1–10 综合评分：收益表现按 7/14/30 日加权年化考核，稳健/趋势仍看近 30 日
  function scoreFor(m, p, peerAvg) {
    var blend = blendedAnn(m);
    var aPerf = blend.ann;
    if (aPerf === null) return null;

    var marketScore = clamp((aPerf - MARKET_RATE) / (RATE_TOP - MARKET_RATE) * 10, 0, 10);
    var peerScore = clamp(((aPerf - peerAvg) + 1) / 2 * 10, 0, 10);

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
      trendScore: trendScore,
      perfAnn: aPerf,
      blendParts: blend.parts,
      blendWsum: blend.wsum
    };
  }

  function activeModels() {
    return MODEL.concat(LIB_MODEL).filter(function (x) {
      return selectedIds.indexOf(x.product.id) !== -1;
    });
  }

  function peerAvg30Of(models) {
    /* 同类均值与收益分同源：用同一套多窗加权年化，口径一致才不会失真 */
    return mean(models.map(function (x) { return blendedAnn(x.m).ann; }).filter(function (v) { return v !== null && v !== undefined; }));
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
    /* 颜色直接用文字等级对应的 cls，保证五档文字与颜色一一对应。 */
    var wsumNote = sc.blendWsum < 0.999 ? '（部分窗口不足，已按剩余权重归一化）' : '';
    var tip = '收益表现加权年化 ' + sc.perfAnn.toFixed(2) + '% = ' + sc.blendParts.join(' + ') + wsumNote +
      ' · 市场利率 ' + MARKET_RATE.toFixed(1) + '% · 收益 ' + sc.marketScore.toFixed(1) +
      ' / 同类 ' + sc.peerScore.toFixed(1) + ' / 稳健 ' + sc.stabilityScore.toFixed(1) +
      ' / 趋势 ' + sc.trendScore.toFixed(1);
    return '<td' + rs + ' class="' + (cls || 'c') + ' st score-col ' + rating.cls + '" title="' + tip + '"><b>' +
      sc.score.toFixed(1) + '</b><i>' + rating.text + '</i></td>';
  }

  /* ---------------- 顶部指标卡 ---------------- */
  function fmtMoney(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return roundMoney(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  /* 表格金额单元格专用：把金额拆成「整数 / 小数点 / 两位小数」三段，
     整数段右对齐占固定宽度、小数段左对齐，小数点由 CSS grid 锁死在同一竖线。
     这样即使 iOS 上字体回退成非等宽字体、千分位逗号宽度不一，也不会让小数点错位。
     2026-11-26：WebKit 长金额小数点锁定（minmax 第一列 + 竖屏加宽数值列）；
     signed=true 时正值补 + 号，供持仓收益/累计收益复用同一套三段结构。 */
  function fmtMoneyCell(v, signed) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var n = roundMoney(v);
    var s = n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (signed && n > 0) s = '+' + s;
    var dot = s.indexOf('.');
    if (dot < 0) return s;
    return '<span class="mcell"><span class="mci">' + s.slice(0, dot) +
      '</span><span class="mcd">.</span><span class="mcf">' + s.slice(dot + 1) + '</span></span>';
  }

  /* 2026-11-26：区间双行数值（7日/14日/30日/成立至今）小数点结构性对齐。
     与 fmtMoneyCell 同构：整数段右对齐占满、点与两位小数/单位段固定，
     正负号、短样本 † 与 % 后缀都不再移动小数点（旧版只靠右对齐 + 零宽 %，
     有符号或不同整数位时目视仍会错开一格）。 */
  function fmtCellDecimal(v, suffix, signed, badge) {
    /* 2026-11-26：无数据统一走 .nodash（固定等宽字体 + 固定字号），
       避免上下两行分属 mono/中文字体时同一个「—」渲染出两种长度。 */
    if (v === null || v === undefined || isNaN(v)) return '<span class="nodash">—</span>';
    var s = (signed && Number(v) > 0 ? '+' : '') + Number(v).toFixed(2);
    var dot = s.indexOf('.');
    if (dot < 0) return s;
    /* 单位（%）放进零宽 .pu 挂位：不能让它参与 mcf 列宽计算，
       否则下行百分比的末列比上行万收宽一个字符，小数点仍会错开约 7px。 */
    var tail = s.slice(dot + 1) + (suffix ? '<span class="pu">' + suffix + '</span>' : '');
    return '<span class="mcell"><span class="mci">' + (badge || '') + s.slice(0, dot) +
      '</span><span class="mcd">.</span><span class="mcf">' + tail + '</span></span>';
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
    /* 本月收益直接取月度表的 sum（同源 cumulativePeriodStats）：
       跨月格按自然日拆开，月初/月末两端都裁，与月度表、日历底部严格同值。 */
    var mStats = AGG ? cumulativePeriodStats(AGG, ym + '-') : null;
    var month = mStats ? mStats.sum : 0;
    var mCnt = mStats && mStats.days > 0 ? 1 : 0;
    /* 本月日均万收统一为自然日口径：本月收益 ÷ 期初市值 ÷ 区间实际自然日数。
       不再按披露点数量平均，避免周末/节假日不披露导致日均虚高。 */
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
    CUM_ANN_CACHE = cumAnn;  // 供盈亏日历年度表复用，保证两处年化严格同值
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
        : '累计年化（XIRR）：Σ Ci/(1+r)^((di−d0)/365)=0 解 r。' +
          '每笔申购记负、赎回与当前市值记正，按实际发生日折现求净现值为 0 的资金加权内部收益率；' +
          '已赎回落袋收益与分批投入时点全部计入。与盈亏日历「年度/月度年化」同口径同数值，' +
          '与只算当前持仓、假设满仓的「持仓年化」不同。';
    }
    el = document.getElementById('metric-value');
    /* 恢复千分位（用户 2026-11-20 后续要求）：逗号保留、字号与其他卡同档不缩，
       靠收紧六卡左右内边距与间距腾出空间（见 index.html 的 .metric padding） */
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
    /* 2026-11-26：清仓当日仍计息，只要收益时间线给出有效末日收益就照常显示万收；
       只有清仓后净值日继续推进、已无份额可取时才返回空。 */
    if (!h || h.incomePending) return null;
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
    /* 2026-11-26：窗口列排序跟随「数据」下拉当前口径，年化模式按 ann 排、万收模式按 per 排，
       避免点了「年化」后表头排序仍按万收值，看起来像「筛选/排序不生效」。 */
    if (key in WINDOW_SORT) {
      var w = m.windows[WINDOW_SORT[key]];
      return holdMetric === 'ann' ? w.ann : w.per;
    }
    return null;
  }

  /* 2026-11-26：行数据计算与表格绘制分离。「数据」下拉切万收/年化时只重绘 tbody，
     不重算持仓/评分/指标卡——旧版整表重绘在手机上卡顿，后来改成只切 CSS class，
     但那些 class 的规则早已不覆盖 .pwin/.awin，导致选了年化仍显示万收。
     这里缓存一份已排序行 + 极值，切换时直接复用，既即时生效又不触发重活。 */
  var profitRowsCache = null;

  function sortProfitRows(rows) {
    if (!profitState.key) return;
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

  function computeProfitRows() {
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

    sortProfitRows(rows);

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

    /* 缓存已算好的行与极值：切换万收/年化时只重绘单元格，不再跑 summaryRows / scoreFor / XIRR */
    profitRowsCache = { rows: rows, maxV: maxV, minV: minV, maxIncome: maxIncome, minIncome: minIncome };
  }

  function paintProfitRows() {
    var tbody = document.getElementById('hold-body');
    if (!tbody || !profitRowsCache) return;
    var rows = profitRowsCache.rows, maxV = profitRowsCache.maxV, minV = profitRowsCache.minV;
    var maxIncome = profitRowsCache.maxIncome, minIncome = profitRowsCache.minIncome;

    var html = '';
    rows.forEach(function (row, i) {
      var p = row.item.product;
      var m = row.item.m;
      var h = HOLD_BY_PID[p.id];

      var badge = '';
      var tv = todayWanOf(p);
      if (tv !== null && tv !== undefined && maxV !== minV) {
        if (Math.abs(tv - maxV) < 1e-9) badge = '<span class="thumb-under" title="今日万收最高">&#8288;' + THUMB_UP + '</span>';
      }
      var downBadge = '';
      if (minIncome !== null && maxIncome !== minIncome && h && !h.incomePending && h.income !== null
          && h.income !== undefined && isFinite(h.income)
          && Math.abs(h.income - minIncome) < 1e-9) {
        downBadge = '<span class="thumb-under thumb-down" title="今日收益最低">&#8288;' + THUMB_DOWN + '</span>';
      }

      var dual = holdMetric === 'both';
      var rs = dual ? ' rowspan="2"' : '';
      var lbl = holdMetric === 'ann' ? '年化' : '日均万收';
      html += '<tr class="ma' + (dual ? ' dual' : '') + '">';
      var mvUnder = (h && h.mv !== null && h.mv !== undefined && !isNaN(h.mv))
        ? '<span class="mv-under" title="持仓市值 ¥' + fmtMoney(h.mv) + '">¥' + fmtMoney(h.mv) + '</span>' : '';
      html += '<td class="c num"' + rs + '>' + (i + 1) + '</td>';
      /* 名称 + 角标（2026-11-21 二轮）：名称拆成「主体 + 末字」，末字与 👍/👎 同组 nowrap，
         角标因此永远紧跟名称最后一个字；名称换行时末字连同角标整体落到下一行，
         不会出现角标孤零零独占一行、也不会跑回首行右端。 */
      var nm = prodDispName(p);
      var nmHead = nm.length > 1 ? nm.slice(0, -1) : '';
      var nmLast = nm.slice(-1);
      var nmAttr = ' href="javascript:void(0)" data-goto-trade="' + p.id + '" title="查看「' + (p.name || '') + '」的交易记录"';
      /* 2026-11-26：盈亏汇总与产品库/持仓汇总联动——清仓行在名称后带同款 T 日角标，
         日期取交易 T 日（applyDate），旧数据回退确认日；与 👍/👎 一起放进 .pn-last
         保持 nowrap，名称换行时整组跟随末字，不孤立成行。 */
      var clearTag = (h && h.cleared && h.tx && (h.tx.applyDate || h.tx.confirmDate))
        ? '<span class="cleared-date">' +
          (h.tx.applyDate || h.tx.confirmDate).slice(5).replace('-', '.') + ' 清仓</span>' : '';
      html += '<td' + rs + '><div class="pname"><div class="pn-row">' +
        '<a class="plink"' + nmAttr + '>' + nmHead + '</a>' +
        '<span class="pn-last"><a class="plink"' + nmAttr + '>' + nmLast + '</a>' + badge + downBadge + clearTag + '</span>' +
        '</div>' + mvUnder + '</div></td>';
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
      html += '<td class="r num ' + (h && h.annShort ? 'muted' : colorBy(h ? h.ann : null)) + '"' + rs +
        ' title="' + (h ? annTipOf(h) : '') + '">' +
        fmtAnnCell(h ? h.ann : null, h && h.annShort ? '<sup class="dag" title="计息不足 ' + SHORT_ANN_DAYS + ' 天，年化为短样本折算，仅供参考">*</sup>' : '') + '</td>';
      var listDays = listingDaysOf(p);
      var daysTip = (h ? '持仓天数 ' + h.days + ' 天 = 今天 − 起息日 ' + (h.effStartDate || '') +
          '；年化按计息 ' + h.accrualDays + ' 天（至最新净值日 ' + (h.latestDate || '') + '）折算' : '') +
        (listDays !== null ? (h ? '；' : '') + '成立天数 ' + listDays + ' 天 = 今天 − 成立日 ' +
          (inceptionDateOf(p) || '') : '');
      html += '<td class="c num dcell daystack"' + rs + ' title="' + daysTip + '">' +
        (h ? '<span class="days">' + h.days + '</span>' : '—') +
        (listDays !== null ? '<span class="dsep">' + (h ? h.days : listDays) + '</span><span class="days sub">' + listDays + '</span>' : '') + '</td>';
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
        perCells += '<td class="c num pwin ' + colorBy(w.per) + '" title="' + perTip + '">' + fmtPerCell(w.per, mark) + '</td>';
        annCells += '<td class="c num awin ' + colorBy(w.ann) + '" title="' + annTip + '">' + fmtAnnCell(w.ann, mark) + '</td>';
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
  }

  /* 完整重绘：重算行数据（含净值日期筛选/评分/排序）→ 画表 → 刷新指标卡 */
  function renderProfitTable() {
    computeProfitRows();
    paintProfitRows();
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
        /* 2026-11-26：排序只改顺序，缓存的行数据没变——复用缓存重排 + 重绘即可，
           不再跑 summaryRows / scoreFor / XIRR（点表头的卡顿来源）。 */
        if (profitRowsCache) {
          sortProfitRows(profitRowsCache.rows);
          paintProfitRows();
        } else {
          renderProfitTable();
        }
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
      /* 2026-11-26：切换后必须按新口径重绘单元格。旧逻辑只切 CSS class，
         但 #hold-table 里根本没有 .st.win / .lbl 节点，选了「年化」仍显示万收，
         用户误以为卡住、反复点选造成卡顿感。这里只重画 tbody，复用已缓存的行数据，
         不跑 summaryRows / scoreFor / XIRR，实测 <2ms，手机也即时响应。 */
      paintProfitRows();
    }

    sel.addEventListener('change', apply);
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
    /* 表头文字由 .th-btn 渲染（原生 select 已透明覆盖在上方），
       未筛选时显示两行「净值 / 日期」，选定日期后显示该日 mm-dd */
    var lab = document.getElementById('hold-date-lab');
    if (lab) {
      lab.classList.toggle('on', !!keep);
      lab.innerHTML = '<span>' + (keep ? mmdd(keep) : '净值<br>日期') + '</span>';
    }
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
  /* 2026-11-26（晚间修正）：按自然日把每个披露段摊进区间，两端都裁。
     披露日遇周末/节假日会顺延，所以一格常压 2~3 天（如 10-30 → 11-02 一格含
     10-31、11-01、11-02 三天）。整段金额既含上期尾几天、也含本期头几天。
     日历格子仍显示整段披露值（数据里没有逐日净值），但月度/年度/本月收益/
     日均万收只能算落在本期内的天数。
     旧实现只处理「本期第一格里的上期尾巴」，漏掉了「上期最后一格里的本期尾巴」：
     10-31 那天藏在 11-02 的格子里，10 月统计遍历不到 11 月的日期，于是这天的
     收益既不在 10 月、也不在 11 月，永远消失 —— 表现就是「10 月 +0.99、
     11 月 0.00、年度却 0.00（年度全额计入那段含 10-31 的 -2.98）」。
     现改为对每个段与 [from, to] 求重叠天数，>0 才按天数比例计入：
       · 月度相加 = 年度（同一天只归属一个期间，不重不漏）
       · 月初那格只给本月该得的部分，月末那格也把本月尾巴还给本月
     返回 { v: 本期收益份额, days: 本期计息天数 }。 */
  function periodShare(p, i, from, to) {
    var raw = p.raw ? p.raw[i] : p.per10k[i];
    if (raw === null || raw === undefined) return null;
    var segEnd = p.dates[i];
    var segStart = (p.prevDates && p.prevDates[i]) || segEnd;
    /* 先做字符串区间快速排除，避免为几千个披露点反复 parseDate：
       段末早于期间起点 → 整段在期间之前；段起点不早于期间终点 → 整段在期间之后。 */
    if (segEnd < from || segStart >= to) return null;
    var gap = p.gaps && p.gaps[i] > 0 ? p.gaps[i] : 1;
    /* 段覆盖 (segStart, segEnd] 共 gap 天；换成相对 from 的偏移算重叠。
       首个披露段的 prevDates 等于自身（差值 0 天），需按 gap 回推起点。 */
    var a = parseDate(from), b = parseDate(to);
    var d1 = dayDiff(a, parseDate(segEnd));
    var d0 = dayDiff(a, parseDate(segStart));
    if (d1 - d0 < gap) d0 = d1 - gap;
    var endOff = dayDiff(a, b);
    var lo = Math.max(d0 + 1, 0);
    var hi = Math.min(d1, endOff);
    var days = hi - lo + 1;
    if (!(days > 0)) return null;
    if (days >= gap) return { v: raw, days: gap };
    return { v: raw * days / gap, days: days };
  }

  /* 期间字符串 → [起, 止]（含两端）。年度 prefix 形如 '2026-'，月度 '2026-11-'。 */
  function periodRange(prefix) {
    if (/^\d{4}-$/.test(prefix)) return [prefix + '01-01', prefix + '12-31'];
    var y = +prefix.slice(0, 4), m = +prefix.slice(5, 7);
    var last = new Date(y, m, 0).getDate();
    return [prefix + '01', prefix + String(last).padStart(2, '0')];
  }

  function cumulativePeriodStats(p, prefix) {
    if (!p || !p.dates || !p.dates.length) return { avg: null, ann: null, days: 0, sum: 0 };
    var range = periodRange(prefix);
    var sum = 0, acc = 0, days = 0;
    /* 不再按日期前缀过滤：本期末尾那几天可能压在下一个月的首格里，
       必须遍历全部披露点，靠重叠天数决定它归属本期多少。 */
    for (var i = 0; i < p.dates.length; i++) {
      var sh = periodShare(p, i, range[0], range[1]);
      if (!sh) continue;
      var base = p.prevMv && p.prevMv[i] > 0 ? p.prevMv[i] : 0;
      /* 无市值的段（清仓后空档）整段跳过：收益与日均同时不计，避免一方进一方不进 */
      if (!(base > 0) || !(sh.days > 0)) continue;
      /* v/base 是「该段累计收益率」（段内 sh.days 天合计），先按段累加收益率，
         最后统一除以总天数：avg = Σ(段收益率) / Σ(段天数) × 10000。
         不能写成 Σ(段收益率 × 天数)：段收益率本身已含天数，再乘会把周更产品的权重放大。 */
      sum += sh.v;
      acc += sh.v / base;
      days += sh.days;
    }
    if (!(days > 0)) return { avg: null, ann: null, days: 0, sum: sum };
    var avg = acc / days * 10000;
    return { avg: avg, ann: avg * 3.65, days: days, sum: sum };
  }

  function monthStats(p, perMap, y, m, keepPid) {
    var prefix = y + '-' + String(m + 1).padStart(2, '0') + '-';
    var cnt = 0, pos = 0, neg = 0, flat = 0;
    p.dates.forEach(function (dt) {
      if (dt.indexOf(prefix) !== 0) return;
      var v = perMap[dt];
      if (v === undefined) return;
      cnt += 1;
      /* 正/回撤/挂0 按单日金额判号，跨月段缩放不改符号，故无需摊销 */
      if (v > 0.005) pos += 1;
      else if (v < -0.005) neg += 1;
      else flat += 1;
    });
    /* 月度「收益」不再自己全额求和，直接用 cumulativePeriodStats 的 sum：
       它已按 periodShare 只统计落在本月的那几天，与「日均万收」同源，两列必然同号。 */
    var st = cumulativePeriodStats(p, prefix);
    /* 2026-11-26：月度「年化」改用「单月收益率年化」口径 —— 当月收益 ÷ 期初市值
       × 365 ÷ 当月自然日数，等价于日均万收 × 3.65。
       旧口径是「截至当月底的累计 XIRR」，早期月份跨度不足 45 天或现金流稀疏时
       被稳健性保护判空，整列只剩最新月有数。改为单月口径后，每个有收益的月份
       都有可读的年化；注意它与顶部累计年化卡（全区间 XIRR）不再同值，两者含义不同：
       月度列衡量「该月赚钱速度」，累计卡衡量「整笔资金的内部收益率」。 */
    var ann = st.ann;
    return {
      sum: st.sum,
      avg: st.avg,
      cnt: cnt,
      pos: pos,
      neg: neg,
      flat: flat,
      ann: ann
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
    /* 2026-11-25：新品在途申购可能让 AGG 暂无任何收益日（latestDate 为空），
       旧版直接 parseDate(undefined) 抛错、整页渲染中断。回退到数据快照日。 */
    var latest = (AGG && AGG.latestDate) || DATA.asOf || isoDate(new Date());
    var d = parseDate(latest);
    calState.y = d.getFullYear();
    calState.m = d.getMonth();
  }

  /* 日历底部提示：数据区间 + 「哪些持仓产品没算进来、为什么」。
     用 textContent 组装，避免产品名里的特殊字符被当成 HTML。 */
  function paintCalHint(baseText) {
    var el = document.getElementById('cal-range-hint');
    if (!el) return;
    el.textContent = baseText || '';
    if (!AGG_SKIPPED.length) return;
    var row = document.createElement('div');
    row.className = 'cal-skip';
    row.textContent = '未计入每日收益：' + AGG_SKIPPED.map(function (s) {
      return s.name + '（' + s.why + '）';
    }).join('；');
    el.appendChild(row);
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
    var p = AGG;
    if (!p || !p.dates.length) {
      renderYearView();
      wrap.innerHTML = '';
      /* 2026-11-26：AGG 为空时必须把月度表一起清掉（E69）。
         旧版只清日历，年度表由 renderYearView 自己写空态，月度表却保留上一次渲染的
         HTML，于是「只选在途产品」时出现「年度暂无收益数据、月度却还挂着 11 月 +18.33」
         的自相矛盾画面。空态文案与留白和年度表保持一致。 */
      var listEl0 = document.getElementById('month-list');
      if (listEl0) {
        listEl0.innerHTML = '<div class="month-row mhead"><span>月份</span><span>收益</span>' +
          '<span>日均万收</span><span>正收益</span><span>回撤</span><span>挂0</span><span>年化</span></div>' +
          '<div class="month-empty">暂无收益数据</div>';
      }
      var yLabel0 = document.getElementById('year-label');
      if (yLabel0) yLabel0.textContent = '月度收益';
      /* 日历标题也不能留着上一次的年月（否则空态还写着「2026 年 11 月 · 每日收益」） */
      var calSub0 = document.getElementById('cal-sub');
      if (calSub0) calSub0.textContent = '每日收益';
      /* 没有收益数据时年月切换无意义：置灰并显示占位，避免残留上一次的年月值 */
      ['cal-year-sel', 'cal-month-sel'].forEach(function (id) {
        var s = document.getElementById(id);
        if (!s) return;
        s.innerHTML = '<option>—</option>';
        s.disabled = true;
      });
      ['cal-year-prev', 'cal-year-next', 'cal-prev', 'cal-next'].forEach(function (id) {
        var b = document.getElementById(id);
        if (b) b.disabled = true;
      });
      var sumEl0 = document.getElementById('cal-summary');
      if (sumEl0) sumEl0.innerHTML = '<span class="lead">当月收益<b>—</b><i>元</i></span>';
      paintCalHint('暂无每日收益数据');
      return;
    }

    var years = yearsOf(p);
    if (years.indexOf(calState.y) === -1) calState.y = years[years.length - 1];
    var months = monthsOf(p, calState.y);
    if (months.indexOf(calState.m) === -1) calState.m = months[months.length - 1];
    /* 年度表跟随当前选中年份（而非固定最新年），否则切到历史年后边框停在旧行 */
    renderYearView();

    var perMap = perMapOf(p);
    var annMap = annMapOf(p);
    /* 月度合计改用未取整的原始收益累加，避免逐日四舍五入后求和产生 0.01~0.02 元偏差 */
    var sumMap = rawMapOf(p);

    // 年 / 月下拉
    var ySel = document.getElementById('cal-year-sel');
    if (ySel) {
      ySel.disabled = false;
      /* 下拉按降序呈现（最新在最前），底层 years 数组仍升序供 stepYear 箭头使用 */
      ySel.innerHTML = years.slice().reverse().map(function (y) {
        return '<option value="' + y + '">' + y + ' 年</option>';
      }).join('');
      ySel.value = String(calState.y);
    }
    var mSel = document.getElementById('cal-month-sel');
    if (mSel) {
      mSel.disabled = false;
      /* 月份同样降序；months 来自实际净值日期，天然不含未来月 */
      mSel.innerHTML = months.slice().reverse().map(function (m) {
        return '<option value="' + m + '">' + (m + 1) + ' 月</option>';
      }).join('');
      mSel.value = String(calState.m);
    }

    var yLabel = document.getElementById('year-label');
    if (yLabel) yLabel.textContent = calState.y + ' 年 · 月度收益';
    var rangeHint = document.getElementById('cal-range-hint');
    if (rangeHint) paintCalHint('数据区间 ' + p.dates[0] + ' ~ ' + p.dates[p.dates.length - 1]);

    // 左侧月度收益表
    var list = document.getElementById('month-list');
    if (list) {
      var monthPids = {};
      selectedProducts().forEach(function (sp) { monthPids[sp.id] = 1; });
      var monthRows = months.map(function (m) {
        var st = monthStats(p, sumMap, calState.y, m, monthPids);
        return { m: m, st: st };
      });
      var monthAnnFormula = '月度年化 = 当月收益 ÷ 当月期初市值 × 365 ÷ 当月自然日数 × 100%' +
        '（等价于日均万收 × 3.65），衡量该月赚钱速度。' +
        '与顶部「累计年化」口径不同：后者是全区间资金加权 XIRR，衡量整笔资金内部收益率，两者不要求同值。';
      var html = '<div class="month-row mhead"><span>月份</span><span title="按自然日计：跨月的披露格按天数拆开，月初那格只计本月天数、月末那格也把本月尾巴算回本月，所以各月相加严格等于全年。">收益</span><span>日均万收</span><span>正收益</span><span>回撤</span><span>挂0</span><span>年化</span></div>';
      html += '<div class="month-rows">';
      monthRows.slice().reverse().forEach(function (r) {
        var st = r.st;
        /* 2026-11-24 q：年化数据条取消大拇指角标，只保留渐变条与数值 */
        html += '<div class="month-item' + (r.m === calState.m ? ' on' : '') + '" data-month="' + r.m + '">' +
          '<span class="m">' + (r.m + 1) + '月</span>' +
          '<span class="v ' + colorBy(st.sum) + '">' + fmtSigned(st.sum) + '</span>' +
          '<span class="d ' + colorBy(st.avg) + '" title="日均万收 = 当月收益 ÷ 期初市值 ÷ 自然日数 × 10000；每日赚钱速度，时间加权">' + fmtSigned(st.avg) + '</span>' +
          '<span class="d">' + st.pos + '</span>' +
          '<span class="d">' + st.neg + '</span>' +
          '<span class="d">' + st.flat + '</span>' +
          '<span class="rate-cell ' + rateLevel(st.ann) + '" style="--w:' + barW(st.ann) + '" title="' + monthAnnFormula + '">' + fmtAnn(st.ann) + '</span>' +
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

    var pos = 0, neg = 0, flat = 0;
    var compact = (window.innerWidth || 1200) < 480;
    for (var d2 = 1; d2 <= lastDay; d2++) {
      var ds = prefix + String(d2).padStart(2, '0');
      var v = perMap[ds];
      var a = annMap[ds];
      if (v === undefined) {
        cells.push('<div class="cell nodata"><div class="d">' + d2 + '</div><div class="v">—</div><div class="a">—</div></div>');
        continue;
      }
      /* 2026-11-26：与月度表、年度表同口径 —— 跨月格只把落在本月的那几天计入合计。
         日历格子本身仍显示整段披露值（数据里没有拆分后的每日净值），所以
         「格子逐格相加」会比这里的合计多出月初/月末那几天，属口径统一的必然代价；
         跨月格已加 title 说明覆盖哪几天。 */
      var ai = (AGG && AGG.dates) ? AGG.dates.indexOf(ds) : -1;
      if (v > 0.005) pos += 1; else if (v < -0.005) neg += 1; else flat += 1;
      /* 2026-11-26：挂0 日（收益恰为 0）保留后，不能让 0 抢走「最佳/最低」角标 ——
         整月无回撤时 0 会变成最小值、被误标成「今日收益最低」。
         最佳只在有正收益时标记，最低只在真有回撤（< -0.005）时标记。 */
      var best = (maxV !== null && maxV > 0.005 && Math.abs(v - maxV) < 1e-9);
      var worst = (minV !== null && minV < -0.005 && Math.abs(v - minV) < 1e-9);
      // 手机端格子窄，两位小数会被截断，绝对值≥10 时收一位
      var txt = (compact && Math.abs(v) >= 10) ? (v > 0 ? '+' : '') + v.toFixed(1) : fmtSigned(v);
      /* 跨多日的格子标一句覆盖范围：周末/节假日顺延后一格常压了 2~3 天，
         让「格子是几天的合计」这件事在界面上可见，不至于误以为是单日收益 */
      var spanTip = '';
      if (ai >= 0 && AGG.gaps && AGG.gaps[ai] > 1 && AGG.prevDates) {
        spanTip = ' title="' + ds + ' 覆盖 ' + AGG.prevDates[ai] + ' 至 ' + ds + ' 共 ' + AGG.gaps[ai] +
          ' 天的收益；月度/年度统计按自然日拆到各自月份，本格只显示整段披露值' + '"';
      }
      cells.push('<div class="cell' + (best ? ' best' : '') + '"' + spanTip + '>' +
        '<div class="d">' + d2 + (best ? '<span class="thumb">' + THUMB_UP + '</span>' : '')
          + (worst ? '<span class="thumb thumb-down" title="今日收益最低">' + THUMB_DOWN + '</span>' : '') + '</div>' +
        '<div class="vrow"><span class="v ' + colorBy(v) + '">' + txt + '</span></div>' +
        '<div class="a">' + fmtAnn(a) + '</div></div>');
    }
    wrap.innerHTML = cells.join('');

    var sub = document.getElementById('cal-sub');
    if (sub) sub.textContent = calState.y + ' 年 ' + (calState.m + 1) + ' 月 · 每日收益';

    /* 当月收益 = 月度表同一结果（同源 cumulativePeriodStats）：
       它把跨月格按自然日拆给上月/本月，且两端都裁，月度相加 = 年度。 */
    var mStat = cumulativePeriodStats(AGG, prefix);
    var sum = mStat.sum;
    var summary = document.getElementById('cal-summary');
    if (summary) {
      summary.innerHTML =
        '<span class="lead" title="只计落在本月的自然日：月初第一格若压了上月末 2~3 天，那部分算上月；月末最后一格压到下月初的那部分算下月。故与日历格子逐格相加会差这几天的份额。">当月收益<b class="' + colorBy(sum) + '">' + fmtSigned(sum) + '</b><i>元</i></span>' +
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
      if (!map[y]) map[y] = { sum: 0, cnt: 0, pos: 0, neg: 0, flat: 0 };
      /* 年度「收益」放到循环后按年统一算（cumulativePeriodStats 的 sum）：
         跨年首段按自然日拆开，两端都裁，年度 = 各月相加，避免跨年时两列符号相反。 */
      map[y].cnt += 1;
      if (v > 0.005) map[y].pos += 1;
      else if (v < -0.005) map[y].neg += 1;
      /* 2026-11-26：年度表补「挂0」计数，与月度表 flat 同口径（|万收|≤0.005）。
         原年度表第 6 列既无表头也无数值，月度表却有「挂0」，两表对不上。 */
      else map[y].flat += 1;
    });
    var years = Object.keys(map).sort().reverse();
    var latestYear = years[0];
    /* 年度「年化」统一为资金加权 XIRR（与顶部累计年化卡同源同值）。
       —— 旧口径是「日均万收 × 365」的时间加权折算，假设资金全年满仓，
          在分期投入时系统性偏高，导致与累计年化卡对不上。
       —— 最新年度直接复用累计年化卡算出的 CUM_ANN_CACHE，两个数严格相等；
          历史年度用截至该年末的区间 XIRR，口径一致。 */
    var aggPids = {};
    selectedProducts().forEach(function (p) { aggPids[p.id] = 1; });
    var annFormula = '年化 = 资金加权内部收益率（XIRR）：Σ Ci/(1+r)^((di−d0)/365)=0 解 r。' +
      '申购记为负、赎回与期末市值记为正，按每笔实际发生日折现；' +
      '已赎回落袋收益与分批投入时点全部计入，与顶部「累计年化」同口径。' +
      '历史年度现金流跨度不足或结果失真时显示「—」。';
    tbody.innerHTML = years.map(function (y) {
      var s = map[y];
      /* 日均万收保持自然日口径（时间加权的赚钱速度指标，与年化不再互为折算） */
      var st = cumulativePeriodStats(AGG, y + '-');
      /* 年度「收益」与日均万收同源：同一次计算里的 sum，两列必然同号，
         且严格等于该年 12 个月度行之和（自然日不重不漏）。 */
      s.sum = st.sum;
      var avgWan = st.avg;
      var yearEnd = y + '-12-31';
      /* 最新年度：直接复用累计年化卡的值，确保与指标卡严格相等 */
      var ann = (y === latestYear) ? CUM_ANN_CACHE : xirrRangeAnn(yearEnd, aggPids);
      var annTitle = annFormula + '｜' + y + ' 年度，计 ' + s.cnt + ' 个披露点，收益 ' + fmtSigned(s.sum) + ' 元' +
        (ann === null ? '（现金流不足，无法求解）' : '');

      return '<tr data-year="' + y + '" class="' + (y === String(calState.y) ? 'on' : '') + '">' +
        '<td class="ym">' + y + '</td>' +
        '<td class="r num ' + (colorBy(s.sum) || 'muted') + '">' + fmtSigned(s.sum) + '</td>' +
        '<td class="r num cnt ' + colorBy(avgWan) + '" title="日均万收 = 区间收益 ÷ 期初市值 ÷ 自然日数 × 10000；每日赚钱速度，时间加权">'
          + (avgWan === null ? '—' : fmtSigned(avgWan)) + '</td>' +
        '<td class="num cnt">' + s.pos + '</td>' +
        '<td class="num cnt">' + s.neg + '</td>' +
        '<td class="num cnt">' + (s.flat || 0) + '</td>' +
        '<td><div class="rate-cell ' + rateLv(ann) + '" style="--w:' + barW(ann) + '" title="' + annTitle + '">' + (ann === null ? '—' : ann.toFixed(2) + '%') + '</div></td>' +
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

    /* 年度收益行也可点选：点哪年就切到哪年，蓝框跟着选中行走（2026-11-24 用户要求） */
    var ybody = document.getElementById('year-body');
    if (ybody) ybody.addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('tr[data-year]') : null;
      if (!row || !AGG) return;
      calState.y = +row.dataset.year;
      var ms = monthsOf(AGG, calState.y);
      if (ms.length && ms.indexOf(calState.m) === -1) calState.m = ms[ms.length - 1];
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
  /* 2026-11-24 z：ECharts 精简包 + 首屏空闲预取。
     旧版有两处导致手机「图表加载中…」长时间停留：① 用 1MB 全量包；
     ② 只有点开趋势子页才触发下载（renderTrend 在隐藏态 width=0 时提前 return，
        根本没调用 withEcharts）。现改为：只打进曲线真正用到的 line/grid/tooltip/
        markPoint/markLine + SVG 渲染器（约 500KB，gzip 173KB），并在首屏 init 后
        立即用 fetch 预热 HTTP 缓存、load 完成后空闲注入脚本——用户读首屏这几秒里
        图库已就绪，切到趋势页几乎不再等待。 */
  var CHART_URL = './_shared/js/echarts.slim.js?v=20261127f';
  function injectEcharts() {
    if (window.echarts || window.__ECHARTS_INJECTED__) return;
    window.__ECHARTS_INJECTED__ = true;
    var s = document.createElement('script');
    s.src = CHART_URL;
    s.onerror = function () {
      window.__ECHARTS_LOADING__ = false;
      var tip = document.getElementById('boot-tip');
      if (tip) { tip.textContent = '图表加载失败，请刷新重试'; tip.hidden = false; }
      var el = document.getElementById('chart');
      if (el) el.textContent = '图表加载失败，请刷新重试';
    };
    s.onload = function () {
      var q = window.__ECHARTS_QUEUE__ || [];
      window.__ECHARTS_QUEUE__ = [];
      q.forEach(function (fn) { fn(); });
    };
    document.head.appendChild(s);
  }
  /* 首屏预热：用 rel=preload 只下载、不执行、不阻塞渲染，且与随后的 <script>
     同 URL 自动去重（只下载一次）；真正执行延后到 load 之后，避免动态脚本
     推迟「加载完成」状态。 */
  function warmEcharts() {
    if (window.echarts) return;
    if (document.readyState === 'complete') { injectEcharts(); return; }
    try {
      if (!document.querySelector('link[rel="preload"][href="' + CHART_URL + '"]')) {
        var pre = document.createElement('link');
        pre.rel = 'preload';
        pre.as = 'script';
        pre.href = CHART_URL;
        document.head.appendChild(pre);
      }
    } catch (e) {}
    window.addEventListener('load', injectEcharts, { once: true });
  }
  function withEcharts(cb) {
    if (window.echarts) { cb(); return; }
    warmEcharts();
    (window.__ECHARTS_QUEUE__ = window.__ECHARTS_QUEUE__ || []).push(cb);
  }
  /* 2026-11-24：标签/子页切换只需让趋势图重取尺寸，不必广播 window resize
     （广播会连带触发 renderCalendar、关闭弹层等无关重活，手机上造成点击卡顿）。 */
  window.__DASH_CHART_RESIZE__ = function () { if (trendChart) trendChart.resize(); };
  /* 手机端切到「盈亏趋势」子页时才真正加载 ECharts 并首次绘制 */
  window.__DASH_TREND_SHOW__ = function () { renderTrend(); };

  function trendStart(p, range) {
    var n = p.dates.length;
    /* 2026-11-25：全部持仓都是尚未披露净值的新品时，AGG.dates 为空，
       旧版 parseDate(undefined) 抛错并中断图表回调链。 */
    if (!n) return 0;
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
    if (!window.echarts) {
      /* 手机端趋势子页未显示（宽 0）时只占位；切到该子页时由 __DASH_TREND_SHOW__ 补渲染。
         2026-11-24 y：占位文字用独立子元素，渲染成功后移除，杜绝与 SVG 并存。 */
      if (!el.getBoundingClientRect().width) return;
      if (!el.querySelector('.chart-loading')) {
        el.textContent = '';
        var ph = document.createElement('div');
        ph.className = 'chart-loading';
        ph.textContent = '图表加载中…';
        el.appendChild(ph);
      }
      withEcharts(renderTrend);
      return;
    }
    /* 图库就绪后先移除占位文字，再初始化图表（否则文字节点会压在 SVG 上方） */
    var phOld = el.querySelector('.chart-loading');
    if (phOld && phOld.parentNode) phOld.parentNode.removeChild(phOld);
    if (!trendChart) trendChart = echarts.init(el, null, { renderer: 'svg' });
    if (!AGG || !AGG.dates || !AGG.dates.length) {
      trendChart.clear();
      var emptySub = document.getElementById('trend-sub');
      if (emptySub) emptySub.textContent = (AGG && !AGG.dates.length)
        ? '持仓产品净值尚未披露，暂无趋势数据' : '未选择产品，暂无趋势数据';
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
      /* 左右边距收窄让曲线铺满：手机窄屏原先 left14+right38 吃掉约 81px（占 328px 宽的 1/4）。
         现左收到 6、右收到 30——右侧保留 30px 给末端标注（boxW/2=29）避免被裁，
         标注 placeTrendMarks 另有水平收边兜底。 */
      grid: { left: 6, right: 30, top: 42, bottom: 26, containLabel: true },
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
    /* 2026-11-21 九轮：标注定位改为「稠密曲线采样 + 多方位候选 + 固定优先级」。
       旧版把相邻点连成直线、每段只采样 10 次判碰撞，而趋势线是 smooth 0.45 的曲线，
       最低点两侧曲线会明显拱出直线，于是标注看似压住趋势线；候选顺序固定且全部
       失败时直接回落 top，标注还会在上方/侧面之间来回跳。 */
    var boxW = 58, boxH = 30, gap = 8;
    var pts = [];
    for (var i = 0; i < series.length; i++) {
      if (series[i] === null || series[i] === undefined) continue;
      var pt = trendChart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [dates[i], series[i]]);
      if (pt) pts.push(pt);
    }
    /* 用 Catmull-Rom 稠密采样逼近 ECharts 的平滑曲线（每段 8 个采样点，两端补端点切线） */
    var curve = [];
    if (pts.length === 1) curve.push(pts[0]);
    else if (pts.length > 1) {
      var cpad = [pts[0]].concat(pts, [pts[pts.length - 1]]);
      for (var ci = 1; ci < cpad.length - 2; ci++) {
        var q0 = cpad[ci - 1], q1 = cpad[ci], q2 = cpad[ci + 1], q3 = cpad[ci + 2];
        for (var si = 0; si < 8; si++) {
          var t = si / 8, t2 = t * t, t3 = t2 * t;
          curve.push([
            0.5 * (2 * q1[0] + (-q0[0] + q2[0]) * t + (2 * q0[0] - 5 * q1[0] + 4 * q2[0] - q3[0]) * t2 + (-q0[0] + 3 * q1[0] - 3 * q2[0] + q3[0]) * t3),
            0.5 * (2 * q1[1] + (-q0[1] + q2[1]) * t + (2 * q0[1] - 5 * q1[1] + 4 * q2[1] - q3[1]) * t2 + (-q0[1] + 3 * q1[1] - 3 * q2[1] + q3[1]) * t3)
          ]);
        }
      }
      curve.push(pts[pts.length - 1]);
    }
    var margin = 4; /* 标注框四周再留 4px，曲线擦边也不算「没压住」 */
    function hit(x0, y0, x1, y1) {
      for (var j = 0; j < curve.length; j++) {
        var p = curve[j];
        if (p[0] >= x0 - margin && p[0] <= x1 + margin && p[1] >= y0 - margin && p[1] <= y1 + margin) return true;
      }
      return false;
    }
    function clash(a, b) {
      return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
    }
    /* 候选方位：最低点优先「正下方」（谷底下方天然是空白），最高点优先正上方；
       侧面再分「中 / 上 / 下」三档，给陡峭曲线留出逃生位。 */
    var ORDER_BOTTOM = ['bottom', 'bRight', 'bLeft', 'right', 'left', 'top'];
    var ORDER_TOP = ['top', 'tRight', 'tLeft', 'right', 'left', 'bottom'];
    function boxFor(c, pos) {
      var cx = c[0], cy = c[1], hw = boxW / 2, hh = boxH / 2;
      if (pos === 'top') return [cx - hw, cy - gap - boxH, cx + hw, cy - gap];
      if (pos === 'bottom') return [cx - hw, cy + gap, cx + hw, cy + gap + boxH];
      if (pos === 'right') return [cx + gap, cy - hh, cx + gap + boxW, cy + hh];
      if (pos === 'left') return [cx - gap - boxW, cy - hh, cx - gap, cy + hh];
      if (pos === 'tRight') return [cx + gap, cy - gap - boxH, cx + gap + boxW, cy - gap];
      if (pos === 'tLeft') return [cx - gap - boxW, cy - gap - boxH, cx - gap, cy - gap];
      if (pos === 'bRight') return [cx + gap, cy + gap, cx + gap + boxW, cy + gap + boxH];
      if (pos === 'bLeft') return [cx - gap - boxW, cy + gap, cx - gap, cy + gap + boxH];
      return null;
    }
    function slotOf(pos) {
      if (pos === 'top') return { p: 'top', ox: 0, oy: -gap, va: 'bottom' };
      if (pos === 'bottom') return { p: 'bottom', ox: 0, oy: gap, va: 'top' };
      if (pos === 'right') return { p: 'right', ox: gap, oy: 0, va: 'middle' };
      if (pos === 'left') return { p: 'left', ox: -gap, oy: 0, va: 'middle' };
      var hh = boxH / 2;
      if (pos === 'tRight') return { p: 'right', ox: gap, oy: -(gap + hh), va: 'middle' };
      if (pos === 'tLeft') return { p: 'left', ox: -gap, oy: -(gap + hh), va: 'middle' };
      if (pos === 'bRight') return { p: 'right', ox: gap, oy: gap + hh, va: 'middle' };
      if (pos === 'bLeft') return { p: 'left', ox: -gap, oy: gap + hh, va: 'middle' };
      return { p: 'top', ox: 0, oy: -gap, va: 'bottom' };
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
      /* 偏好由颜色推出：绿=最低点走「正下方」，金/红=最高点与最新点走「正上方」，
         顺序固定 → 同一份数据每次渲染结果完全一致，不会来回跳 */
      var prefs = (mk.itemStyle && mk.itemStyle.color === '#1e8449') ? ORDER_BOTTOM : ORDER_TOP;
      var pick = null, offX = 0, box = null;
      for (var j = 0; j < prefs.length; j++) {
        var b = boxFor(c, prefs[j]).slice(0);
        var dx = 0;
        // 水平兜底收边：标注靠左右边缘时平移回画布内，避免文字溢出被裁切
        if (prefs[j] === 'top' || prefs[j] === 'bottom') {
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
        pick = prefs[j]; offX = dx; box = b;
        break;
      }
      if (!pick) {
        /* 极端情况（点贴着右上角或谷底紧贴横轴）：退回偏好首位并夹进画布，
           不再随机换方位 */
        var fb = boxFor(c, prefs[0]).slice(0);
        if (fb[3] > axisBottom - 2) {
          var shift = fb[3] - (axisBottom - 2);
          fb[1] -= shift; fb[3] -= shift;
        }
        if (fb[2] > width - 2) { var sx = fb[2] - (width - 2); fb[0] -= sx; fb[2] -= sx; }
        if (fb[0] < 2) { var sx2 = 2 - fb[0]; fb[0] += sx2; fb[2] += sx2; }
        pick = prefs[0]; offX = 0; box = fb;
      }
      placed.push(box);
      var sl = slotOf(pick);
      mk.label.position = sl.p;
      mk.label.offset = [sl.ox + offX, sl.oy];
      mk.label.rich.v.verticalAlign = sl.va;
      mk.label.rich.a.verticalAlign = sl.va;
      dashSpecs.push({ date: mk.coord[0], value: mk.coord[1], color: mk.itemStyle.color, pos: pick, box: box });
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
      /* 标注落在点下方（bottom / bRight / bLeft）时，虚线从标注下沿起画，避免穿过标签 */
      var y0 = o.pos.charAt(0) === 'b' ? Math.max(yMin, toVal(o.box[3])) : o.value;
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
  /* 每页 20 条（2026-11-20）：产品库容器 .prod-scroll 已取消 max-height，
     整段展开随页面滚动，容器内部不出现滚动条——每页调大仍不滑动 */
  var PROD_PAGE_SIZE = 20;
  var prodUi = {
    /* 多选筛选：数组为空表示不限；多选时按「命中任一」过滤 */
    sale: [], org: [], risk: [], term: [], incep: [], q: '',
    /* 从持仓/流水产品名跳转过来的唯一产品 id：非空时产品库只显示这一只，
       搜索框里的名字只是回显，不再走「名称包含」匹配（否则建信嘉鑫30天会带出第53期等同系列） */
    onlyPid: '',
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
      .replace(/最短持有|最低持有|持有期|固定收益类|固收类|增强型|增强类|理财产品|理财计划/g, '')
      /* 去风险收益定位词（非产品系列名）：固收稳利/增利稳健/固收增利等，系列名（安盈象/阳光金/稳富等）保留 */
      .replace(/固收稳利|增利稳健|固收增利|固收增强|固收精选|固收添益|固收/g, '')
      .replace(/产品(?=第\d+期|$)/g, '')                 // 去「产品」字样（如 添利产品第2期 → 添利第2期）
      /* 2026-11-21 用户要求：日开型产品名统一缩写
         「建信嘉鑫按日开放式第123期」→「建信嘉鑫日开第123期」（同上千只日开产品同规则） */
      .replace(/按日开放式|按日开放/g, '日开')
      /* 2026-11-21 用户要求：现金管理类产品统一去掉「类产品」
         「建信龙宝现金管理类产品7号」→「建信龙宝现金管理7号」 */
      .replace(/现金管理类产品|现金管理类/g, '现金管理')
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
      if (prodUi.onlyPid && !samePid(p.id, prodUi.onlyPid)) return false;
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
        return '<td class="c st"><b class="m-p10k ' + colorBy(w.per) + '">' + fmtPerCell(w.per, mark) +
          '</b><i class="m-ann ' + colorBy(w.ann) + '">' + fmtAnnCell(w.ann, mark) + '</i></td>';
      }
      /* 成立至今列：上日均万收 / 下成立年化，与 30日列同构；日均由年化按 per=ann/3.65 反算，口径自洽 */
      function sinceCell(m) {
        var per = (typeof m.sinceAnn === 'number') ? m.sinceAnn / 3.65 : null;
        return '<td class="c st"><b class="m-p10k ' + colorBy(per) + '">' + fmtCellDecimal(per) +
          '</b><i class="m-ann ' + colorBy(m.sinceAnn) + '">' + fmtAnnCell(m.sinceAnn) + '</i></td>';
      }

      return '<tr data-pid="' + p.id + '">' +
        /* 星标列 2026-11-21 按用户要求移除，释放的列宽已均分给其余各列（colgroup 6.1%→6.37%） */
        /* 2026-11-26 第五轮（用户：「角标改放首行右侧」）：.ptags 提到名称**之前**渲染 ——
           竖屏靠 float:right 让它只占首行右端（续行名称仍吃满整列），
           平板/桌面靠 flex order 还原「名称 → 链接图标 → 角标」的视觉顺序。 */
        '<td><div class="pname">' +
          '<span class="ptags">' +
          (h ? (h.cleared ?
            '<span class="cleared-date">' +
              /* 2026-11-26：清仓角标按交易 T 日（applyDate），不是确认日；
                 旧数据缺 applyDate 时回退 confirmDate。 */
              (h.tx && (h.tx.applyDate || h.tx.confirmDate)
                ? (h.tx.applyDate || h.tx.confirmDate).slice(5).replace('-', '.') + ' ' : '') + '清仓</span>' :
            '<span class="tag new">持仓</span>') : '') +
          (isNew ? '<span class="tag np">新品</span>' : '') +
          (p.manual ? '<span class="tag" style="background:#f4f7f9;color:#7d939f" title="手工添加的产品">手工</span>' : '') +
          '</span>' +
          (h ?
          '<a class="plink" href="javascript:void(0)" data-goto-trade="' + p.id + '" title="' + (p.name || '') + '">' +
            prodDispName(p) + '</a>' :
          '<span class="pname-t" title="' + (p.name || '') + '">' + prodDispName(p) + '</span>') +
          prodLinkIcon(p) +
          '</div></td>' +
        '<td class="c num">' + (m.latestDate ? withBadge(mmdd(m.latestDate), navLagBadge(p)) : '<span class="muted">待披露</span>') + '</td>' +
        '<td class="r num ' + colorBy(m.todayPer) + '" data-col="p10k">' + fmtCellDecimal(m.todayPer, '', true) + '</td>' +
        winCell(w7) + winCell(w14) + winCell(w30) +
        /* 成立至今 2026-11-20：与 30日列同款双行——上日均万收、下成立年化，同口径自洽（ann≈per×3.65） */
        sinceCell(m) +
        '<td class="c pmeta">' + (riskShort(p) || '<span class="nodash">—</span>') + '</td>' +
        '<td class="c pmeta">' + term + '</td>' +
        '<td class="r num">' + (m.latestNav != null ? fmtNav(m.latestNav) : '<span class="muted">待披露</span>') + '</td>' +
        '<td class="c cdate">' + (m.inception && listingDaysOf(p) !== null ?
          '<span>' + m.inception + '</span><i>' + listingDaysOf(p) + ' 天</i>' :
          '<span class="muted nodash">—</span>') + '</td>' +
        /* 2026-11-26 用户要求：产品库「操作」列删除，详情/删除按钮不再显示（入口改由名称跳转与添加弹窗历史记录承担） */
        '</tr>';
    }).join('');

    tbody.innerHTML = html || '<tr><td colspan="11" class="c muted" style="padding:28px">当前筛选条件下暂无产品</td></tr>';

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
  var incPop = null;          /* 产品库「成立期」年月融合月历弹层 */
  var incPopAnchor = null;

  function closeSelPop() {
    if (selPop && selPop.parentNode) selPop.parentNode.removeChild(selPop);
    if (incPop && incPop.parentNode) incPop.parentNode.removeChild(incPop);
    selPop = null;
    selPopSel = null;
    selPopAnchor = null;
    incPop = null;
    incPopAnchor = null;
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
    /* 紧凑单列弹层（表头筛选）水平居中对齐锚点，多选筛选仍左对齐 */
    var left = selPop.classList.contains('single') ? (r.left + r.width / 2 - pw / 2) : r.left;
    left = Math.max(8, Math.min(left, vw - pw - 8));
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
    /* 成立期月历与同名普通弹层互切：同一锚点再点一次才收起；从月历切普通列表要直接换层 */
    if (selPopSel === sel && selPopAnchor === anchorEl &&
        !(selPop && selPop.classList.contains('inc-pop'))) { closeSelPop(); return; }
    closeSelPop();
    var pop = document.createElement('div');
    /* 2026-11-24 t：年月筛选走同一弹层但用 .ms-pop 收紧行高，避免 iOS 原生整屏列表 */
    pop.className = 'sel-pop' + (opts.single ? ' single' : '') +
      (sel.closest && sel.closest('.month-switch') ? ' ms-pop' : '');
    pop.setAttribute('role', 'listbox');
    var single = !!opts.single;

    function selectAll() {
      Array.prototype.forEach.call(sel.options, function (o, j) { o.selected = (j === 0); });
    }
    /* 勾选态回写：首项＝全部，其余按 select 选中情况；单列弹层直接按 selected 标记 */
    function paint() {
      Array.prototype.forEach.call(pop.querySelectorAll('.sel-opt'), function (row, j) {
        var on = single
          ? !!(sel.options[j] && sel.options[j].selected)
          : ((j === 0) ? selIsAll(sel) : (!!sel.options[j] && sel.options[j].selected && !selIsAll(sel)));
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

    /* 2026-11-26 十轮（用户：「点筛选按钮不跳搜索框、选项多不好筛」）：
       选项 ≥8 个时弹层顶部加搜索框，打开即聚焦 —— 发行机构（12 项）、成立期这类长列表
       可以边打边筛，不用在弹层里逐条找。搜索只做显示过滤，勾选与筛选口径完全不变；
       首项「全部」永远可见，避免筛完后无法一键还原。 */
    var selQ = null;
    if (!single && sel.options.length >= 8) {
      selQ = document.createElement('input');
      selQ.type = 'search';
      selQ.className = 'sel-q';
      selQ.placeholder = '搜索' + (sel.options[0] ? sel.options[0].text : '');
      selQ.setAttribute('aria-label', '搜索筛选选项');
      selQ.setAttribute('autocomplete', 'off');
      selQ.addEventListener('click', function (e) { e.stopPropagation(); });
      selQ.addEventListener('input', function () {
        var kw = selQ.value.trim().toLowerCase();
        Array.prototype.forEach.call(pop.querySelectorAll('.sel-opt'), function (row, j) {
          var hitOk = !kw || j === 0 || row.textContent.toLowerCase().indexOf(kw) !== -1;
          row.style.display = hitOk ? '' : 'none';
        });
        placeSelPop();
      });
      pop.appendChild(selQ);
    }

    Array.prototype.forEach.call(sel.options, function (opt, i) {
      if (single) {
        /* 表头筛选（类型/状态/净值日期/数据）与新品代销机构：单列、点选即生效并收起 */
        var one = document.createElement('button');
        one.type = 'button';
        one.className = 'sel-opt';
        one.setAttribute('role', 'option');
        one.textContent = opt.text;
        one.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          Array.prototype.forEach.call(sel.options, function (o) { o.selected = false; });
          opt.selected = true;
          commit();
          closeSelPop();
        });
        pop.appendChild(one);
        return;
      }
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
    /* 单列弹层宽度由 CSS width:max-content 贴合文字，这里只约束多选筛选的最小宽度 */
    if (!single) pop.style.minWidth = Math.max(r.width, 132) + 'px';
    placeSelPop();
    /* 打开即聚焦搜索框（用户：「点了不跳搜索框」）。必须与点击在同一手势内聚焦，
       iOS 才会把键盘弹出来；preventScroll 防止聚焦时页面被拉走。 */
    if (selQ) {
      try { selQ.focus({ preventScroll: true }); } catch (err) { try { selQ.focus(); } catch (e2) {} }
    }
  }

  /* 产品库「成立期」：年份 + 12 个月融合月历，替代旧的 ZYYY-MM 平铺复选列表。
     底层仍用 #incep-sel 存多选值，保证筛选口径、重置与计数逻辑不变。 */
  function openIncepPop(sel, anchor) {
    var anchorEl = anchor || sel;
    if (incPop && incPopAnchor === anchorEl) { closeSelPop(); return; }
    closeSelPop();

    var vals = [];
    Array.prototype.forEach.call(sel.options, function (o, i) {
      if (i && o.value) vals.push(o.value);
    });
    var years = [];
    vals.forEach(function (v) {
      var y = v.slice(0, 4);
      if (years.indexOf(y) === -1) years.push(y);
    });
    years.sort().reverse();
    if (!years.length) return;

    var selected = selValues(sel);
    var showYear = (selected[0] || vals[0]).slice(0, 4);
    var pop = document.createElement('div');
    pop.className = 'sel-pop inc-pop';
    pop.setAttribute('role', 'listbox');

    var head = document.createElement('div');
    head.className = 'inc-head';
    head.innerHTML = '<span class="inc-title">成立期</span><span class="inc-year-nav">' +
      '<button type="button" class="inc-nav inc-prev" aria-label="上一年">‹</button>' +
      '<span class="inc-year"></span>' +
      '<button type="button" class="inc-nav inc-next" aria-label="下一年">›</button></span>';
    pop.appendChild(head);
    var grid = document.createElement('div');
    grid.className = 'inc-grid';
    pop.appendChild(grid);
    var foot = document.createElement('div');
    foot.className = 'inc-foot';
    foot.innerHTML = '<button type="button" class="inc-all">全部</button><span class="inc-count"></span>';
    pop.appendChild(foot);

    function paint() {
      var yi = years.indexOf(showYear);
      var yEl = pop.querySelector('.inc-year');
      if (yEl) yEl.textContent = showYear + ' 年';
      var prev = pop.querySelector('.inc-prev');
      var next = pop.querySelector('.inc-next');
      if (prev) prev.disabled = yi <= 0;
      if (next) next.disabled = yi >= years.length - 1;
      grid.innerHTML = '';
      for (var m = 1; m <= 12; m++) {
        var key = showYear + '-' + String(m).padStart(2, '0');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'inc-m' + (selected.indexOf(key) !== -1 ? ' on' : '');
        btn.textContent = m + '月';
        btn.dataset.key = key;
        btn.disabled = vals.indexOf(key) === -1;
        btn.title = btn.disabled ? '该月暂无成立产品' : key;
        grid.appendChild(btn);
      }
      var cnt = pop.querySelector('.inc-count');
      if (cnt) cnt.textContent = selected.length ? ('已选 ' + selected.length + ' 期') : '全部成立期';
      var all = pop.querySelector('.inc-all');
      if (all) all.classList.toggle('on', selected.length === 0);
    }
    function commit() {
      selected = selValues(sel);
      paint();
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    pop.addEventListener('click', function (e) {
      var nav = e.target.closest ? e.target.closest('.inc-nav') : null;
      if (nav && !nav.disabled) {
        e.preventDefault();
        e.stopPropagation();
        var i = years.indexOf(showYear) + (nav.classList.contains('inc-next') ? 1 : -1);
        if (i >= 0 && i < years.length) { showYear = years[i]; paint(); }
        return;
      }
      if (e.target.closest && e.target.closest('.inc-all')) {
        e.preventDefault();
        e.stopPropagation();
        Array.prototype.forEach.call(sel.options, function (o, j) { o.selected = (j === 0); });
        commit();
        return;
      }
      var mb = e.target.closest ? e.target.closest('.inc-m') : null;
      if (!mb || mb.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      var key = mb.dataset.key;
      Array.prototype.forEach.call(sel.options, function (o, j) {
        if (j && o.value === key) o.selected = !o.selected;
      });
      sel.options[0].selected = selValues(sel).length === 0;
      commit();
    });

    document.body.appendChild(pop);
    selPop = pop;
    selPopSel = sel;
    selPopAnchor = anchorEl;
    incPop = pop;
    incPopAnchor = anchorEl;
    selPopAt = Date.now();
    paint();
    placeSelPop();
  }

  /* 表头筛选 / 新品代销机构：拦掉原生 select 的系统弹层，改用贴合内容宽度的自绘单列弹层。
     原生 select 在手机上会弹出接近整屏的对话框（2026-11-21 用户反馈占屏太大）。 */
  function attachCompactSelect(sel) {
    if (!sel || !sel.parentNode) return;
    if (sel.parentNode.classList && sel.parentNode.classList.contains('csel-wrap')) return;
    var wrap = document.createElement('span');
    wrap.className = 'csel-wrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    var hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'csel-hit';
    hit.setAttribute('aria-haspopup', 'listbox');
    hit.setAttribute('aria-label', sel.getAttribute('aria-label') || sel.getAttribute('title') || '筛选');
    hit.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openSelPop(sel, wrap, { single: true });
    });
    wrap.appendChild(hit);
  }

  function attachCompactSelects() {
    Array.prototype.forEach.call(document.querySelectorAll('select.th-select'), attachCompactSelect);
    /* 2026-11-24 t：交易流水/盈亏日历的年月框同样改为自绘紧凑弹层。
       保留原 select 只作数值存储，外面包一层 .ms-select-wrap + 透明点击层，
       点整框（含左右箭头之间的值区）都打开 .sel-pop.ms-pop，杜绝 iOS 原生近整屏弹层。 */
    Array.prototype.forEach.call(document.querySelectorAll('.month-switch select'), function (sel) {
      if (!sel.parentNode || sel.parentNode.classList.contains('ms-select-wrap')) return;
      var wrap = document.createElement('span');
      wrap.className = 'ms-select-wrap';
      sel.parentNode.insertBefore(wrap, sel);
      wrap.appendChild(sel);
      var hit = document.createElement('button');
      hit.type = 'button';
      hit.className = 'ms-sel-hit';
      hit.setAttribute('aria-haspopup', 'listbox');
      hit.setAttribute('aria-label', sel.getAttribute('aria-label') || '选择年月');
      hit.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openSelPop(sel, wrap, { single: true });
      });
      wrap.appendChild(hit);
      sel.addEventListener('change', function () {
        syncMonthSelState();
      });
    });
  }

  /* 下拉当前值：由自绘标签居中展示（原生 select 文本无法居中）；多选时显示「已选 N 项」 */
  function syncSelLabel(sel) {
    var wrap = sel && sel.parentNode;
    if (!wrap || !wrap.classList || !wrap.classList.contains('sel-wrap')) return;
    var label = wrap.querySelector('.sel-label');
    if (!label) return;
    /* 2026-11-24：选中非「全部」时给外壳加 on，表头标签才由灰字变蓝字 */
    wrap.classList.toggle('on', !selIsAll(sel));
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
        /* 2026-11-24 u：成立期改年 + 月融合月历，其余筛选仍走通用多选列表 */
        if (sel.id === 'incep-sel') openIncepPop(sel, wrap);
        else openSelPop(sel);
      });
      wrap.appendChild(hit);
      sizeSelWrap(sel);
      sel.addEventListener('change', function () { syncSelLabel(sel); });
      syncSelLabel(sel);
    });

    document.addEventListener('click', function (e) {
      if (!selPop) return;
      if (selPop.contains(e.target)) return;
      if (e.target.closest && (e.target.closest('.sel-wrap') || e.target.closest('.ms-select-wrap'))) return;
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
  var prodSugIdx = -1; /* 默认不高亮任何产品（去掉底色填充），仅键盘上下键导航时出现浅色高亮 */

  function closeProdSug() {
    if (prodSugPop && prodSugPop.parentNode) prodSugPop.parentNode.removeChild(prodSugPop);
    prodSugPop = null;
    prodSugIdx = -1;
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

  /* 弹层跟随输入框定位：滚动/键盘弹出导致视口变化时重新贴靠，不关闭列表。
     2026-11-20：iOS 键盘弹出后 window.innerHeight 不变、visualViewport 缩小并带 offsetTop，
     旧逻辑用 innerHeight 会把整块下拉铺到键盘遮挡区、下方选项看不见也滚不到。改用 visualViewport
     计算真实可视区，并把列表高度限制在「输入框到可视区边缘」之内，超出部分可向下滑动浏览。 */
  function placeProdSug() {
    var input = document.getElementById('prod-search');
    if (!prodSugPop || !input) return;
    /* 2026-11-21 二轮：候选层改为 .filters 内的 absolute 元素，
       坐标直接相对筛选栏计算，不再依赖 window / visualViewport 偏移，
       手机横屏 + 键盘弹起时也不会飘到页面中央。 */
    var host = prodSugPop.parentNode;
    var r = input.getBoundingClientRect();
    var hr = host.getBoundingClientRect();
    var cs = window.getComputedStyle(host);
    var bl = parseFloat(cs.borderLeftWidth) || 0;
    var bt = parseFloat(cs.borderTopWidth) || 0;
    var gap = 6, pad = 8;
    var vv = window.visualViewport;
    var vh = vv ? vv.height : window.innerHeight;
    var vTop = vv ? vv.offsetTop : 0;

    prodSugPop.style.minWidth = Math.max(r.width, 200) + 'px';
    var pw = prodSugPop.offsetWidth;
    var hostW = host.clientWidth;
    /* 左边界对齐输入框，右侧超出筛选栏时整体回收，保持整块在可视范围内 */
    var left = Math.max(0, Math.min(r.left - hr.left - bl, hostW - pw));
    prodSugPop.style.left = Math.round(left) + 'px';

    /* 只在下方空间不足时向上翻转；限高保证列表落在键盘上方，超出的选项内部滑动 */
    var below = vh - (r.bottom - vTop) - gap - pad;
    var above = (r.top - vTop) - gap - pad;
    var useBelow = below >= 140 || above < 140;
    var avail = Math.max(120, Math.min(useBelow ? below : above, 300));
    prodSugPop.style.maxHeight = Math.round(avail) + 'px';
    var ph = prodSugPop.offsetHeight;
    var top = useBelow ? (r.bottom - hr.top - bt + gap) : (r.top - hr.top - bt - ph - gap);
    prodSugPop.style.top = Math.round(top) + 'px';
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
    /* 滑动候选列表时不带动整页（2026-11-21 二轮）：列表自身可滚就让它滚，
       不可滚 / 已滚到边界时阻止默认手势，页面绝不会跟着滑动。 */
    var touchY = 0;
    pop.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) touchY = e.touches[0].clientY;
    }, { passive: true });
    pop.addEventListener('touchmove', function (e) {
      if (e.touches.length !== 1) { e.preventDefault(); return; }
      var dy = e.touches[0].clientY - touchY;
      var st = pop.scrollTop;
      var max = pop.scrollHeight - pop.clientHeight;
      if (max <= 1 || (st <= 0 && dy > 0) || (st >= max - 1 && dy < 0)) e.preventDefault();
    }, { passive: false });
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
        /* 选中后主动收起软键盘：地址气泡/QuickType 工具栏随键盘一起消失 */
        try { input.blur(); } catch (err) {}
        prodUi.q = input.value;
        /* 从候选里点选的是一只具体产品：与持仓联动一致，按 id 唯一过滤 */
        prodUi.onlyPid = canonicalPidById(p.id) || p.id;
        prodUi.page = 1;
        renderProductTable();
      });
      pop.appendChild(b);
    });
    /* 挂到筛选栏内部（.filters 已 position:relative）：候选层跟着筛选栏走，
       不再像 fixed 那样在键盘弹起/页面缩放时脱离输入框飘到屏幕中央 */
    var host = document.querySelector('#pane-prod .filters') || document.body;
    host.appendChild(pop);
    prodSugPop = pop;
    placeProdSug();
  }

  function bindProdSearchSuggest() {
    var input = document.getElementById('prod-search');
    if (!input) return;

    input.addEventListener('input', function () {
      prodSugIdx = -1;
      openProdSug();
    });
    input.addEventListener('focus', function () {
      if (input.value.trim()) { prodSugIdx = -1; openProdSug(); }
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
    /* 2026-11-20：iOS 软键盘弹出/收起只改变 visualViewport，不触发 window.resize；
       监听它才能在键盘顶起时把下拉限高并重定位到键盘上方。 */
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () { if (prodSugPop) placeProdSug(); });
      window.visualViewport.addEventListener('scroll', function () { if (prodSugPop) placeProdSug(); });
    }
  }

  function populateIncepSelect() {
    var sel = document.getElementById('incep-sel');
    if (!sel) return;
    if (incPop) closeSelPop();   /* 选项变更后关闭月历，避免显示过期年月 */
    var months = [];
    MODEL.concat(LIB_MODEL).forEach(function (item) {
      var m = String(item.product.inception || '').slice(0, 7);
      if (m && months.indexOf(m) === -1) months.push(m);
    });
    months.sort().reverse();
    var current = sel.value;
    sel.innerHTML = '<option value="">成立期</option>' + months.map(function (m) {
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

  var prodSearchTimer = null;
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
      /* 用户自己改了搜索框就解除跳转带来的唯一产品锁定，回到正常的名称包含搜索 */
      prodUi.onlyPid = '';
      prodUi.q = search.value;
      prodUi.page = 1;
      /* 2026-11-24：搜索框每次击键原本全量重建产品表，手机上输入明显卡顿；
         候选层仍由 bindProdSearchSuggest() 即时更新，表格延迟 180ms 合并连续击键。 */
      if (prodSearchTimer) clearTimeout(prodSearchTimer);
      prodSearchTimer = setTimeout(function () { prodSearchTimer = null; renderProductTable(); }, 180);
    });

    /* 一键重置：清空搜索、下拉筛选、标签与数据展示模式 */
    var resetBtn = document.getElementById('prod-reset');
    if (resetBtn) resetBtn.addEventListener('click', function () {
      if (search) search.value = '';
      if (prodSearchTimer) { clearTimeout(prodSearchTimer); prodSearchTimer = null; }
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
      prodUi.onlyPid = '';
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
      /* 2026-11-20：打开弹窗即后台预热 OCR 引擎，把引擎加载耗时藏进用户填表时间 */
      if (typeof warmupOcr === 'function') warmupOcr();
    });
  }

  /* ---------------- 添加产品 ---------------- */
  var addState = { image: '', filename: '' };
  /* 最近添加记录点「修改」时记住被编辑的产品 id：保存时用同一 id 覆盖（addProduct 按 key upsert） */
  var addEditId = '';

  /* 本地 OCR：Tesseract.js 引擎与中文语言包随站点一起发布，识别全程在本机浏览器完成，
     不联网、不注册、不需要任何密钥，永久免费。worker/core/lang 均走站点内的相对路径。 */
  var OCR_BASE = './_shared/js/ocr/';
  var ocrWorkerPromise = null;
  var ocrLibPromise = null;
  /* 2026-11-20：进度回调与 worker 解耦——worker 可在打开弹窗时预热（此时无 UI 回调），
     点识别时再挂上回调，recognize 阶段进度照常显示；旧写法把 logger 绑在创建时的 onProgress 上，预热后进度会丢失。 */
  var ocrProgressCb = null;
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
    if (typeof onProgress === 'function') ocrProgressCb = onProgress;
    if (ocrWorkerPromise) return ocrWorkerPromise;
    ocrWorkerPromise = loadOcrLib().then(function () {
      return Tesseract.createWorker('chi_sim', 1, {
        workerPath: OCR_BASE + 'worker.min.js',
        corePath: OCR_BASE,
        langPath: OCR_BASE,
        gzip: true,
        logger: function (m) {
          if (ocrProgressCb && m && m.status && /load|recogniz|initializ/i.test(m.status)) {
            ocrProgressCb(m.status + (typeof m.progress === 'number' ? ' ' + Math.round(m.progress * 100) + '%' : ''));
          }
        }
      });
    }).catch(function (e) {
      ocrWorkerPromise = null;
      throw e;
    });
    return ocrWorkerPromise;
  }
  /* 2026-11-20：打开「添加产品」弹窗即后台预热引擎（下载+编译 3.8MB wasm、1.7MB 中文包）。
     这段耗时在手机上可达数十秒，藏进用户「选图/填表」的时间后，点识别时 worker 已就绪，
     只剩 recognize 本身，体感从约 1 分钟降到几秒。失败静默，不影响后续正式识别重试。 */
  function warmupOcr() {
    if (ocrWorkerPromise) return ocrWorkerPromise;
    return getOcrWorker().catch(function () { return null; });
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
    /* 产品名可能被 App 折成两行（如「信银理财安盈象固收稳利十四天持有期」+「165号理财产品」）。
       打分只会选中含「165号」的后半行，故需要判断相邻行是否产品名续行，选中后拼回全名。 */
    function isNameLine(ln) {
      var s = String(ln || '').replace(/\s+/g, '');
      if (!s || /^\d{1,2}:\d{2}/.test(s) || !/[\u4e00-\u9fa5]/.test(s)) return false;
      if (/^(净值|单位净值|累计净值|日期|净值日期|风险等级|产品代码|登记编码|产品名称|名称|发行机构|产品类型|七日年化|业绩比较基准|参考市值|累计收益|持仓|交易账户|可用份额|最新净值|交易记录|持仓明细|收益分析)/.test(s)) return false;
      if (/代销|登录|取消关注|加购|赎回|非交易时间/.test(s)) return false;
      if (/20\d{2}[-./年]/.test(s) || /[Zz]\d{10}/.test(s) || /[0-9A-Z]{14,22}/.test(s)) return false;
      return /(理财|产品|添利|嘉鑫|安盈|悦享|鸿锦|金鼎|睿|固收|现金管理|持有期)/.test(s) || /(天|号|期|产品)$/.test(s);
    }
    function mergeNameLines(idx) {
      if (idx < 0 || idx >= lines.length) return;
      var parts = [];
      for (var a = idx - 1; a >= Math.max(0, idx - 2); a--) {
        if (a === orgIdx || !isNameLine(lines[a])) break;
        parts.unshift(lines[a].trim());
      }
      parts.push(out.name);
      if (idx + 1 < lines.length && idx + 1 !== orgIdx && isNameLine(lines[idx + 1])) {
        parts.push(lines[idx + 1].trim());
      }
      /* OCR 偶尔上下行顺序颠倒（"165号理财产品"在前），把「数字+号」的尾段固定放回末尾 */
      parts.sort(function (a, b) { return (/^\d+\s*号/.test(a) ? 1 : 0) - (/^\d+\s*号/.test(b) ? 1 : 0); });
      out.name = parts.join('');
    }
    var labeled = -1;
    for (var j = 0; j < lines.length; j++) {
      if (/^(产品名称|名称)\s*[:：]/.test(lines[j])) { labeled = j; break; }
    }
    if (labeled >= 0) {
      out.name = lines[labeled].replace(/^(产品名称|名称)\s*[:：]?\s*/, '').trim();
      mergeNameLines(labeled);
    } else {
      var noise = /^(净值|单位净值|累计净值|日期|净值日期|风险等级|产品代码|登记编码|产品名称|发行机构|产品类型|七日年化|业绩比较基准)/;
      var scored = lines.map(function (ln, idx) {
        var s = 0;
        if (idx === orgIdx) return { ln: ln, s: -99, idx: idx };
        /* 排除手机状态栏时间（"17:59 HS"）、不含任何中文/字母的纯数字符号行。
           注意不能用 /^[\W\d]+$/：非 unicode 模式下中文也落入 \W，会误杀产品名。 */
        if (/^\d{1,2}:\d{2}/.test(ln) || !/[\u4e00-\u9fa5A-Za-z]/.test(ln)) return { ln: ln, s: -99, idx: idx };
        if (/\d+\s*(天|号|期)/.test(ln)) s += 5;
        if (/添利|嘉鑫|安盈|悦享|鸿锦|金鼎|睿|固收|现金管理/.test(ln)) s += 3;
        if (/理财|产品/.test(ln)) s += 1;
        if (noise.test(ln)) s -= 6;
        if (/\d{4}[-./年]/.test(ln) || /1[.。]\d{3}/.test(ln) || /[Zz]\d{10}/.test(ln)) s -= 4;
        if (ln.length >= 6 && ln.length <= 60) s += 1;
        return { ln: ln, s: s, idx: idx };
      }).sort(function (a, b) { return b.s - a.s; });
      if (scored.length && scored[0].s > 0) {
        out.name = scored[0].ln.replace(/^(产品名称|名称)[:：]?\s*/, '').trim();
        mergeNameLines(scored[0].idx);
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
    addEditId = '';
    var titleEl = document.querySelector('#modal-add .modal-head b');
    if (titleEl) titleEl.textContent = '添加产品';
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
    /* 2026-11-20：弹窗打开时已预热引擎，这里直接提示识别中；若仍未就绪，进度回调会补充显示加载状态 */
    aiMsg(ocrWorkerPromise ? '正在本地识别…' : '正在加载本地识别引擎…', 'busy');
    /* 识别超时保护 2026-11-20：手机首次加载中文 wasm 模型较慢，60→150 秒，降低误判；超时后仍可重试或手工填写 */
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      aiMsg('识别耗时较长已停止。请点「一键识别填入」重试，或直接手工填写', 'err');
      if (run) run.disabled = false;
    }, 150000);
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
    /* 2026-11-20：删除记录不单独成行，只在「添加」记录的名称右侧用小字标状态：
       正常在产品库的标绿色「已入库」，已删除的标灰色「已删除」且删除按钮禁用。
       按 at 倒序保证保存后与刷新后顺序一致。 */
    var all = (window.MANUAL_HISTORY || []).slice().sort(function (a, b) {
      return String(b.at || '').localeCompare(String(a.at || ''));
    });
    /* 每个产品 id 的最新动作（all 已按 at 倒序，首条即最新）：del=已删除，add=在产品库 */
    var lastAction = {};
    all.forEach(function (r) {
      var k = r.id || '';
      if (k && lastAction[k] === undefined) lastAction[k] = r.action;
    });
    /* 只展示添加记录、同一产品(id)只留最新一条，避免重复行 */
    var shown = [], seen = {};
    all.forEach(function (r) {
      if (r.action === 'del') return;
      var k = r.id || ('anon-' + (r.at || '') + '-' + (r.name || ''));
      if (seen[k]) return;
      seen[k] = 1;
      shown.push(r);
    });
    shown = shown.slice(0, 15);
    box.hidden = !shown.length;
    list.innerHTML = shown.map(function (r) {
      var id = histEsc(r.id || '');
      var deleted = lastAction[r.id || ''] === 'del';
      return '<li>' +
        '<span class="ah-name" title="' + histEsc(r.name || '') + '">' + histEsc(r.name || '—') +
          (deleted ? '<em class="ah-deleted">已删除</em>' : '<em class="ah-stored">已入库</em>') + '</span>' +
        '<i class="ah-time">' + fmtHistTime(r.at) + '</i>' +
        '<span class="ah-ops">' +
        '<button type="button" class="mini" data-hist-edit="' + id + '" title="带入原记录，保存即重新添加">修改</button>' +
        '<button type="button" class="mini warn" data-hist-del="' + id + '"' +
          (deleted ? ' disabled title="该产品已删除"' : ' title="删除该产品"') + '>删除</button>' +
        '</span></li>';
    }).join('');
  }

  function bindAddModal() {
    var submit = document.getElementById('submit-add');
    if (!submit || submit.dataset.bound) return;
    submit.dataset.bound = '1';
    var busy = false;

    /* 最近添加记录右侧「修改 / 删除」小按钮（2026-11-20）：
       修改＝带原值打开弹窗、保存时同 id 覆盖；删除＝从云端产品库移除该产品 */
    var histList = document.getElementById('add-hist-list');
    if (histList && !histList.dataset.bound) {
      histList.dataset.bound = '1';
      histList.addEventListener('click', function (e) {
        var editBtn = e.target.closest('[data-hist-edit]');
        var delBtn = e.target.closest('[data-hist-del]');
        if (editBtn) {
          var pid = editBtn.getAttribute('data-hist-edit');
          var prod = (window.MANUAL_PRODUCTS || []).filter(function (x) { return x.id === pid; })[0];
          var rec = (window.MANUAL_HISTORY || []).filter(function (x) { return x.id === pid; })[0];
          var src = prod || rec || {};
          resetAddModal();
          addEditId = pid;
          fillAddForm({
            name: src.name, regCode: src.regCode, org: src.org, risk: src.risk,
            nav: src.nav, navDate: src.navDate, link: src.link
          });
          var channelEl = document.getElementById('add-channel');
          if (channelEl && src.saleChannel) channelEl.value = src.saleChannel;
          var titleEl = document.querySelector('#modal-add .modal-head b');
          if (titleEl) titleEl.textContent = '修改产品';
          var modal = document.getElementById('modal-add');
          if (modal) modal.hidden = false;
          aiMsg('已带入原记录，修改后保存即更新', 'ok');
          return;
        }
        if (delBtn) {
          var did = delBtn.getAttribute('data-hist-del');
          var exists = (window.MANUAL_PRODUCTS || []).some(function (x) { return x.id === did; });
          if (!exists) { toast('该产品已不在产品库，可点「修改」重新添加'); return; }
          delBtn.disabled = true;
          window.STORE.removeProduct(did).then(function () {
            mergeManualProducts();
            computeHoldings();
            renderAll();
            renderAddHistory();
            toast('已删除产品');
          }).catch(function (err) {
            delBtn.disabled = false;
            toast((err && err.message) || '删除失败，请重试');
          });
        }
      });
    }

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
        /* 大图（手机截图常 1200×2600）直接喂给本地 OCR 极易在手机上内存溢出/超时。
           2026-11-20：长边 1600→1280px（面积少 36%），纯 CPU wasm 识别耗时明显下降；
           产品详情页字号大，1280px 文字仍清晰、识别率不受影响。 */
        shrinkImage(raw, 1280, function (small) {
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
      /* 修改模式跳过重复编码拦截：产品本来就在库里，保存只是覆盖同一条记录 */
      if (!addEditId && code && tradeProducts().some(function (p) { return p.regCode === code; })) {
        toast('该登记编码已在产品库，无需重复添加');
        return;
      }
      var wasEdit = !!addEditId;
      var item = {
        id: addEditId || (code ? 'M' + code : 'M' + Date.now()),
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
        prodUi.onlyPid = '';
        prodUi.q = '';
        prodUi.page = 1;
        renderAll();
        resetAddModal();
        renderAddHistory();
        document.getElementById('modal-add').hidden = true;
        toast(wasEdit ? '已更新产品' : '已加入产品库');
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
    /* 2026-11-24：候选池 = 产品库去重清单 + 今日新品（新品尚未入库，但可直接录入申购） */
    var pool = allUniqueProducts().concat(tradeNewProducts());
    var items = sortBySearch(pool.filter(function (p) {
      return (p.short || '').toLowerCase().indexOf(kw) !== -1 ||
        (p.name || '').toLowerCase().indexOf(kw) !== -1 ||
        prodDispName(p).toLowerCase().indexOf(kw) !== -1 ||
        (p.regCode || '').toLowerCase().indexOf(kw) !== -1;
    }), kw).slice(0, 6);
    var hid = document.getElementById('trade-prod');
    var cur = hid ? hid.value : '';
    list.innerHTML = items.map(function (p) {
      return '<div class="sr-row' + (p.id === cur ? ' on' : '') + '" data-pid="' + p.id + '" title="' + (p.name || '') + '"><span>' +
        prodDispName(p) + '</span>' + (p.newProduct ? '<em class="np-tag">今日新品</em>' : '') + '</div>';
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
    var confirmDate = confirmDateFor(p, applyDate, '');
    /* 成交净值按申购日（T 日）净值；T 日净值未披露时显示「待确认」，不用最近净值预估。
       确认日期：募集期认购取产品成立日，存续期申购/赎回默认 T+1、说明书约定 T+2 的产品取 T+2
       （见 confirmDateFor / CONFIRM_WORKDAY_OFFSET）。 */
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
      /* 募集期认购的存量记录：确认日按成立日带出，用户点「提交」即落库校正 */
      if (dateEl) dateEl.value = confirmDateFor(curP, edit.applyDate, edit.confirmDate || edit.applyDate || '');
      if (chEl) chEl.value = edit.saleChannel || '建设银行';
    } else {
      syncTradeForm();
      applyTypeLimits();
    }
    /* 成交净值可人工覆盖；确认日期保持只读、仅走日历选择——2026-11-20：
       iOS 上可编辑的日期框点击会弹系统键盘，键盘改变视觉视口后日历被顶到屏幕顶部、
       焦点错跳到确认日期框；改为只读后日历定位稳定，任意日期仍可选（清空后重选）。 */
    if (navEl) navEl.readOnly = false;
    if (dateEl) dateEl.readOnly = true;
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
    if (!dateEl.value && applyEl && applyEl.value) dateEl.value = confirmDateFor(p, applyEl.value, '');
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
    /* 2026-11-20：iOS 弹出系统键盘后 window.innerHeight 不变、但 visualViewport 会缩小并带上
       offsetTop，旧逻辑用 innerHeight 会把日历算出屏幕外/顶到顶部。改用 visualViewport 的真实可视区。 */
    var vv = window.visualViewport;
    var vw = vv ? vv.width : window.innerWidth;
    var vh = vv ? vv.height : window.innerHeight;
    var vOffsetTop = vv ? vv.offsetTop : 0;
    var vOffsetLeft = vv ? vv.offsetLeft : 0;
    /* 输入框相对可视区的位置（getBoundingClientRect 相对布局视口，需减去视觉视口偏移） */
    var irTop = r.top - vOffsetTop;
    var irBottom = r.bottom - vOffsetTop;
    var left = vw <= 560 ? Math.max(8, (vw - w) / 2) : Math.min(Math.max(8, r.left - vOffsetLeft), vw - w - 8);
    var top;
    if (irBottom + 6 + h <= vh - 8) {
      top = r.bottom + 6;                                  /* 下方放得下：贴输入框下沿 */
    } else if (irTop - 6 - h >= 8) {
      top = r.top - h - 6;                                 /* 上方放得下：贴输入框上沿 */
    } else {
      top = vOffsetTop + Math.max(8, (vh - h) / 2);        /* 兜底：可视区垂直居中，绝不飞出屏幕 */
    }
    dpEl.style.left = left + 'px';
    dpEl.style.top = top + 'px';
  }

  function openDp(input) {
    buildDp();
    if (!dpEl.hidden && dpState.input === input) { closeDp(); return; }
    /* 2026-11-20：打开日历前先收起任何正在编辑的输入框的软键盘，
       避免键盘占屏把日历顶飞、或焦点错跳到其它文本框 */
    var ae = document.activeElement;
    if (ae && ae !== input && typeof ae.blur === 'function') ae.blur();
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
    /* 2026-11-20：iOS 软键盘弹出/收起改变的是视觉视口（visualViewport），不触发 window.resize；
       监听它的 resize/scroll 才能实时把日历重新定位回输入框附近，避免被键盘顶飞 */
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () { if (dpEl && !dpEl.hidden) placeDp(); });
      window.visualViewport.addEventListener('scroll', function () { if (dpEl && !dpEl.hidden) placeDp(); });
    }
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
    /* 2026-11-20：清空人工展开状态，回到「最新月展开、其余折叠」的默认规则 */
    flowOpenMonths = {};
    renderFlows();
    renderTradeSummary();
  }

  function openTradeFor(pid) {
    filterFlowByProduct(pid);
    switchTab('trade');
    closePanel();
  }

  /* 2026-11-24：产品页已拆成两个子页（新品预告 / 产品库），跨页跳转需落到产品库子页，
     否则手机端默认停在「新品预告」，筛选后的表格仍是 .subpage-off 隐藏的。复用子页切换按钮的逻辑。 */
  function showProdSubpage(id) {
    var btn = document.querySelector('#jumpbar-prod .j[data-jump="' + id + '"]');
    if (btn) btn.click();
  }

  /* 持仓汇总的产品名 → 产品库：清空筛选，按产品名过滤并滚动到列表 */
  function gotoProduct(pid) {
    var p = findProductById(pid);
    if (!p) return;
    switchTab('prod');
    showProdSubpage('sec-prod-lib');
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
    /* 2026-11-21：回填「产品库展示名」而不是原始 short，避免跳转后搜索框里出现
       一长串原始全名（如「招睿添利日开25号固定收益类」），与表格里的简称对不上 */
    if (search) search.value = prodDispName(p);
    prodUi.q = prodDispName(p);
    /* 唯一值联动：只认 canonical id，不让「建信嘉鑫30天」把第53期等同系列一起筛出来 */
    prodUi.onlyPid = canonicalPidById(p.id) || p.id;
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
        days: h.days, accrualDays: h.accrualDays, accrualStart: h.accrualStart, annShort: h.annShort,
        cleared: h.cleared, tx: h.tx, pending: false
      });
    });
    var pend = {};
    ((window.TRANSACTIONS && window.TRANSACTIONS.items) || []).forEach(function (t) {
      if (t.type !== '申购' || txStatus(t) !== '在途') return;
      var p = findProductById(t.pid);
      if (!p) return;
      var latestNav = p.nav[p.nav.length - 1];
      var nav = Number(t.confirmNav) || navForConfirm(p, t.applyDate || t.confirmDate) || latestNav || 0;
      var sh = Number(t.shares);
      /* 2026-11-25：净值未披露（nav=0）时不能拿占位净值折算份额，
         否则新品会显示 10 万份这种凭空造出的份额；保留 0，表格显示 —。 */
      if (!(sh > 0) && nav > 0) sh = (Number(t.amount) || 0) / nav;
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
      /* 列序 2026-11-21 四轮／八轮（用户要求）：持仓金额紧跟产品名称，产品净值放持仓份额右侧；
         八轮起产品净值**桌面与手机都是独立列**，名称下方不再放净值小字（.nav-under 已停用）；
         2026-11-26 十轮：.ptags 提到名称之前 —— 与产品库一致，角标才能用 float:right
         贴到单元格首行右端（DOM 在名称之后时，float 会被已排好的文字挤到下一行）。 */
      return '<tr>' +
        '<td><div class="pname"><span class="ptags">' +
          (inflight ? '<span class="tag np"' + inflightTip + '>在途</span>' : '') +
          (h.cleared ? '<span class="cleared-date">' +
            /* 2026-11-26：与产品库一致，清仓角标日期取交易 T 日，旧数据回退确认日。 */
            (h.tx && (h.tx.applyDate || h.tx.confirmDate)
              ? (h.tx.applyDate || h.tx.confirmDate).slice(5).replace('-', '.') : '') + ' 清仓</span>' : '') +
          '</span>' +
          '<a class="plink" href="javascript:void(0)" data-goto-prod="' + p.id + '" title="在产品库中查看「' + (p.name || '') + '」">' +
          prodDispName(p) + '</a>' +
          '</div></td>' +
        '<td class="r num mv-col">' + fmtMoneyCell(h.mv) + '</td>' +
        '<td class="c num">' + (h.latestDate ? withBadge(mmdd(h.latestDate), navLagBadge(h.product)) : '—') + '</td>' +
        '<td class="r num ' + colorBy(h.holdProfit) + '" title="持仓收益（仅当前持仓份额）= 市值 − 剩余成本">' + fmtMoneyCell(h.holdProfit, true) + '</td>' +
        '<td class="r num ' + (h.annShort ? 'muted' : colorBy(h.ann)) + '" title="' + annTipOf(h) + '">' +
          fmtAnnCell(h.ann, h.annShort ? '<sup class="dag" title="计息不足 ' + SHORT_ANN_DAYS + ' 天，年化为短样本折算，仅供参考">*</sup>' : '') + '</td>' +
        '<td class="r num ' + colorBy(h.profit) + '" title="累计收益 = 持仓收益 + 已赎回部分已实现">' + fmtMoneyCell(h.profit, true) + '</td>' +
        '<td class="r num shares-col">' + fmtMoneyCell(h.shares) + '</td>' +
        '<td class="r num nav-col">' + fmtNav(h.latestNav) + '</td>' +
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
    /* 持仓汇总筛选提示 2026-11-20：从盈亏汇总点产品名联动过来时显示当前筛选产品与清除按钮（与交易流水同款） */
    var sumFilterEl = document.getElementById('sum-filter');
    var sumNameEl = document.getElementById('sum-filter-name');
    if (sumFilterEl) {
      var sumScopeActive = selectedIds.length < pickableProducts().length;
      if (flowState.pid || sumScopeActive) {
        sumFilterEl.hidden = false;
        var sumParts = [];
        if (sumScopeActive) sumParts.push(selectedIds.length ? '已选 ' + selectedIds.length + ' 款' : '未选择产品');
        if (flowState.pid) sumParts.push(shortOf(flowState.pid));
        if (sumNameEl) sumNameEl.textContent = sumParts.join(' · ');
      } else {
        sumFilterEl.hidden = true;
      }
    }
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

  /* 交易流水「月份」下拉：只列该年份实际有交易的月份（降序），不再写死 1–12 月，
     从而不会出现未来/未发生的月份。year 为空时列所有交易月份。 */
  function flowMonthsForYear(year) {
    var items = (window.TRANSACTIONS && window.TRANSACTIONS.items) || [];
    var set = {};
    items.forEach(function (t) {
      if (year && t.applyDate.slice(0, 4) !== year) return;
      set[+t.applyDate.slice(5, 7) - 1] = 1;
    });
    return Object.keys(set).map(Number).sort(function (a, b) { return b - a; }); /* 降序 */
  }

  /* 重建月份下拉 options（不动 ms.value，由调用方设置），联动年份切换 */
  function refreshFlowMonthOptions(year) {
    var ms = document.getElementById('flow-month');
    if (!ms) return;
    ms.innerHTML = '<option value="">月份</option>' + flowMonthsForYear(year).map(function (i) {
      return '<option value="' + i + '">' + (i + 1) + ' 月</option>';
    }).join('');
  }

  function populateFlowSelects() {
    var items = (window.TRANSACTIONS && window.TRANSACTIONS.items) || [];
    /* 2026-11-20：交易流水默认展示全部月份（年月筛选留空），不再自动定位到最近交易月。
       最近月由渲染层默认展开、其余月份默认折叠，用户可点月份行自行展开。 */
    var ys = document.getElementById('flow-year');
    var ms = document.getElementById('flow-month');
    if (ys) {
      var years = [];
      items.forEach(function (t) {
        var y = t.applyDate.slice(0, 4);
        if (years.indexOf(y) === -1) years.push(y);
      });
      /* 年份降序（最新在前）；底层 flowYearKeys 仍升序供箭头逻辑使用 */
      ys.innerHTML = '<option value="">年份</option>' + years.slice().sort().reverse().map(function (y) {
        return '<option value="' + y + '">' + y + ' 年</option>';
      }).join('');
      ys.value = flowState.year;
    }
    if (ms) {
      refreshFlowMonthOptions(flowState.year);
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
    refreshFlowMonthOptions(flowState.year);
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
    }).sort(function (a, b) {
      /* 交易流水按交易日期倒序（最新在前）；同一天按云端创建时间倒序，
         刚录入的那一笔排在同日最前，再退化为确认日/id 保证顺序稳定。
         2026-11-26：原比较器只按 applyDate，同日顺序沿用云端 confirm_date 升序，
         新增交易会排在同日旧记录后面，看起来像「没有排序」。 */
      var c = String(b.applyDate || '').localeCompare(String(a.applyDate || ''));
      if (c) return c;
      c = String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      if (c) return c;
      c = String(b.confirmDate || '').localeCompare(String(a.confirmDate || ''));
      if (c) return c;
      return String(b.id || '').localeCompare(String(a.id || ''));
    });

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
      /* 2026-11-20：默认只展开最新月份（months 已按降序，首项即最新），其余月份默认折叠。
         用户人工点击过的月份在 flowOpenMonths 留有显式状态，优先尊重该状态。 */
      var open = flowOpenMonths[mk] !== undefined ? flowOpenMonths[mk] : (mk === months[0]);
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
          /* 2026-11-26：类型标签字色/填充色与持仓汇总操作按钮一致（申购↔加购、赎回↔赎回、清仓↔清仓）。
             不复用 .tag.new：该 class 还用于「持仓」角标，改它会误伤别处。 */
          '<td class="c"><span class="tag ttype-' +
            (t.type === '申购' ? 'buy' : t.type === '赎回' ? 'sell' : 'warn') + '">' + t.type + '</span></td>' +
          '<td class="r num">' + fmtMoneyCell(txShares(t, p)) + '</td>' +
          '<td class="r num">' + (st === '在途' ? '<span class="pending-nav">待确认</span>' : fmtNav(txConfirmNav(t, p))) + '</td>' +
          '<td class="r num">' + (txAmount(t, p) === null ? '<span class="pending-nav">待确认</span>' : fmtMoneyCell(txAmount(t, p))) + '</td>' +
          '<td class="c num" title="份额确认日：募集期认购按产品成立日，存续期申购/赎回按产品说明书 T+1 或 T+2 工作日">' + t.confirmDate + '</td>' +
          '<td class="c"><span class="tag' + (st === '在途' ? ' np' : '') + '" title="' +
            (st === '在途' ? '在途：' + txPendingReason(t) + '，暂不计入持仓；净值披露后自动转为已确认' : '已确认并计入持仓') + '">' + st + '</span></td>' +
          /* 2026-11-26：操作按钮与持仓汇总同款填充底色、无描边：修改=蓝字浅蓝底、删除=红字浅红底 */
          '<td class="c"><button class="mini edt" data-edit="' + t.id + '">修改</button> ' +
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
    syncMonthSelState();
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

  /* 年月筛选按钮选中态：选了具体年份/月份 → 蓝字；空值（「年份」「月份」）→ 灰字。
     用 change 事件委托到 document，覆盖交易流水与盈亏日历的全部 .month-switch select，
     箭头切换时程序赋值不会触发 change，故在每次渲染后再调用 sync 一次。 */
  function syncMonthSelState() {
    var sels = document.querySelectorAll('.month-switch select');
    for (var i = 0; i < sels.length; i++) {
      var s = sels[i];
      var on = !!(s.value && s.value !== '');
      s.classList.toggle('on', on);
      /* 2026-11-24 t：select 被 .ms-select-wrap 包住后，用 closest 找到真正的 .month-switch
         外壳加蓝框，避免给内层 wrap 加 on 导致蓝框丢失。 */
      var sw = s.closest ? s.closest('.month-switch') : s.parentElement;
      if (sw) sw.classList.toggle('on', on);
    }
  }

  function bindTrade() {
    document.addEventListener('change', function (e) {
      if (e.target && e.target.matches && e.target.matches('.month-switch select')) syncMonthSelState();
    });
    var ys = document.getElementById('flow-year');
    if (ys) ys.addEventListener('change', function () {
      flowState.year = ys.value;
      flowState.month = '';                    /* 切年后月份回落「全部」，避免沿用旧年月份 */
      refreshFlowMonthOptions(flowState.year);
      var ms = document.getElementById('flow-month');
      if (ms) ms.value = '';
      renderFlows();
    });
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

    function clearTradeFilters() {
      openTradeFor('');
      /* 全局产品筛选也一并恢复全选，否则清掉产品名后流水/汇总仍被顶部筛选挡住 */
      var ids = pickableProducts().map(function (p) { return p.id; });
      if (selectedIds.length !== ids.length) {
        selectedIds = ids.slice();
        applySelection();
      }
    }
    var clear = document.getElementById('clear-filter');
    if (clear) clear.addEventListener('click', clearTradeFilters);
    /* 持仓汇总的清除筛选（从盈亏汇总联动进来时用），与交易流水同逻辑 */
    var clearSum = document.getElementById('clear-sum-filter');
    if (clearSum) clearSum.addEventListener('click', clearTradeFilters);

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
        /* 2026-11-20：按当前实际展开状态取反（折叠月 flowOpenMonths[mk] 可能为 undefined，
           直接用旧写法会永远折叠），写入显式状态后重绘。 */
        flowOpenMonths[mk] = !mh.classList.contains('open');
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
  /* 2026-11-25 复选框只在「单独选择」时打勾：默认全选所有产品，无需用 √ 呈现；
     若已单独选中部分产品，打开面板时把这些 √ 显示出来。
     pickerSel 是面板临时勾选集：打开面板按全局选中集初始化（全选→空、部分→显示已选），
     每次改搜索词重置为空（搜索结果默认不勾选），提交时才替换全局选中集。 */
  var pickerSel = [];
  /* 2026-11-25：本次打开面板是否手动改过勾选。用于区分「打开时带出的已选 √」与
     「用户本次重新勾选」——只有后者/搜索态才让按钮回到「选择」，否则部分选中时为「清除」。 */
  var pickerTouched = false;

  function pickerMatches(p) {
    var q = pickerQuery.trim().toLowerCase();
    if (!q) return true;
    return (p.name || '').toLowerCase().indexOf(q) !== -1 ||
      (p.short || '').toLowerCase().indexOf(q) !== -1 ||
      prodDispName(p).toLowerCase().indexOf(q) !== -1 ||
      (p.regCode || '').toLowerCase().indexOf(q) !== -1;
  }

  /* 2026-11-25 产品面板按名称排序 + 默认不打勾：
     搜索只负责过滤，不改变顺序；复选框只反映面板临时勾选集 pickerSel（初始为空），
     点「选择」或按回车把可见结果（或手动勾选的）替换为全局选中集并收起面板。 */
  function visiblePickerProducts() {
    return pickableProducts().filter(pickerMatches);
  }

  function renderPickerList() {
    var list = document.getElementById('ms-list');
    if (!list) return;
    var items = visiblePickerProducts().sort(function (a, b) {
      return prodDispName(a).localeCompare(prodDispName(b), 'zh-CN');
    });
    if (!items.length) {
      list.innerHTML = '<div class="ms-empty">未找到匹配产品</div>';
      return;
    }
    list.innerHTML = items.map(function (p) {
      var checked = pickerSel.indexOf(p.id) !== -1 ? ' checked' : '';
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
    /* 每次打开先回到完整产品列表、清掉搜索词。
       若当前是「单独选择」的部分产品（非全选），把已选产品的 √ 显示出来；
       默认全选所有产品时无需打勾，临时集保持空。 */
    pickerQuery = '';
    pickerTouched = false;
    var allIds = pickableProducts().map(function (p) { return p.id; });
    var isAll = allIds.length > 0 && allIds.every(function (id) { return selectedIds.indexOf(id) !== -1; });
    pickerSel = isAll ? [] : selectedIds.slice();
    var search = document.getElementById('ms-search');
    if (search) { search.value = ''; search.focus(); }
    renderPickerList();
    if (window.__syncPickerToggle) window.__syncPickerToggle();
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

  /* 2026-11-24：代销机构 + 发行机构双多选（空数组＝全部） */
  var NP_UI = { channels: [], issuers: [] };
  var NP_COLORS = ['#0e5a73', '#2f6f9f', '#8a5a2b', '#3f6f56', '#6b4c8a', '#b5651d'];
  /* 图稿配色：同一发行机构固定同色，不能靠名称哈希（会出现「中银遇棕、交银遇蓝」）。 */
  var NP_ISSUER_COLORS = {
    '贝莱德': '#0e5a73', '中银': '#0e5a73', '中邮': '#0e5a73',
    '工银': '#2f6f9f', '建信': '#2f6f9f',
    '招银': '#8a5a2b', '光大': '#b5651d',
    '交银': '#3f6f56', '兴银': '#3f6f56', '民生': '#3f6f56',
    '信银': '#6b4c8a', '浦银': '#6b4c8a', '平安': '#6b4c8a',
    '农银': '#b5651d', '华夏': '#8a5a2b'
  };

  function ymd(d) {
    var m = d.getMonth() + 1, dd = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (dd < 10 ? '0' + dd : dd);
  }

  function mdText(s) {
    return s ? s.slice(5).replace('-', '.') : '';
  }

  /* 2026-11-22 用户定案：首发额度（≠ 募集规模）公开渠道无字段——说明书只有「发行额度」，
     且同批出现过「【3000】亿元」这类单位笔误，因此一律不显示额度，额度位固定显示「—」。
     将来若接入渠道额度（如建行 App 截图对照表）或发行公告里的实际募集规模，把开关置 true 即可恢复。 */
  var NP_SHOW_QUOTA = false;

  function quotaText(w) {
    if (!NP_SHOW_QUOTA) return '';
    if (w === null || w === undefined || isNaN(w)) return '';
    w = Number(w);
    return w >= 10000 ? (Math.round(w / 100) / 100) + '亿' : w + '万';
  }

  // 统一简称规则：与全站共用 prodDispName（发行机构简称 + 产品系列 + 持有期 + 期数）
  // 代销机构（如建设银行）不参与产品名拼接
  function npShortName(p) {
    /* 2026-11-24：新品卡片简称不显示「人民币」（如「中邮鸿运14天16号人民币」→「中邮鸿运14天16号」）。
       只改新品展示，产品库/持仓全称仍走 prodDispName 原值。 */
    return String(prodDispName(p) || '').replace(/人民币/g, '').trim();
  }

  /* 方案C 辅助：代销机构显示名（空→待核实）、按发行机构取稳定色、多选按钮弹层绑定 */
  function npChannelOf(p) {
    return (p && p.saleChannel && String(p.saleChannel).trim()) ? String(p.saleChannel).trim() : '待核实';
  }
  /* 2026-11-24 发行机构显示名：图稿用两字简称（工银/交银/信银/招银…），
     去掉「理财」「有限责任公司」等后缀；与代销机构按钮区分开，空值归「待核实」兜底。 */
  function npIssuerOf(p) {
    var s = orgShort(p && (p.issuer || p.orgShort));
    s = String(s || '').replace(/理财$/g, '').trim();
    return s || '待核实';
  }
  function npColorOf(name) {
    var s = String(name || '');
    var keys = Object.keys(NP_ISSUER_COLORS).sort(function (a, b) { return b.length - a.length; });
    for (var k = 0; k < keys.length; k++) {
      if (s.indexOf(keys[k]) >= 0) return NP_ISSUER_COLORS[keys[k]];
    }
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return NP_COLORS[h % NP_COLORS.length];
  }
  /* 2026-11-24 用户反馈顶部机构色条过深：保留 --c 用于日期文字，另算 --cl（与原色 45% + 白 55%）
     只给卡片顶边用，同机构配色仍可区分，视觉更轻。非 6 位 hex 直接回退原色。 */
  function npSoftColor(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return hex || '#0e5a73';
    var n = parseInt(m[1], 16);
    var ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return '#' + ch.map(function (v) {
      var s = Math.round(v * 0.45 + 255 * 0.55).toString(16);
      return s.length < 2 ? '0' + s : s;
    }).join('');
  }
  function npBindMultiSel(sel, onChange) {
    if (!sel) return;
    var wrap = sel.parentNode;
    if (!wrap || !wrap.classList || !wrap.classList.contains('sel-wrap')) {
      wrap = document.createElement('span');
      wrap.className = 'sel-wrap';
      sel.parentNode.insertBefore(wrap, sel);
      wrap.appendChild(sel);
    }
    /* 2026-11-24：自绘外壳已写在 HTML 中，这里只补齐缺失部分并幂等绑定，
       避免刷新时先渲染原生多选「选择了0项」再被 JS 替换的闪烁。 */
    var lab = wrap.querySelector('.sel-label');
    if (!lab) {
      lab = document.createElement('span');
      lab.className = 'sel-label';
      wrap.appendChild(lab);
    }
    if (!lab.textContent && sel.options[0]) lab.textContent = sel.options[0].text;
    var hit = wrap.querySelector('.sel-hit');
    if (!hit) {
      hit = document.createElement('button');
      hit.type = 'button';
      hit.className = 'sel-hit';
      hit.setAttribute('aria-haspopup', 'listbox');
      hit.setAttribute('aria-label', sel.getAttribute('aria-label') || '筛选');
      wrap.appendChild(hit);
    }
    if (!hit.__npBound) {
      hit.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        openSelPop(sel, wrap, {});
      });
      hit.__npBound = true;
    }
    if (typeof syncSelLabel === 'function') syncSelLabel(sel);
    sel.onchange = function () { onChange(selValues(sel)); if (typeof syncSelLabel === 'function') syncSelLabel(sel); };
  }

  /* 2026-11-24：筛选变更只切卡片可见性，不重建整条时间轴。
     原实现每次勾选都调用 renderNewProds()，会重算日期、重建全部卡片与两个下拉选项，
     手机上表现为弹层/选中明显卡顿。卡片带 data-org/data-iss，这里按两个维度直接隐藏。 */
  function applyNewProdFilter() {
    var box = document.getElementById('np-lanes');
    if (!box) return;
    var ch = NP_UI.channels || [];
    var iss = NP_UI.issuers || [];
    var total = 0;
    Array.prototype.forEach.call(box.querySelectorAll('.ts-lane'), function (lane) {
      var shown = 0;
      Array.prototype.forEach.call(lane.querySelectorAll('.nchip'), function (chip) {
        var ok = (!ch.length || ch.indexOf(chip.getAttribute('data-org')) >= 0) &&
          (!iss.length || iss.indexOf(chip.getAttribute('data-iss')) >= 0);
        chip.style.display = ok ? '' : 'none';
        if (ok) shown++;
      });
      total += shown;
      /* 2026-11-24 s：筛选后空泳道不再直接隐藏整条（手机端 .is-empty 隐藏整条），
         仅在「整页零匹配」时由下方空态统一提示；有匹配的泳道保留日期标题，避免误判为筛选失效。 */
      var empty = (shown === 0);
      lane.classList.toggle('is-empty', empty);
      var gap = lane.querySelector('.gapfill');
      if (gap) gap.style.display = empty ? '' : 'none';
    });
    var npEmpty = document.getElementById('np-empty');
    if (npEmpty) npEmpty.hidden = total > 0;
  }

  function renderNewProds() {
    var head = document.getElementById('np-head');
    var box = document.getElementById('np-lanes');
    if (!head || !box) return;

    var NP = window.NEW_PRODUCTS || { lanes: [] };
    var _todayKey = ymd(new Date());
    /* 拉平所有产品（附代销机构 + 发行机构）：
       过滤已成立（成立日<=今天不再算新品预告）；
       2026-11-25 起：募集起始日已过去的产品不再呈现——起始日为 24 号的产品，
       到了 25 号（其 T+1）即从新品预告中移除，只保留 raiseStart >= 今天的产品。 */
    var flat = [];
    (NP.lanes || []).forEach(function (l) {
      (l.products || []).forEach(function (p) {
        if (p.establish && p.establish <= _todayKey) return;
        if (p.raiseStart && p.raiseStart < _todayKey) return;
        flat.push({ p: p, channel: npChannelOf(p), issuer: npIssuerOf(p) });
      });
    });
    /* 代销机构选项（去重，待核实排最后） */
    var orgs = [];
    flat.forEach(function (x) { if (orgs.indexOf(x.channel) < 0) orgs.push(x.channel); });
    orgs.sort(function (a, b) {
      if (a === '待核实') return 1;
      if (b === '待核实') return -1;
      return a.localeCompare(b, 'zh');
    });
    /* 发行机构选项（去重，待核实排最后，按中文名排序） */
    var issuers = [];
    flat.forEach(function (x) { if (issuers.indexOf(x.issuer) < 0) issuers.push(x.issuer); });
    issuers.sort(function (a, b) {
      if (a === '待核实') return 1;
      if (b === '待核实') return -1;
      return a.localeCompare(b, 'zh');
    });
    /* 数据刷新后已不存在的选择项清掉 */
    NP_UI.channels = (NP_UI.channels || []).filter(function (c) { return orgs.indexOf(c) >= 0; });
    NP_UI.issuers = (NP_UI.issuers || []).filter(function (c) { return issuers.indexOf(c) >= 0; });

    var winStart = (NP.window && NP.window.start) || DATA.asOf;
    var winEnd = (NP.window && NP.window.end) || winStart;
    var days = [];
    var cur = parseDate(winStart), endTs = parseDate(winEnd).getTime();
    /* 2026-11-27 定稿：预告窗口含今天共 7 个工作日，泳道也只列工作日——
       周六、周日与法定节假日一律不出现在时间轴（复用确认日口径的 isMarketClosed()，
       与 fetch_newproducts.py 的 MARKET_HOLIDAYS 同源）。T 起共 7 个工作日列（末列 12-07）。 */
    while (cur.getTime() <= endTs && days.length < 7) {
      if (!isMarketClosed(cur)) days.push(ymd(cur));
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
    }
    if (!days.length) days.push(winStart);
    var N = days.length;
    var last = N - 1;
    var wd = ['日', '一', '二', '三', '四', '五', '六'];

    /* 表头上方工具栏：代销机构 + 发行机构两个多选（首项＝全部） */
    var orgSel = document.getElementById('np-org-sel');
    if (orgSel) {
      var opts = ['<option value="">代销机构</option>'];
      orgs.forEach(function (org) {
        opts.push('<option value="' + org.replace(/"/g, '&quot;') + '"' +
          (NP_UI.channels.indexOf(org) >= 0 ? ' selected' : '') + '>' + org + '</option>');
      });
      orgSel.innerHTML = opts.join('');
      if (!NP_UI.channels.length && orgSel.options[0]) orgSel.options[0].selected = true;
      npBindMultiSel(orgSel, function (vals) { NP_UI.channels = vals; applyNewProdFilter(); });
    }
    var issuerSel = document.getElementById('np-issuer-sel');
    if (issuerSel) {
      var iOpts = ['<option value="">发行机构</option>'];
      issuers.forEach(function (iss) {
        iOpts.push('<option value="' + iss.replace(/"/g, '&quot;') + '"' +
          (NP_UI.issuers.indexOf(iss) >= 0 ? ' selected' : '') + '>' + iss + '</option>');
      });
      issuerSel.innerHTML = iOpts.join('');
      if (!NP_UI.issuers.length && issuerSel.options[0]) issuerSel.options[0].selected = true;
      npBindMultiSel(issuerSel, function (vals) { NP_UI.issuers = vals; applyNewProdFilter(); });
    }

    /* 表头：纯日期列（与泳道列同宽对齐） */
    head.innerHTML = days.map(function (ds, idx) {
      var dd = parseDate(ds);
      /* 与图稿一致：日期独占一行，第二行今天高亮（其余显示星期） */
      return '<div class="ts-cell' + (idx === 0 ? ' is-today' : '') + '"><b>' + mdText(ds) +
        '</b><span>' + (idx === 0 ? '<em>今天</em>' : '周' + wd[dd.getDay()]) + '</span></div>';
    }).join('');

    /* 方案C：代销机构 AND 发行机构双多选过滤 + 按募集起始日归入对应日期泳道列 */
    var chosen = NP_UI.channels || [];
    var chosenIss = NP_UI.issuers || [];
    var visible = flat.filter(function (x) {
      return (!chosen.length || chosen.indexOf(x.channel) >= 0) &&
             (!chosenIss.length || chosenIss.indexOf(x.issuer) >= 0);
    });

    /* 按日期列分桶：产品归入「首个 >= 募集起始」的日期列；跨日募集在卡片内注明跨度 */
    var buckets = days.map(function () { return []; });
    visible.forEach(function (x) {
      var p = x.p;
      var s = p.raiseStart || p.raiseEnd;
      var e = p.raiseEnd || p.raiseStart;
      if (!s) return;
      var ci = -1;
      days.forEach(function (ds, idx) { if (ci < 0 && ds >= s) ci = idx; });
      if (ci < 0) ci = (e && e < days[0]) ? 0 : last;   // 早于窗口贴首列，晚于窗口贴尾列
      buckets[ci].push(x);
    });

    var out = [];
    days.forEach(function (ds, di) {
      var dd = parseDate(ds);
      /* 起点若落在休市日会被上一步跳过，此时首列不是「今天」，不能硬贴标签 */
      var dayLab = mdText(ds) + ' 周' + wd[dd.getDay()] +
        (di === 0 && ds === winStart ? ' <em>今天</em>' : '');
      var body = '<div class="lane-day">' + dayLab + '</div>';
      var items = buckets[di];
      if (!items.length) {
        body += '<div class="gapfill"><em>无新品</em></div>';
      } else {
        items.forEach(function (x) {
          var p = x.p;
          var q = quotaText(p.quotaWan);
          var rk = (p.risk || '').toUpperCase();
          var color = npColorOf(p.issuer || p.orgShort || p.name);
          var span = p.raiseStart
            ? (mdText(p.raiseStart) + (p.raiseEnd && p.raiseEnd !== p.raiseStart ? '→' + mdText(p.raiseEnd) : ''))
            : '—';
          var tip = [p.name || p.short, p.regCode ? '登记编码 ' + p.regCode : '登记编码未披露',
            '募集 ' + (p.raiseStart ? mdText(p.raiseStart) : '—') + ' 至 ' + (p.raiseEnd ? mdText(p.raiseEnd) : '—'),
            '成立 ' + (p.establish ? mdText(p.establish) : '—'),
            rk ? rk : '风险等级未披露',
            '代销 ' + x.channel,
            q ? '额度 ' + q + ' 元' : '',
            p.source ? '来源 ' + p.source : ''].filter(Boolean).join('｜');
          /* 2026-11-24 卡片改版：三行呈现——名称块（含右对齐风险角标）+ 募集/成立单行。
             发行机构行按用户要求去掉；.nm/.nr/.rk/.na 类名保留供 daily/shot.py 校验。 */
          body += '<div class="nchip" data-org="' + x.channel + '" data-iss="' +
            String(x.issuer || '').replace(/"/g, '&quot;') + '" style="--c:' + color +
            ';--cl:' + npSoftColor(color) + '" title="' + tip.replace(/"/g, '&quot;') + '">' +
            '<div class="nhead">' +
              '<div class="nm">' + npShortName(p) + '</div>' +
              (rk ? '<span class="rk' + (rk === 'R3' ? ' r3' : rk === 'R4' || rk === 'R5' ? ' r4' : '') + '">' + rk + '</span>' : '') +
            '</div>' +
            '<div class="nmeta">' +
              '<span class="kl">募集</span><span class="nr">' + span + '</span>' +
              '<span class="kl kl-e">成立</span><span class="ne">' + (p.establish ? mdText(p.establish) : '—') + '</span>' +
              (q ? '<span class="na">' + q + '</span>' : '') +
            '</div></div>';
        });
      }
      /* 空泳道加 is-empty：手机竖屏直接隐藏整条日期分组，不再显示「11.27 周五」等无新品日期；
         桌面/横屏保留虚线「无新品」占位，列宽与日期表头继续对齐。 */
      out.push('<div class="ts-lane' + (items.length ? '' : ' is-empty') + '" data-org="' +
        (items.length ? items[0].channel : '') + '">' + body + '</div>');
    });

    box.innerHTML = out.join('') || '<div class="ts-lane" style="--c:#0e5a73"><div class="gapfill"><em>暂无已披露新品</em></div></div>';

    /* 2026-11-24 s：每次重绘后同步一次筛选空态，避免数据刷新后筛选态与提示不一致 */
    applyNewProdFilter();

    /* 2026-11-24：按用户要求去掉「X只·X家」统计与「已选X家」提示文字 */
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
  /* 2026-11-20：暴露 OCR 字段解析供本地回归测试（折行产品名拼接） */
  window.__parseOcrFields = parseOcrFields;

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
      /* 勾选只进临时集（默认全选不打勾，手动勾才是「单独选择」），
         点「选择」/回车才提交到全局，不在勾选过程中反复重绘看板。 */
      var idx = pickerSel.indexOf(t.value);
      if (t.checked && idx === -1) {
        pickerSel.push(t.value);
      } else if (!t.checked && idx !== -1) {
        pickerSel.splice(idx, 1);
      }
      pickerTouched = true;
      if (window.__syncPickerToggle) window.__syncPickerToggle();
    });

    /* 点产品名 = 只看这一只（原「仅选」按钮的职责，按钮已取消）。
       复选框默认不打勾、只用于「单独选择」时勾选，点名称仍隔离选中该只并收起面板。 */
    list.addEventListener('click', function (e) {
      var nameEl = e.target && e.target.closest ? e.target.closest('.ms-name') : null;
      if (!nameEl) return;
      var item = nameEl.closest('.ms-item');
      var cb = item ? item.querySelector('input[type="checkbox"]') : null;
      if (!cb) return;
      e.preventDefault();
      e.stopPropagation();
      selectedIds = [cb.value];
      pickerSel = [];
      applySelection();
      renderPickerList();
      updatePickerLabel();
      closePanel();
    });

    /* 2026-11-25 默认不打勾 + 按钮统一「选择」+ 回车提交后收起面板：
       默认全选所有产品（复选框不打勾）；搜「建信」→4 只默认不打勾 → 回车即只看这 4 只并收起面板。 */
    var search = document.getElementById('ms-search');
    if (search) search.addEventListener('input', function () {
      pickerQuery = search.value;
      pickerSel = [];   /* 每次改搜索词重置临时勾选，结果默认不打勾 */
      pickerTouched = false;
      renderPickerList();
      syncPickerToggle();
    });
    if (search) search.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      commitPickerChoice();
    });

    var toggleBtn = panel.querySelector('[data-act="toggle"]');
    /* 2026-11-25：部分选中且未搜索、未重新勾选时按钮改为「清除」——点它清空当前选择、
       恢复默认全选（全部产品）；其余情况仍是「选择」（提交当前搜索/勾选结果）。 */
    function syncPickerToggle() {
      if (!toggleBtn) return;
      var allIds = pickableProducts().map(function (p) { return p.id; });
      var isAll = allIds.length > 0 && allIds.every(function (id) { return selectedIds.indexOf(id) !== -1; });
      var searching = !!(pickerQuery && pickerQuery.trim());
      toggleBtn.textContent = (!searching && !pickerTouched && !isAll && allIds.length > 0) ? '清除' : '选择';
      toggleBtn.title = toggleBtn.textContent === '清除'
        ? '清除当前选择，恢复默认全部产品'
        : '选择当前结果（手动勾过则只选勾中的）';
    }
    window.__syncPickerToggle = syncPickerToggle;
    syncPickerToggle();

    /* 「清除」：撤销部分选择，恢复默认全选全部产品，并收起面板。 */
    function clearPickerChoice() {
      selectedIds = pickableProducts().map(function (p) { return p.id; });
      pickerSel = [];
      pickerTouched = false;
      renderPickerList();
      applySelection();
      updatePickerLabel();
      syncPickerToggle();
      closePanel();
    }

    /* 「选择」/回车只作用于当前可见项：手动勾过就用勾中的，否则全选可见项（默认全选语义）；
       提交后替换全局选中集（=只看这几只），收起面板。 */
    function commitPickerChoice() {
      var ids = visiblePickerProducts().map(function (p) { return p.id; });
      if (!ids.length) return;
      selectedIds = pickerSel.length ? pickerSel.slice() : ids;
      pickerSel = [];
      pickerTouched = false;
      renderPickerList();
      applySelection();
      syncPickerToggle();
      closePanel();
    }
    if (toggleBtn) toggleBtn.addEventListener('click', function () {
      if (toggleBtn.textContent === '清除') clearPickerChoice();
      else commitPickerChoice();
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
  /* ---------------- 手机端页面级表头冻结（浮动表头） ----------------
     手机竖屏把 .tbl-scroll 的内部纵向滚动整个取消（表格整段展开、整页滚动），
     于是 thead 的 position:sticky 只在"容器内"生效、容器不滚就失效。
     这里克隆一份表头挂到视口顶部：表格顶端滚出屏幕且表格仍在视口内时显示，
     宽度与滚动容器对齐，横向随 scrollLeft 同步位移——等同"只冻结表头、底部不冻结"。 */
  var FLOAT_HEADS = [];
  var floatTicking = false;

  /* 手机布局 = 竖屏窄屏 或 矮横屏（手机横屏宽 844~932，光看 max-width 会漏掉） */
  function isPhoneLayout() {
    return window.matchMedia('(max-width:760px)').matches ||
           window.matchMedia('(orientation:landscape) and (max-height:520px)').matches;
  }

  /* 是否需要页面级浮动表头：
     - 手机：所有 .tbl-scroll 都整段展开（max-height:none），一律需要克隆层冻结表头；
     - 桌面：只有标了 .full-scroll 的三个表（盈亏汇总/持仓汇总/产品库）整段展开需要克隆层；
             交易流水仍是内部滚动 + 原生 sticky，不在其列，避免重复表头。 */
  function needFloatHead(wrap) {
    if (isPhoneLayout()) return true;
    return wrap.classList && wrap.classList.contains('full-scroll');
  }

  /* 趋势图 tooltip 用 appendToBody:true 挂在 body 上：手机上划过图表后切页/滚动，
     它不会随图表隐藏，会残留在页面底部（甚至把页面撑出一大片空白）。滚动与切 tab 时主动收起。
     注意：hideTip 只把 opacity/visibility 置 0，元素仍以 absolute+transform 留在 body 里，
     在较矮的页面（交易/产品页约 1600px）会把 documentElement 滚动高度撑到 3000px 以上，
     滑到底部就露出一大片空白（刷新后 tooltip 重建才恢复）。必须 display:none 才真正退出布局。 */
  function hideTrendTip() {
    if (!trendChart) return;
    try { trendChart.dispatchAction({ type: 'hideTip' }); } catch (e) {}
    var chartDom = trendChart.getDom();
    for (var i = 0; i < document.body.children.length; i++) {
      var el = document.body.children[i];
      if (el === chartDom || el.nodeType !== 1 || !el.style) continue;
      if (getComputedStyle(el).position === 'absolute' && /当日收益/.test(el.textContent || '')) {
        el.style.display = 'none';   /* 真正退出布局，不再撑高页面 */
        break;
      }
    }
  }

  function buildFloatHeads() {
    FLOAT_HEADS.forEach(function (h) {
      if (h.box.parentNode) h.box.parentNode.removeChild(h.box);
    });
    FLOAT_HEADS = [];
    var wraps = document.querySelectorAll('.tbl-scroll');
    Array.prototype.forEach.call(wraps, function (wrap) {
      if (!needFloatHead(wrap)) return;
      var table = wrap.querySelector('table');
      if (!table || !table.tHead) return;
      var box = document.createElement('div');
      box.className = 'float-head';
      box.setAttribute('aria-hidden', 'true');
      /* cloneNode(false) 保留 id/class，表头样式才能沿用；克隆体排在 body 末尾，
         getElementById 仍先取到原表，不影响既有逻辑 */
      var clone = table.cloneNode(false);
      var cg = table.querySelector('colgroup');
      if (cg) clone.appendChild(cg.cloneNode(true));
      clone.appendChild(table.tHead.cloneNode(true));
      box.appendChild(clone);
      document.body.appendChild(box);
      FLOAT_HEADS.push({ wrap: wrap, table: table, box: box, clone: clone });
    });
    updateFloatHeads();
  }

  function updateFloatHeads() {
    for (var i = 0; i < FLOAT_HEADS.length; i++) {
      var h = FLOAT_HEADS[i];
      var r = h.wrap.getBoundingClientRect();
      var thH = (h.table.tHead && h.table.tHead.offsetHeight) || 0;
      if (thH && r.top < 0 && r.bottom > thH + 4) {
        if (!h.box.classList.contains('show')) h.box.classList.add('show');
        h.box.style.left = r.left + 'px';
        h.box.style.width = r.width + 'px';
        h.clone.style.width = h.table.offsetWidth + 'px';
        h.clone.style.transform = 'translateX(' + (-h.wrap.scrollLeft) + 'px)';
      } else if (h.box.classList.contains('show')) {
        h.box.classList.remove('show');
      }
    }
  }

  function onFloatScroll() {
    if (floatTicking) return;
    floatTicking = true;
    requestAnimationFrame(function () {
      floatTicking = false;
      updateFloatHeads();
      hideTrendTip();
    });
  }

  function initFloatHeads() {
    buildFloatHeads();
    window.addEventListener('scroll', onFloatScroll, { passive: true });
    Array.prototype.forEach.call(document.querySelectorAll('.tbl-scroll'), function (w) {
      w.addEventListener('scroll', onFloatScroll, { passive: true });
    });
    window.addEventListener('resize', function () { buildFloatHeads(); });
    /* 切换 tab / 切换页面后容器位置变化，滚动事件不一定触发，补一帧重算 */
    document.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.tab')) {
        hideTrendTip();
        setTimeout(updateFloatHeads, 60);
      }
    }, { passive: true });
  }

  function bindTableScrollChain() {
    /* 手机滚动丝滑化（2026-11-20）：
       不再用 touchmove/wheel 里 preventDefault + window.scrollBy 手动交接——那种逐帧手动滚动
       没有惯性、松手即停，正是「滑到表格顶/底卡住」的根因。
       改为完全依赖浏览器原生滚动链：手机端（竖屏+横屏）已取消表格内部纵向滚动，表格整段
       展开、整页滚动，手势不再被吞在表格边界；表头改由 .float-head 克隆层冻结吸顶。
       桌面端仍限高内部滚动，overscroll-behavior-y:auto 让滚到顶/底后由原生交还页面。
       这里只兜底设置滚动链属性，不拦截任何手势。 */
    var els = document.querySelectorAll('.tbl-scroll');
    Array.prototype.forEach.call(els, function (el) {
      el.style.overscrollBehaviorX = 'contain';
      el.style.overscrollBehaviorY = 'auto';
    });
  }

  /* 弹窗打开时锁背景滚动 2026-11-20：覆盖添加产品/新增交易/确认框。
     用 MutationObserver 监听三个 modal 的 hidden 变化，任一打开即锁 body（记 scrollY、fixed+负 top），
     全部关闭再恢复原位——覆盖关闭按钮、点遮罩、提交成功、取消等所有开关路径，无需逐个改调用点。
     纯 overflow:hidden 在 iOS Safari 会滚动穿透，故用 fixed 方案。 */
  function bindModalScrollLock() {
    var ids = ['modal-add', 'modal-trade', 'modal-confirm'];
    var modals = ids.map(function (id) { return document.getElementById(id); }).filter(Boolean);
    if (!modals.length) return;
    var savedY = 0;
    var locked = false;
    function anyOpen() {
      return modals.some(function (m) { return !m.hidden; });
    }
    function sync() {
      var open = anyOpen();
      if (open && !locked) {
        savedY = window.pageYOffset || document.documentElement.scrollTop || 0;
        document.body.style.top = (-savedY) + 'px';
        document.body.classList.add('modal-lock');
        locked = true;
      } else if (!open && locked) {
        /* 取消/关闭弹窗时不要「跳顶再滚回」：html 全局 scroll-behavior:smooth 会让
           scrollTo 从 0 平滑滚回 savedY（实测 ~400ms 动画）。恢复前临时改 auto，
           同帧立即滚回原位，再还原原样式——页面视觉上纹丝不动。 */
        var root = document.documentElement;
        var prevBehavior = root.style.scrollBehavior;
        root.style.scrollBehavior = 'auto';
        document.body.classList.remove('modal-lock');
        document.body.style.top = '';
        locked = false;
        try { window.scrollTo(0, savedY); } catch (e) { window.scrollTo(0, savedY); }
        void root.offsetHeight; /* 强制布局后再还原，确保本次滚动已按 auto 执行 */
        root.style.scrollBehavior = prevBehavior;
      }
    }
    if (window.MutationObserver) {
      modals.forEach(function (m) {
        var mo = new MutationObserver(function () { sync(); });
        mo.observe(m, { attributes: true, attributeFilter: ['hidden'] });
      });
    }
    sync();
  }

  /* 2026-11-20：给弹窗/搜索框补抑制属性，减少 iOS Safari 聚焦时的
     「站点 URL / 拼写建议 / 大写纠错」气泡挡住表单。autocomplete 已在多数框写 off，这里兜底。 */
  function suppressInputCallouts() {
    var els = document.querySelectorAll('input[type="text"],input:not([type]),input[type="search"],input[inputmode="decimal"],input[inputmode="url"],textarea');
    Array.prototype.forEach.call(els, function (el) {
      if (el.type === 'hidden' || el.type === 'file' || el.type === 'checkbox') return;
      el.setAttribute('autocomplete', 'off');
      el.setAttribute('autocorrect', 'off');
      el.setAttribute('autocapitalize', 'off');
      el.setAttribute('spellcheck', 'false');
    });
  }

  function init() {
    suppressInputCallouts();
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
    attachCompactSelects();
    bindProdSearchSuggest();
    bindTrade();
    bindFlowBulk();
    bindTradeModal();
    initDatePicker();
    bindAddModal();
    bindModalScrollLock();
    bindTableScrollChain();
    initFloatHeads();
    renderAll();
    /* 2026-11-24 z：首屏渲染完立即预热精简图库，用户还没滚到趋势页就已缓存/就绪 */
    warmEcharts();
    var identityAudit = auditProductIdentity();
    if (!identityAudit.ok) console.warn('[产品身份自检]', identityAudit.issues);

    var wasCompact = (window.innerWidth || 1200) < 480;
    window.addEventListener('resize', function () {
      if (trendChart) trendChart.resize();
      var nowCompact = (window.innerWidth || 1200) < 480;
      if (nowCompact !== wasCompact) { wasCompact = nowCompact; renderCalendar(); }
    });

    /* 横竖屏切换（2026-11-20 加固）：部分手机旋转后沿用旧布局宽度，只渲染半屏、右侧留白，
       必须刷新才恢复。用多点重排 + 强制 reflow + 图表 resize，确保拿到最新的视口宽度。 */
    var vpMeta = document.querySelector('meta[name="viewport"]');
    var VP_CONTENT = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
    var rotTimer = null;
    function reflowOnRotate() {
      var scrollers = document.querySelectorAll('.tbl-scroll');
      for (var i = 0; i < scrollers.length; i++) scrollers[i].scrollLeft = 0;
      /* 读一次 offsetWidth 强制浏览器按新视口重算布局，避免沿用旋转前的宽度 */
      void document.documentElement.offsetWidth;
      if (trendChart) trendChart.resize();
      renderCalendar();
      /* 旋转后表宽/方向都变了：竖屏重建浮动表头，横屏则清空（横屏保留内部滚动+原生 sticky） */
      buildFloatHeads();
    }
    window.addEventListener('orientationchange', function () {
      clearTimeout(rotTimer);
      /* 旋转事件触发时视口尺寸可能尚未稳定，分多个时间点重排兜底 */
      [0, 120, 350, 700].forEach(function (delay) {
        rotTimer = setTimeout(reflowOnRotate, delay);
      });
      if (vpMeta) {
        vpMeta.setAttribute('content', 'width=device-width, initial-scale=1, minimum-scale=1, viewport-fit=cover');
        setTimeout(function () { vpMeta.setAttribute('content', VP_CONTENT); }, 300);
      }
      /* resize 事件也触发一次重排（有些机型只发 resize 不发 orientationchange） */
      setTimeout(reflowOnRotate, 500);
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
  if (window.__GATE_BYPASS__) {
    window.__DASH_PROD_TEST__ = { gotoProduct: gotoProduct, prodUi: prodUi };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
