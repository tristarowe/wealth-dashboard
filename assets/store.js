/* 数据层：双通道
 * 主通道 Supabase（免费长期有效，读写不需要口令）
 * 备通道 CloudBase 云函数 /wapi（写入需要口令，口令仅存本次浏览会话）
 * 两者都不可用时回退页面内置底稿。
 * 对外接口：STORE.load() / add() / update() / remove() / status() / askToken() / verify()
 */
(function () {
  var SB = window.SUPABASE_CONFIG || {};
  var CB = window.CLOUD_CONFIG || {};
  var sbUrl = String(SB.url || '').replace(/\/+$/, '');
  var sbKey = SB.key || '';
  var sbTable = SB.table || 'trades';
  var cbApi = String(CB.api || '').replace(/\/+$/, '');
  var sbOnline = !!(sbUrl && sbKey);
  var cbOnline = !!cbApi;
  var TOKEN_KEY = 'wealth3.cloud.token';
  var source = 'file';

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
    var t = window.prompt('请输入备用通道口令（仅本次浏览有效）', '');
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
      if (k === '_id' || k === '_openid' || k === 'updatedAt' || k === 'created_at') continue;
      o[k] = row[k];
    }
    return o;
  }

  function newId(confirmDate) {
    var d = String(confirmDate || '').replace(/-/g, '') || String(Date.now());
    return 'TX' + d + String(Math.floor(Math.random() * 900) + 100);
  }

  /* ---------------- Supabase（主） ---------------- */
  function sbHeaders(extra) {
    var h = {
      apikey: sbKey,
      Authorization: 'Bearer ' + sbKey,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

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

  function sbList() {
    return fetch(sbUrl + '/rest/v1/' + sbTable + '?select=*&order=confirm_date.asc,id.asc', {
      headers: sbHeaders(),
      cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) throw new Error('Supabase 读取失败（' + r.status + '）');
      return r.json();
    }).then(function (rows) {
      return rows.map(rowToTx);
    });
  }

  function sbAdd(item) {
    return fetch(sbUrl + '/rest/v1/' + sbTable, {
      method: 'POST',
      headers: sbHeaders(),
      body: JSON.stringify(txToRow(item))
    }).then(function (r) {
      if (!r.ok) throw new Error('Supabase 写入失败（' + r.status + '）');
      return true;
    });
  }

  function sbUpdate(id, item) {
    var row = txToRow(item);
    delete row.id;
    return fetch(sbUrl + '/rest/v1/' + sbTable + '?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: sbHeaders(),
      body: JSON.stringify(row)
    }).then(function (r) {
      if (!r.ok) throw new Error('Supabase 修改失败（' + r.status + '）');
      return true;
    });
  }

  function sbRemove(id) {
    return fetch(sbUrl + '/rest/v1/' + sbTable + '?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: sbHeaders({ Prefer: 'return=minimal' })
    }).then(function (r) {
      if (!r.ok) throw new Error('Supabase 删除失败（' + r.status + '）');
      return true;
    });
  }

  /* ---------------- CloudBase（备） ---------------- */
  function req(payload) {
    return fetch(cbApi, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.code !== 0) {
        if (j && j.code === 401) setToken('');
        throw new Error((j && j.msg) || '备用通道写入失败');
      }
      return j.data;
    });
  }

  function cbWrite(payload) {
    if (!cbOnline) return Promise.reject(new Error('备用通道未配置'));
    var t = getToken() || askToken();
    if (!t) return Promise.reject(new Error('已取消口令输入'));
    payload.token = t;
    return req(payload);
  }

  function cbList() {
    if (!cbOnline) return Promise.reject(new Error('备用通道未配置'));
    return fetch(cbApi + '?action=list', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.code !== 0) throw new Error((j && j.msg) || '备用通道读取失败');
        return j.data || {};
      });
  }

  /* ---------------- 新品（CloudBase 存储，Supabase 无对应表） ---------------- */
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

  /* ---------------- 加载：主通道优先，失败自动切备用 ---------------- */
  function load() {
    if (!sbOnline && !cbOnline) return Promise.resolve(fileItems());

    var errors = [];
    var chain = sbOnline ? sbList().then(function (txs) {
      if (txs.length) {
        applyTrades(txs);
        source = 'supabase';
      }
      return txs.length;
    }).catch(function (e) {
      errors.push(e.message);
      return 0;
    }) : Promise.resolve(0);

    return chain.then(function (n) {
      if (n) return true;
      if (!cbOnline) return false;
      return cbList().then(function (data) {
        var txs = (data.transactions || []).map(clean);
        if (txs.length) {
          applyTrades(txs);
          source = 'cloudbase';
        }
        applyNewProducts((data.newproducts || []).map(clean));
        return true;
      }).catch(function (e) {
        errors.push(e.message);
        return false;
      });
    }).then(function () {
      /* 主通道成功时，新品仍从备用通道补一次（best-effort） */
      if (source === 'supabase' && cbOnline) {
        return cbList().then(function (data) {
          applyNewProducts((data.newproducts || []).map(clean));
        }).catch(function () {});
      }
    }).then(function () {
      if (!source || source === 'file') {
        if (errors.length) console.warn(errors.join('；') + '，本次使用页面内置底稿');
      }
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
    var primary = sbOnline
      ? sbAdd(item).then(function () { return '已录入云端'; })
      : Promise.reject(new Error('主通道未配置'));
    return primary.catch(function (e) {
      return cbWrite({ action: 'saveTx', item: item }).then(function () { return '已录入备用通道'; });
    }).then(function (msg) {
      var list = fileItems().slice();
      list.push(item);
      applyTrades(list);
      return { ok: true, message: msg, item: item };
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
    var primary = sbOnline
      ? sbUpdate(id, item).then(function () { return '已修改云端交易'; })
      : Promise.reject(new Error('主通道未配置'));
    return primary.catch(function () {
      return cbWrite({ action: 'saveTx', item: item }).then(function () { return '已修改备用通道交易'; });
    }).then(function (msg) {
      var list = fileItems().map(function (t) {
        return t.id === id ? Object.assign({}, t, item) : t;
      });
      applyTrades(list);
      return { ok: true, message: msg };
    });
  }

  function remove(id) {
    var primary = sbOnline
      ? sbRemove(id).then(function () { return '已删除云端交易'; })
      : Promise.reject(new Error('主通道未配置'));
    return primary.catch(function () {
      return cbWrite({ action: 'delTx', id: id }).then(function () { return '已删除备用通道交易'; });
    }).then(function (msg) {
      applyTrades(fileItems().filter(function (t) { return t.id !== id; }));
      return { ok: true, message: msg };
    });
  }

  function status() {
    if (sbOnline) {
      return sbList().then(function () {
        source = 'supabase';
        return { ok: true, source: 'supabase', message: '主通道 Supabase 已连接' };
      }).catch(function () { return probeBackup(); });
    }
    return probeBackup();
  }

  function probeBackup() {
    if (!cbOnline) return Promise.resolve({ ok: false, source: 'file', message: '仅本地底稿' });
    return cbList().then(function () {
      source = 'cloudbase';
      return { ok: true, source: 'cloudbase', message: '备用通道已连接' };
    }).catch(function () {
      return { ok: false, source: 'file', message: '云端不可用，使用内置底稿' };
    });
  }

  function verify() {
    var t = getToken() || askToken();
    if (!t) return Promise.reject(new Error('已取消口令输入'));
    return req({ action: 'delTx', token: t, id: '__verify__' }).then(function () {
      return { ok: true, message: '备用通道口令有效' };
    });
  }

  window.STORE = {
    online: sbOnline || cbOnline,
    load: load,
    add: add,
    update: update,
    remove: remove,
    status: status,
    verify: verify,
    askToken: askToken,
    token: getToken,
    source: function () { return source; },
    reset: function () { setToken(''); }
  };
  window.STORE_READY = load();
})();
