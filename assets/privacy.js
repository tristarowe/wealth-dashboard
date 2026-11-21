/* 隐私小眼睛 2026-11-22：睁眼显示所有金额，闭眼把私密金额替换为 *（保留符号/千分位/小数点/单位）。
 * 纯前端展示层开关，不改动数据本身，也不影响 RLS。html2canvas 导出抓取当前 DOM，
 * 因此闭眼状态下导出的图片同样自带 *。
 *
 * 设计要点：
 *  - 只处理"个人资产"金额；公开行情（净值、万收、年化、评分、产品库数值）保持可见。
 *  - 打码只替换文本节点里的数字字符，保留 + - , . 与 <em>元</em> 等子元素，布局不塌。
 *  - 表格 tbody 会整体 innerHTML 重建，用 MutationObserver 在新节点出现后重新套用。
 *  - title 提示里也含金额，一并打码，避免 hover 泄露。
 */
(function () {
  var KEY = 'wealth3.privacy.closed';        // 闭眼状态持久化（ localStorage ）
  var MARK = 'data-pv-orig';                 // 记录原始内容的属性
  var MASKED = 'data-pv-masked';             // 记录上次打码后的内容，用于判断数据是否已更新
  var closed = false;
  try { closed = window.localStorage.getItem(KEY) === '1'; } catch (e) {}

  /* 需要打码的私密金额元素（选择器 -> 打码模式）
     仅个人资产：指标卡金额、持仓金额/收益/份额、今日收益、交易金额/份额、日历/年度/月度收益。
     公开数值（净值 nav-col、万收 today-col/pwin、年化 awin、产品库 prod-table、评分、天数）不打码。 */
  var RULES = [
    // 顶部 6 张指标卡主值（金额，元）
    { sel: '#metric-today,#metric-yest,#metric-month,#metric-profit,#metric-cum,#metric-value', mode: 'html' },
    // 盈亏汇总：名称下的持仓市值、今日收益(元)、持仓收益列
    { sel: '#hold-body .mv-under,#hold-body .income-col,#hold-body tr td:nth-child(5)', mode: 'html' },
    // 持仓汇总：持仓金额、持仓收益、累计收益、份额
    { sel: '#sum-body .mv-col,#sum-body .shares-col,#sum-body tr td:nth-child(4),#sum-body tr td:nth-child(6)', mode: 'html' },
    // 交易流水：月度汇总金额、确认份额、成交金额（第5、7列）
    { sel: '#flow-body .fm-meta,#flow-body tr.flow-detail td:nth-child(5),#flow-body tr.flow-detail td:nth-child(7)', mode: 'html' },
    // 盈亏日历：年度收益、月度收益、当月收益汇总
    { sel: '#year-body td.r.num,#month-list .month-item .v,#cal-summary .lead b', mode: 'html' },
    // 趋势图区间日均收益（DOM 文本）
    { sel: '#trend-sub b', mode: 'text' }
  ];

  /* 把一段文本里的数字替换为 *，保留符号、千分位、小数点、百分号与其他字符。 */
  function maskNumbers(s) {
    return String(s).replace(/[0-9]/g, '*');
  }

  /* 递归遍历元素下的文本节点，把每个文本节点里的数字打码；保留 <em>元</em> 等标签结构。 */
  function maskTextNodes(node) {
    if (node.nodeType === 3) { // TEXT_NODE
      if (node.nodeValue && /\d/.test(node.nodeValue)) node.nodeValue = maskNumbers(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return; // ELEMENT_NODE
    // 不深入 #gate 等无关区域；这里只对传入的金额元素处理
    for (var i = 0; i < node.childNodes.length; i++) maskTextNodes(node.childNodes[i]);
  }

  function applyOne(el, mode) {
    if (!el) return;
    var cur = mode === 'text' ? el.textContent : el.innerHTML;
    if (cur === null || cur === undefined) return;
    var lastMasked = el.getAttribute(MASKED);
    // 已有标记且当前内容仍是上次打码结果 → 已打码，跳过（幂等）
    if (lastMasked !== null && cur === lastMasked) return;
    // 否则视为新数据（首次渲染或异步回填后内容变化）：记录原文，重新打码
    el.setAttribute(MARK, cur);
    var title = el.getAttribute('title');
    if (title) el.setAttribute('data-pv-title', title);
    var maskedHTML = null;
    if (closed) {
      maskTextNodes(el);
      maskedHTML = mode === 'text' ? el.textContent : el.innerHTML;
      el.setAttribute(MASKED, maskedHTML);
      if (title) el.setAttribute('title', maskNumbers(title));
    }
  }

  function restoreOne(el, mode) {
    if (!el || el.getAttribute(MARK) === null) return;
    var orig = el.getAttribute(MARK);
    if (mode === 'text') el.textContent = orig;
    else el.innerHTML = orig;
    el.removeAttribute(MARK);
    el.removeAttribute(MASKED);
    var t = el.getAttribute('data-pv-title');
    if (t !== null) { el.setAttribute('title', t); el.removeAttribute('data-pv-title'); }
  }

  function scan(apply) {
    RULES.forEach(function (r) {
      var nodes = document.querySelectorAll(r.sel);
      for (var i = 0; i < nodes.length; i++) {
        if (apply) applyOne(nodes[i], r.mode);
        else restoreOne(nodes[i], r.mode);
      }
    });
    // 趋势图 SVG 标注里的金额文本（ECharts markPoint label）
    scanChart(apply);
  }

  function scanChart(apply) {
    var chart = document.getElementById('chart');
    if (!chart) return;
    // ECharts SVG 的标注文字在 <text> 里，形如 "+18.91" / "当日收益：+18.91 元"
    var texts = chart.querySelectorAll('text');
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i];
      if (apply) {
        if (t.getAttribute(MARK) === null) {
          var s = t.textContent || '';
          // 只打码看起来像金额的文本：含数字且带 + - . 元 等；年化带 % 的保留
          if (/\d/.test(s) && !/%/.test(s)) {
            t.setAttribute(MARK, s);
            t.textContent = maskNumbers(s);
          }
        }
      } else if (t.getAttribute(MARK) !== null) {
        t.textContent = t.getAttribute(MARK);
        t.removeAttribute(MARK);
      }
    }
  }

  function refresh() {
    // 先恢复全部，再按当前状态套用，确保切换干净（原文永远以 data-pv-orig 为准）
    scan(false);
    if (closed) scan(true);
  }

  /* 表格 tbody 重建后自动重新套用。用防抖合并高频重建。 */
  var timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; if (closed) scan(true); }, 60);
  }
  function watch() {
    if (!window.MutationObserver) return;
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1 && (added[j].querySelector || added[j].matches)) {
            schedule();
            return;
          }
        }
      }
    });
    var roots = ['hold-body', 'sum-body', 'flow-body', 'year-body', 'month-list', 'cal-summary', 'trend-sub', 'chart', 'metrics'];
    // 指标卡(id=metrics)是整块 innerHTML 重渲染，必须监听，否则闭眼刷新后云端异步回填的金额漏打码
    roots.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) obs.observe(el, { childList: true, subtree: true });
    });
    // 容器若尚未出现，延迟再挂
    setTimeout(function () {
      roots.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) obs.observe(el, { childList: true, subtree: true });
      });
    }, 1500);
  }

  function setClosed(v) {
    closed = !!v;
    try { window.localStorage.setItem(KEY, closed ? '1' : '0'); } catch (e) {}
    applyButton();
    refresh();
  }

  var btn = null;
  var EYE_OPEN = '<svg viewBox="0 0 20 16" width="18" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M1.6 8S4.7 3 10 3s8.4 5 8.4 5-3.1 5-8.4 5S1.6 8 1.6 8Z"></path><circle cx="10" cy="8" r="2.3"></circle></svg>';
  var EYE_SHUT = '<svg viewBox="0 0 20 16" width="18" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2 4.2C1 5.6 1.6 8 1.6 8S4.7 13 10 13c1.5 0 2.8-.4 3.9-1"></path>' +
    '<path d="M6.2 3.4A8.6 8.6 0 0 1 10 3c5.3 0 8.4 5 8.4 5s-.9 1.4-2.5 2.7"></path>' +
    '<path d="M3.2 3.2 16.8 12.8"></path></svg>';

  function applyButton() {
    if (!btn) return;
    btn.innerHTML = closed ? EYE_SHUT : EYE_OPEN;
    btn.classList.toggle('on', closed);
    btn.setAttribute('aria-label', closed ? '显示所有金额' : '隐藏所有金额');
    btn.title = closed ? '当前：金额已隐藏（点此显示）' : '当前：金额可见（点此隐藏）';
  }

  function mount() {
    btn = document.getElementById('privacy-eye');
    if (!btn) return;
    btn.addEventListener('click', function () { setClosed(!closed); });
    applyButton();
    watch();
    // 首次渲染可能晚于本脚本，延迟套用一次 + 在全局刷新后套用
    setTimeout(function () { refresh(); }, 300);
    setTimeout(function () { refresh(); }, 1200);
    var origRefresh = window.DASHBOARD_REFRESH;
    if (typeof origRefresh === 'function') {
      window.DASHBOARD_REFRESH = function () {
        var r = origRefresh.apply(this, arguments);
        setTimeout(function () { if (closed) scan(true); }, 200);
        return r;
      };
    }
  }

  /* 在 html2canvas 的克隆文档里打码：导出抓的是克隆 DOM，这里打码能保证导出图自带 *，
     且不影响真实页面。ECharts 在导出 resize 后重绘过 SVG，克隆里的标注是全新的，需要重新遮。 */
  function maskClone(doc) {
    if (!closed) return;
    var root = doc;
    RULES.forEach(function (r) {
      var nodes = root.querySelectorAll(r.sel);
      for (var i = 0; i < nodes.length; i++) maskTextNodes(nodes[i]);
      // title 也遮
      for (var k = 0; k < nodes.length; k++) {
        var tt = nodes[k].getAttribute && nodes[k].getAttribute('title');
        if (tt) nodes[k].setAttribute('title', maskNumbers(tt));
      }
    });
    var chart = root.getElementById('chart');
    if (chart) {
      var texts = chart.querySelectorAll('text');
      for (var j = 0; j < texts.length; j++) {
        var s = texts[j].textContent || '';
        if (/\d/.test(s) && !/%/.test(s)) texts[j].textContent = maskNumbers(s);
      }
    }
  }

  // 对外接口：导出前可调用 window.PRIVACY.ensure() 确保打码已套用
  window.PRIVACY = {
    isClosed: function () { return closed; },
    set: setClosed,
    ensure: function () { if (closed) scan(true); },
    maskClone: maskClone
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
