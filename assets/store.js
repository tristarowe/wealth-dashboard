/* 数据层：交易与新品全部走腾讯云 CloudBase 云函数接口（/wapi）。
 * 读取匿名、无需口令；写入需要口令，口令只保存在 sessionStorage（关掉标签页即失效）。
 * 对外接口：STORE.load() / add() / update() / remove() / askToken() / token() / verify()
 */
(function () {
  var CFG = window.CLOUD_CONFIG || {};
  var API = String(CFG.api || '').replace(/\/+$/, '');
  var TOKEN_KEY = 'wealth3.cloud.token';
  var online = !!API;

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function setToken(t) {
    try {
      if (t) sessionStorage.setItem(TOKEN_KEY, t);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  function askToken() {
    var t = window.prompt('请输入云端登记口令（仅本次浏览有效，关闭页面后需重新输入）', '');
    if (t === null) return '';
    t = String(t).trim();
    setToken(t);
    return t;
  }

  function fileItems() {
    return (window.TRANSACTIONS && window.TRANSACTIONS.items) || [];
  }

  function applyTrades(items) {
    window.TRANSACTIONS = window.TRANSACTIONS || {};
    window.TRANSACTIONS.items = items;
  }

  function clean(row) {
    var o = {};
    for (var k in row) {
      if (k === '_id' || k === '_openid' || k === 'updatedAt') continue;
      o[k] = row[k];
    }
    return o;
  }

  function newId(confirmDate) {
    var d = String(confirmDate || '').replace(/-/g, '') || String(Date.now());
    return 'TX' + d + String(Math.floor(Math.random() * 900) + 100);
  }

  function req(payload) {
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.code !== 0) {
        if (j && j.code === 401) setToken('');
        throw new Error((j && j.msg) || '云端写入失败');
      }
      return j.data;
    });
  }

  function write(payload) {
    if (!online) return Promise.reject(new Error('未配置云端接口'));
    var t = getToken() || askToken();
    if (!t) return Promise.reject(new Error('已取消口令输入'));
    payload.token = t;
    return req(payload);
  }

  /* ---------- 新品：云端条目与页面底稿按登记编码合并，云端优先 ---------- */
  function npKey(p) {
    return String(p.regCode || p.name || '').trim();
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
      if (!map[k]) order.push(k);
      map[k] = o;
    });
    var list = order.map(function (k) { return map[k]; });
    /* 与增量口径一致：只展示成立日（或募集结束日）在今天及以后的新品 */
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
    NP.lanes = buildLanes(list);
    NP.items = list;
    NP.window = {
      start: win.start || starts[0] || '',
      end: ends[ends.length - 1] && ends[ends.length - 1] > (win.end || '')
        ? ends[ends.length - 1] : (win.end || '')
    };
    NP.source = '云端登记 + 官网公告';
    window.NEW_PRODUCTS = NP;
  }

  function load() {
    if (!online) return Promise.resolve(fileItems());
    return fetch(API + '?action=list', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('读取云端数据失败（' + r.status + '）');
        return r.json();
      })
      .then(function (j) {
        if (!j || j.code !== 0) throw new Error((j && j.msg) || '读取云端数据失败');
        var data = j.data || {};
        var txs = (data.transactions || []).map(clean);
        if (txs.length) applyTrades(txs);
        applyNewProducts((data.newproducts || []).map(clean));
        return fileItems();
      })
      .catch(function (e) {
        console.warn(e.message + '，本次使用页面内置底稿');
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
    return write({ action: 'saveTx', item: item }).then(function () {
      var list = fileItems().slice();
      list.push(item);
      applyTrades(list);
      return { ok: true, message: '已录入云端', item: item };
    });
  }

  function update(id, tx) {
    var item = {
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
    };
    return write({ action: 'saveTx', item: item }).then(function () {
      var list = fileItems().map(function (t) {
        return t.id === id ? Object.assign({}, t, item) : t;
      });
      applyTrades(list);
      return { ok: true, message: '已修改云端交易' };
    });
  }

  function remove(id) {
    return write({ action: 'delTx', id: id }).then(function () {
      applyTrades(fileItems().filter(function (t) { return t.id !== id; }));
      return { ok: true, message: '已删除云端交易' };
    });
  }

  function verify() {
    if (!online) return Promise.reject(new Error('未配置云端接口'));
    var t = getToken() || askToken();
    if (!t) return Promise.reject(new Error('已取消口令输入'));
    return req({ action: 'delTx', token: t, id: '__verify__' }).then(function () {
      return { ok: true, message: '云端已连接' };
    });
  }

  window.STORE = {
    online: online,
    load: load,
    add: add,
    update: update,
    remove: remove,
    verify: verify,
    askToken: askToken,
    token: getToken,
    reset: function () { setToken(''); }
  };
  window.STORE_READY = load();
})();
