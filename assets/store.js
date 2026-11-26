/* 数据层：Supabase 主通道（免费长期有效），不可用时回退页面内置底稿。
 * 交易表 trades；新品表 newproducts（key 唯一，data 为完整产品对象）。
 * 对外接口：STORE.load() / add() / update() / remove() / status()
 */
(function () {
  var SB = window.SUPABASE_CONFIG || {};
  var url = String(SB.url || '').replace(/\/+$/, '');
  var key = SB.key || '';
  var txTable = SB.table || 'trades';
  var npTable = SB.npTable || 'newproducts';
  var online = !!(url && key);
  var source = 'file';
  var CACHE_KEY = 'wealth3.trades.cache';
  var DEL_KEY = 'wealth3.trades.del';
  var refreshing = null;
  var TIMEOUT = 8000;
  /* 写入（新增/修改/删除交易）给足时间：2026-11-26 有用户在弱网下 8 秒超时被 abort，
     表现为点「提交」后只弹「signal is aborted without reason」且交易没进云端。 */
  var WRITE_TIMEOUT = 20000;

  /* 已删除交易墓碑：页面交易底稿在静态文件里，DELETE 云端对底稿行是空操作，
     因此把删除记录存到云端 newproducts 表（key=tradel:ID）+ 本地，刷新后依然生效 */
  var delIds = {};
  try {
    (JSON.parse(window.localStorage.getItem(DEL_KEY) || '[]') || []).forEach(function (id) {
      delIds[id] = 1;
    });
  } catch (e) { /* 隐私模式，忽略 */ }

  function saveDelIds() {
    try {
      window.localStorage.setItem(DEL_KEY, JSON.stringify(Object.keys(delIds)));
    } catch (e) { /* 忽略 */ }
  }

  function dropDeleted(items) {
    return (items || []).filter(function (t) { return !delIds[t.id]; });
  }

  /* 公开底稿已脱敏（只留 id+pid，供后台抓净值用），不含 applyDate 等明细字段。
     这类占位行不能进入前端渲染（会触发 t.applyDate.slice 等错误），在此统一过滤；
     真实交易明细一律来自 Supabase（登录后可读）。 */
  function renderable(items) {
    return dropDeleted(items).filter(function (t) { return !!t.applyDate; });
  }

  /* 页面内置底稿快照：load() 里 applyTrades(cached) 会覆盖 window.TRANSACTIONS，
     必须在覆盖前留存。云端合并只认「底稿 ∪ 云端」，缓存行不参与——
     旧缓存里的已删交易曾借合并并回数据，表现为「删了又冒出来」的幽灵持仓 */
  var DRAFT = ((window.TRANSACTIONS && window.TRANSACTIONS.items) || []).slice();

  function fileItems() {
    return renderable((window.TRANSACTIONS && window.TRANSACTIONS.items) || []);
  }

  function draftItems() {
    return renderable(DRAFT);
  }

  /* 登录态才读写交易缓存：缓存里是登录期从 Supabase 拉到的真实明细，
     退出登录后若继续读取或回填，等于在浏览器本地绕过 RLS。
     公开底稿本身已脱敏（无 applyDate），未登录时只需走底稿，不碰缓存。 */
  function authOK() {
    return !!(window.AUTH && window.AUTH.isLogin && window.AUTH.isLogin());
  }

  function readCache() {
    if (!authOK()) return null;
    try {
      var s = window.localStorage.getItem(CACHE_KEY);
      if (!s) return null;
      var o = JSON.parse(s);
      return (o && o.items && o.items.length) ? o.items : null;
    } catch (e) { return null; }
  }

  function writeCache(items) {
    if (!authOK()) return;
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), items: items }));
    } catch (e) { /* 隐私模式或超配额，忽略 */ }
  }

  /* 超时错误统一成中文文案，别把浏览器的 AbortError 原样弹给用户 */
  function timeoutError() {
    var e = new Error('网络请求超时，请检查网络后重试');
    e.name = 'TimeoutError';
    e.timeout = true;
    return e;
  }

  /* 带超时的 fetch：读取最多 8 秒避免整页卡住；写入最多 20 秒，避免弱网误判失败 */
  function req(u, opt) {
    opt = opt || {};
    var ctrl = typeof window.AbortController === 'function' ? new window.AbortController() : null;
    var ms = opt.timeout || (opt.write ? WRITE_TIMEOUT : TIMEOUT);
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
    var o = { method: opt.method || 'GET', headers: opt.headers || headers(), cache: 'no-store' };
    if (opt.body) o.body = opt.body;
    if (ctrl) o.signal = ctrl.signal;
    return fetch(u, o).then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    }, function (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') throw timeoutError();
      throw e;
    });
  }

  /* 写入专用：超时或网络中断自动重试一次。add() 的 id 在首次请求前已固定，
     重试时同 id 命中主键冲突视为「首笔其实已写入」，不会产生重复交易。 */
  function reqWrite(u, opt) {
    opt = opt || {};
    opt.write = true;
    return req(u, opt).catch(function (e) {
      if (!e || (!e.timeout && e.name !== 'TypeError')) throw e;
      return req(u, opt);
    });
  }

  function applyTrades(items) {
    window.TRANSACTIONS = window.TRANSACTIONS || {};
    window.TRANSACTIONS.items = dropDeleted(items);
  }

  /* ---------------- 代销机构口径 ---------------- */
  /* 统一用简称；代销机构必须是银行，理财公司名（发行机构）一律判为待核实 */
  var BANK_SHORT = {
    '中国建设银行': '建设银行', '中国工商银行': '工商银行', '中国农业银行': '农业银行',
    '中国邮政储蓄银行': '邮储银行', '中国银行': '中国银行', '交通银行': '交通银行',
    '中国民生银行': '民生银行', '中国光大银行': '光大银行', '中国华夏银行': '华夏银行',
    '上海浦东发展银行': '浦发银行', '浦东发展银行': '浦发银行', '中国平安银行': '平安银行',
    '中国兴业银行': '兴业银行', '中国中信银行': '中信银行', '中国招商银行': '招商银行',
    '中国广发银行': '广发银行', '中国渤海银行': '渤海银行', '中国浙商银行': '浙商银行',
    '中国恒丰银行': '恒丰银行', '中国邮政储蓄': '邮储银行'
  };

  function bankShort(name) {
    var s = String(name || '').trim().replace(/(股份有限公司|有限责任公司|有限公司)$/, '').trim();
    if (BANK_SHORT[s]) return BANK_SHORT[s];
    if (/^中国([\u4e00-\u9fa5]{2,4}银行)$/.test(s)) return s.slice(2);
    return s;
  }

  function normChannel(ch, issuer) {
    var c = bankShort(String(ch || '').split(/[；;/,，]/)[0]);
    if (!c || !/银行$/.test(c) || /理财/.test(c)) return '待核实';
    var owner = bankShort(issuer).replace(/理财$/, '');
    if (owner && c === owner) return '待核实';
    return c;
  }

  function clean(row) {
    var o = {};
    for (var k in row) {
      if (k === '_id' || k === '_openid' || k === 'updatedAt' || k === 'created_at') continue;
      o[k] = row[k];
    }
    return o;
  }

  function newId(confirmDate) {
    var d = String(confirmDate || '').replace(/-/g, '') || String(Date.now());
    return 'TX' + d + String(Math.floor(Math.random() * 900) + 100);
  }

  /* 登录态优先：登录后用用户 access_token（RLS 按 auth.uid() 放行），
     未登录仍回退 anon key（RLS 开启前站点照常读写，兼容平滑切换）。 */
  function authToken() {
    try { return (window.AUTH && window.AUTH.token && window.AUTH.token()) || ''; } catch (e) { return ''; }
  }
  function headers(extra) {
    var h = {
      apikey: key,
      Authorization: 'Bearer ' + (authToken() || key),
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  function fail(msg, status) {
    var e = new Error(msg + '（' + status + '）');
    e.status = status;
    return e;
  }

  /* ---------------- 交易 ---------------- */
  function rowToTx(r) {
    return {
      id: r.id,
      pid: r.pid,
      type: r.type,
      applyDate: r.apply_date,
      confirmDate: r.confirm_date,
      amount: Number(r.amount),
      shares: r.shares === null || r.shares === undefined ? undefined : Number(r.shares),
      confirmNav: Number(r.confirm_nav),
      status: r.status || '已确认',
      saleChannel: r.sale_channel || '',
      source: r.source || '人工录入',
      /* 云端创建时间：交易流水同日多笔按「交易时间先后」排序用（PostgREST 默认字段） */
      createdAt: r.created_at || ''
    };
  }

  function txToRow(t) {
    var shares = t.shares;
    if (shares === undefined || shares === null) {
      /* 成交净值待确认时不折算份额，留空等净值披露后再算 */
      var nav = Number(t.confirmNav);
      shares = nav > 0 ? Math.round((Number(t.amount) / nav) * 100) / 100 : null;
    }
    return {
      id: t.id,
      pid: t.pid,
      type: t.type,
      apply_date: t.applyDate,
      confirm_date: t.confirmDate,
      amount: t.amount,
      shares: shares,
      confirm_nav: t.confirmNav,
      status: t.status || '已确认',
      sale_channel: t.saleChannel || '',
      source: t.source || '人工录入'
    };
  }

  function sbTrades() {
    return req(url + '/rest/v1/' + txTable + '?select=*&order=confirm_date.asc,id.asc').then(function (r) {
      if (!r.ok) throw fail('交易读取失败', r.status);
      return r.json();
    }).then(function (rows) { return rows.map(rowToTx); });
  }

  /* 删除墓碑单独拉取：只取 kind=tradel 的行，体积小；即使新品请求超时也能同步删除 */
  function sbTombstones() {
    return req(url + '/rest/v1/' + npTable + '?select=data&' + encodeURIComponent('data->>kind') + '=eq.tradel')
      .then(function (r) {
        if (!r.ok) throw fail('删除记录读取失败', r.status);
        return r.json();
      }).then(function (rows) {
        var n = 0;
        rows.forEach(function (row) {
          var o = clean(row.data || {});
          if (o.kind === 'tradel' && o.id && !delIds[o.id]) { delIds[o.id] = 1; n += 1; }
        });
        if (n) saveDelIds();
      });
  }

  /* ---------------- 新品 ---------------- */
  /* 云端 row 分两路：kind=manual 为手工添加的产品，其余为新品预告 */
  function sbNewProducts() {
    return req(url + '/rest/v1/' + npTable + '?select=data').then(function (r) {
      if (!r.ok) throw fail('新品读取失败', r.status);
      return r.json();
    }).then(function (rows) {
      var all = rows.map(function (r) { return clean(r.data || {}); });
      window.MANUAL_PRODUCTS = all.filter(function (o) { return o.kind === 'manual'; });
      window.MANUAL_HISTORY = all.filter(function (o) { return o.kind === 'manualhist'; })
        .sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
      /* 交易删除墓碑：跨设备、跨刷新生效 */
      var del = all.filter(function (o) { return o.kind === 'tradel' && o.id; });
      if (del.length) {
        del.forEach(function (o) { delIds[o.id] = 1; });
        saveDelIds();
      }
      return all.filter(function (o) {
        return o.kind !== 'manual' && o.kind !== 'manualhist' && o.kind !== 'tradel';
      });
    });
  }

  function npBase() {
    var NP = window.NEW_PRODUCTS || {};
    var out = [];
    (NP.lanes || []).forEach(function (lane) {
      (lane.products || []).forEach(function (p) {
        var o = clean(p);
        if (!o.channel) o.channel = lane.channel;
        out.push(o);
      });
    });
    if (!out.length) {
      (NP.items || []).forEach(function (p) {
        var o = clean(p);
        if (!o.channel) o.channel = o.issuer || '';
        out.push(o);
      });
    }
    out.forEach(function (o) {
      o.channel = normChannel(o.channel || o.saleChannel, o.issuer);
      o.saleChannel = o.channel === '待核实' ? '' : o.channel;
    });
    return out;
  }

  function buildLanes(list) {
    var lanes = [];
    var index = {};
    list.forEach(function (p) {
      var ch = p.channel || p.issuer || '未登记机构';
      if (!index[ch]) {
        index[ch] = { channel: ch, products: [] };
        lanes.push(index[ch]);
      }
      index[ch].products.push(p);
    });
    lanes.forEach(function (l) {
      l.products.sort(function (a, b) {
        return String(a.raiseStart || '').localeCompare(String(b.raiseStart || '')) ||
          String(a.name || '').localeCompare(String(b.name || ''));
      });
    });
    lanes.sort(function (a, b) {
      return String(a.products[0].raiseStart || '').localeCompare(String(b.products[0].raiseStart || ''));
    });
    return lanes;
  }

  function npKey(p) {
    return String(p.regCode || p.name || '').trim();
  }

  function applyNewProducts(rows) {
    if (!rows || !rows.length) return;
    var map = {};
    var order = [];
    npBase().forEach(function (p) {
      var k = npKey(p);
      if (!map[k]) order.push(k);
      map[k] = p;
    });
    rows.forEach(function (p) {
      var o = clean(p);
      /* 手工入库产品、交易删除墓碑不属于「待募集新品」，混进来会重复展示 */
      if (o.kind === 'manual' || o.kind === 'manualhist' || o.kind === 'tradel') return;
      var k = npKey(o);
      o.channel = normChannel(o.channel || o.saleChannel, o.issuer);
      o.saleChannel = o.channel === '待核实' ? '' : o.channel;
      if (map[k]) {
        /* 同一产品以本地官网公告抓取结果为准，云端只补空缺字段 */
        var base = map[k];
        for (var f in o) {
          if (base[f] === undefined || base[f] === null || base[f] === '') base[f] = o[f];
        }
      } else {
        order.push(k);
        map[k] = o;
      }
    });
    var list = order.map(function (k) { return map[k]; });

    /* 同一产品可能同时以「公告抓取」与「手工入库」两条记录出现：按名称去重，优先保留有登记编码的 */
    var byName = {};
    list.forEach(function (p) {
      var n = String(p.name || p.short || '').trim();
      if (!n) return;
      var cur = byName[n];
      if (!cur || (!cur.regCode && p.regCode)) byName[n] = p;
    });
    list = list.filter(function (p) {
      var n = String(p.name || p.short || '').trim();
      return !n || byName[n] === p;
    });

    /* 只展示成立日（或募集结束日）在今天及以后的新品 */
    var now = new Date();
    var today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0');
    list = list.filter(function (p) {
      var e = p.establish || p.raiseEnd;
      return !e || e >= today;
    });

    var starts = [];
    var ends = [];
    list.forEach(function (p) {
      if (p.raiseStart) starts.push(p.raiseStart);
      var e = p.raiseEnd || p.establish;
      if (e) ends.push(e);
    });
    starts.sort();
    ends.sort();

    var NP = window.NEW_PRODUCTS || {};
    var win = NP.window || {};
    var end = ends[ends.length - 1] || '';
    NP.lanes = buildLanes(list);
    NP.items = list;
    NP.window = {
      start: win.start || starts[0] || '',
      end: end > (win.end || '') ? end : (win.end || '')
    };
    NP.source = '云端登记 + 官网公告';
    window.NEW_PRODUCTS = NP;
  }

  /* ---------------- 加载 ---------------- */
  /* 立即返回本地缓存/内置底稿，云端请求放后台；有新数据时通过 STORE_REFRESH 通知页面重绘 */
  function npSignature() {
    var NP = window.NEW_PRODUCTS || {};
    return (NP.items || []).map(function (p) { return (p.name || '') + '|' + (p.channel || ''); }).join(',');
  }

  function manualSignature() {
    var hist = window.MANUAL_HISTORY || [];
    return (window.MANUAL_PRODUCTS || []).map(function (p) { return p.id + '~' + p.nav + '~' + p.navDate; }).join(',') +
      '#' + hist.length + '~' + ((hist[0] && hist[0].at) || '');
  }

  function load() {
    if (!online) {
      window.STORE_REFRESH = Promise.resolve(false);
      return Promise.resolve(fileItems());
    }
    var cached = readCache();
    if (cached) {
      applyTrades(cached);
      source = 'cache';
    }
    function sig() {
      return fileItems().map(function (t) {
        return [t.id, t.type, t.amount, t.shares, t.confirmNav, t.confirmDate].join('~');
      }).sort().join('|');
    }
    var base = sig();
    var baseNp = npSignature();
    var baseManual = manualSignature();
    var baseDel = Object.keys(delIds).length;
    /* 请求是否成功与「云端有没有数据」是两件事：trades 表为空也算连上了 */
    var netOk = false;

    window.STORE_REFRESH = refreshing = Promise.all([
      sbTrades().then(function (txs) {
        netOk = true;
        if (!txs.length) return;
        /* 云端行与页面底稿按 id 合并：底稿里未登记到云端的历史交易不能丢。
           只认底稿（DRAFT），不认当前集——当前集可能来自旧缓存，
           已删交易会借并集复活成幽灵持仓（2026-11-18 修复） */
        var byId = {};
        draftItems().forEach(function (t) { byId[t.id] = t; });
        txs.forEach(function (t) { byId[t.id] = t; });
        var merged = Object.keys(byId).map(function (k) { return byId[k]; });
        applyTrades(merged);
      }).catch(function (e) {
        console.warn(e.message + '，本次使用本地缓存的交易数据');
      }),
      sbTombstones().then(function () { netOk = true; }).catch(function (e) {
        console.warn(e.message + '，本次未同步云端删除记录');
      }),
      sbNewProducts().then(function (items) {
        netOk = true;
        applyNewProducts(items);
      }).catch(function (e) {
        console.warn(e.message + '，本次使用页面内置新品底稿');
      })
    ]).then(function () {
      /* 云端墓碑可能晚于本地缓存到达，重新过滤一次已删除交易 */
      applyTrades(fileItems());
      if (netOk) {
        source = 'supabase';
        writeCache(window.TRANSACTIONS.items);
      }
      return sig() !== base || npSignature() !== baseNp ||
        manualSignature() !== baseManual || Object.keys(delIds).length !== baseDel;
    });
    return Promise.resolve(fileItems());
  }

  function add(tx) {
    var item = {
      id: newId(tx.confirmDate),
      pid: tx.pid,
      type: tx.type,
      applyDate: tx.applyDate,
      confirmDate: tx.confirmDate,
      amount: tx.amount,
      shares: tx.shares,
      confirmNav: tx.confirmNav,
      status: '已确认',
      saleChannel: tx.saleChannel || '',
      source: tx.source || '人工录入',
      createdAt: ''
    };
    if (!online) return Promise.reject(new Error('云端未配置，无法保存'));
    return reqWrite(url + '/rest/v1/' + txTable, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(txToRow(item))
    }).then(function (r) {
      /* 重试时首笔其实已落库：同 id 主键冲突按成功处理，不重复写入 */
      if (r.status === 409) {
        item.createdAt = new Date().toISOString();
        applyTrades(fileItems().concat([item]));
        writeCache(fileItems());
        return { ok: true, message: '已录入云端', item: item };
      }
      if (!r.ok) throw fail('交易保存失败', r.status);
      /* 云端返回的 created_at 带回本地：新交易才能在同日流水里排在最新一笔 */
      return r.json().catch(function () { return null; }).then(function (rows) {
        var row = Array.isArray(rows) ? rows[0] : rows;
        item.createdAt = (row && row.created_at) || new Date().toISOString();
        applyTrades(fileItems().concat([item]));
        writeCache(fileItems());
        return { ok: true, message: '已录入云端', item: item };
      });
    });
  }

  function update(id, tx) {
    if (!online) return Promise.reject(new Error('云端未配置，无法保存'));
    var row = txToRow({
      id: id,
      pid: tx.pid,
      type: tx.type,
      applyDate: tx.applyDate,
      confirmDate: tx.confirmDate,
      amount: tx.amount,
      shares: tx.shares,
      confirmNav: tx.confirmNav,
      saleChannel: tx.saleChannel || '',
      source: tx.source || '人工录入'
    });
    delete row.id;
    return reqWrite(url + '/rest/v1/' + txTable + '?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(row)
    }).then(function (r) {
      if (!r.ok) throw fail('交易修改失败', r.status);
      var old = fileItems().filter(function (t) { return t.id === id; })[0] || {};
      var item = Object.assign({}, tx, { id: id, createdAt: old.createdAt || '' });
      applyTrades(fileItems().map(function (t) { return t.id === id ? item : t; }));
      writeCache(fileItems());
      return { ok: true, message: '已修改云端交易' };
    });
  }

  /* 删除墓碑：写云端（newproducts 表 key=tradel:ID）+ 本地，保证刷新/换设备后依然隐藏 */
  function tombstone(ids) {
    var rows = ids.map(function (id) {
      return { key: 'tradel:' + id, data: { kind: 'tradel', id: id, at: new Date().toISOString() } };
    });
    return reqWrite(url + '/rest/v1/' + npTable + '?on_conflict=key', {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(rows)
    }).catch(function () { /* 云端墓碑失败不阻断：本地已有记录 */ });
  }

  function remove(id) {
    if (!online) return Promise.reject(new Error('云端未配置，无法删除'));
    delIds[id] = 1;
    saveDelIds();
    applyTrades(window.TRANSACTIONS && window.TRANSACTIONS.items || []);
    writeCache(window.TRANSACTIONS.items);
    return Promise.all([
      reqWrite(url + '/rest/v1/' + txTable + '?id=eq.' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: headers({ Prefer: 'return=minimal' })
      }).then(function (r) {
        if (!r.ok) console.warn('交易行删除失败', r.status);
      }).catch(function (e) { console.warn(e.message); }),
      tombstone([id])
    ]).then(function () {
      return { ok: true, message: '已删除交易' };
    });
  }

  /* 批量删除：一次 DELETE 带上全部 id，本地缓存同步剔除 */
  function removeMany(ids) {
    if (!online) return Promise.reject(new Error('云端未配置，无法删除'));
    ids = (ids || []).filter(Boolean);
    if (!ids.length) return Promise.resolve({ ok: true, message: '未选择交易' });
    var drop = {};
    ids.forEach(function (id) { drop[id] = delIds[id] = 1; });
    saveDelIds();
    applyTrades(window.TRANSACTIONS && window.TRANSACTIONS.items || []);
    writeCache(window.TRANSACTIONS.items);
    var list = '(' + ids.map(function (id) {
      return '"' + String(id).replace(/"/g, '') + '"';
    }).join(',') + ')';
    return Promise.all([
      reqWrite(url + '/rest/v1/' + txTable + '?id=in.' + encodeURIComponent(list), {
        method: 'DELETE',
        headers: headers({ Prefer: 'return=minimal' })
      }).then(function (r) {
        if (!r.ok) console.warn('交易行批量删除失败', r.status);
      }).catch(function (e) { console.warn(e.message); }),
      tombstone(ids)
    ]).then(function () {
      return { ok: true, message: '已删除 ' + ids.length + ' 笔交易' };
    });
  }

  /* ---------------- 手工添加的产品 ---------------- */
  /* 复用 newproducts 表，key 用 manual: 前缀区分；data.kind = manual */
  /* 历史记录同样入表，key 用 manualhist: 前缀，data.kind = manualhist */
  function histKey() {
    return 'manualhist:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function logManual(action, p) {
    var rec = {
      kind: 'manualhist',
      action: action,
      at: new Date().toISOString(),
      id: p.id || '',
      name: p.name || '',
      regCode: p.regCode || '',
      org: p.org || '',
      risk: p.risk || '',
      saleChannel: p.saleChannel || '',
      nav: p.nav || null,
      navDate: p.navDate || ''
    };
    window.MANUAL_HISTORY = [rec].concat(window.MANUAL_HISTORY || []).slice(0, 200);
    if (!online) return Promise.resolve(false);
    return reqWrite(url + '/rest/v1/' + npTable + '?on_conflict=key', {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ key: histKey(), data: rec }])
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  function addProduct(p) {
    if (!online) return Promise.reject(new Error('云端未配置，无法保存产品'));
    var data = { kind: 'manual' };
    for (var k in p) data[k] = p[k];
    return reqWrite(url + '/rest/v1/' + npTable + '?on_conflict=key', {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify([{ key: 'manual:' + p.id, data: data }])
    }).then(function (r) {
      if (!r.ok) throw fail('产品保存失败', r.status);
      var list = (window.MANUAL_PRODUCTS || []).filter(function (x) { return x.id !== data.id; });
      list.push(data);
      window.MANUAL_PRODUCTS = list;
      return logManual('add', data).then(function () {
        return { ok: true, message: '已保存到云端产品库', item: data };
      });
    });
  }

  function removeProduct(id) {
    if (!online) return Promise.reject(new Error('云端未配置，无法删除产品'));
    var removed = (window.MANUAL_PRODUCTS || []).filter(function (x) { return x.id === id; })[0] || { id: id };
    return reqWrite(url + '/rest/v1/' + npTable + '?key=eq.' + encodeURIComponent('manual:' + id), {
      method: 'DELETE',
      headers: headers({ Prefer: 'return=minimal' })
    }).then(function (r) {
      if (!r.ok) throw fail('产品删除失败', r.status);
      window.MANUAL_PRODUCTS = (window.MANUAL_PRODUCTS || []).filter(function (x) { return x.id !== id; });
      return logManual('del', removed).then(function () {
        return { ok: true, message: '已删除云端产品' };
      });
    });
  }

  /* 状态：复用后台刷新结果，不再重复发请求 */
  function status() {
    if (!online) return Promise.resolve({ ok: false, source: 'file', message: '仅本地底稿' });
    return (refreshing || Promise.resolve()).then(function () {
      if (source === 'supabase') return { ok: true, source: 'supabase', message: '已连接' };
      if (source === 'cache') return { ok: false, source: 'cache', message: '云端超时，已用本地缓存' };
      return { ok: false, source: 'file', message: '云端不可用，使用内置底稿' };
    }).catch(function () {
      return { ok: false, source: 'file', message: '云端不可用，使用内置底稿' };
    });
  }

  window.STORE = {
    online: online,
    load: load,
    add: add,
    update: update,
    remove: remove,
    removeMany: removeMany,
    addProduct: addProduct,
    removeProduct: removeProduct,
    status: status,
    source: function () { return source; },
    loggedIn: function () { return !!authToken(); }
  };
  window.STORE_READY = load();

  /* 回到页面时静默同步一次：别的设备删/改了交易，本机不用手动刷新 */
  var syncing = false;
  var lastSyncAt = Date.now();
  function syncNow() {
    if (!online || syncing) return;
    if (Date.now() - lastSyncAt < 20000) return;
    syncing = true;
    lastSyncAt = Date.now();
    var p = load();
    var r = window.STORE_REFRESH;
    (r && typeof r.then === 'function' ? r : Promise.resolve(false)).then(function (changed) {
      if (changed && window.DASHBOARD_REFRESH) window.DASHBOARD_REFRESH();
      window.dispatchEvent(new Event('store:synced'));
    }).catch(function () {
    }).then(function () { syncing = false; });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') syncNow();
  });
  window.addEventListener('focus', syncNow);
})();
