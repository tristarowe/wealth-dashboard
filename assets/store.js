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

  function fileItems() {
    return (window.TRANSACTIONS && window.TRANSACTIONS.items) || [];
  }

  function applyTrades(items) {
    window.TRANSACTIONS = window.TRANSACTIONS || {};
    window.TRANSACTIONS.items = items;
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

  function headers(extra) {
    var h = {
      apikey: key,
      Authorization: 'Bearer ' + key,
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
      source: r.source || '人工录入'
    };
  }

  function txToRow(t) {
    var shares = (t.shares === undefined || t.shares === null)
      ? Math.round((Number(t.amount) / Number(t.confirmNav)) * 100) / 100
      : t.shares;
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
    return fetch(url + '/rest/v1/' + txTable + '?select=*&order=confirm_date.asc,id.asc', {
      headers: headers(),
      cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) throw fail('交易读取失败', r.status);
      return r.json();
    }).then(function (rows) { return rows.map(rowToTx); });
  }

  /* ---------------- 新品 ---------------- */
  function sbNewProducts() {
    return fetch(url + '/rest/v1/' + npTable + '?select=data', {
      headers: headers(),
      cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) throw fail('新品读取失败', r.status);
      return r.json();
    }).then(function (rows) {
      return rows.map(function (r) { return clean(r.data || {}); });
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
  function load() {
    if (!online) return Promise.resolve(fileItems());

    return Promise.all([
      sbTrades().then(function (txs) {
        if (txs.length) {
          applyTrades(txs);
          source = 'supabase';
        }
      }).catch(function (e) {
        console.warn(e.message + '，本次使用页面内置交易底稿');
      }),
      sbNewProducts().then(applyNewProducts).catch(function (e) {
        console.warn(e.message + '，本次使用页面内置新品底稿');
      })
    ]).then(function () {
      return fileItems();
    });
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
      source: tx.source || '人工录入'
    };
    if (!online) return Promise.reject(new Error('云端未配置，无法保存'));
    return fetch(url + '/rest/v1/' + txTable, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(txToRow(item))
    }).then(function (r) {
      if (!r.ok) throw fail('交易保存失败', r.status);
      applyTrades(fileItems().concat([item]));
      return { ok: true, message: '已录入云端', item: item };
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
    return fetch(url + '/rest/v1/' + txTable + '?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(row)
    }).then(function (r) {
      if (!r.ok) throw fail('交易修改失败', r.status);
      var item = Object.assign({}, tx, { id: id });
      applyTrades(fileItems().map(function (t) { return t.id === id ? item : t; }));
      return { ok: true, message: '已修改云端交易' };
    });
  }

  function remove(id) {
    if (!online) return Promise.reject(new Error('云端未配置，无法删除'));
    return fetch(url + '/rest/v1/' + txTable + '?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: headers({ Prefer: 'return=minimal' })
    }).then(function (r) {
      if (!r.ok) throw fail('交易删除失败', r.status);
      applyTrades(fileItems().filter(function (t) { return t.id !== id; }));
      return { ok: true, message: '已删除云端交易' };
    });
  }

  function status() {
    if (!online) return Promise.resolve({ ok: false, source: 'file', message: '仅本地底稿' });
    return sbTrades().then(function () {
      source = 'supabase';
      return { ok: true, source: 'supabase', message: 'Supabase 已连接' };
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
    status: status,
    source: function () { return source; }
  };
  window.STORE_READY = load();
})();
