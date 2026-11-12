/* 交易存储层
 * 配好 assets/supabase-config.js 时走云端（Supabase REST），任何设备打开都是同一份数据；
 * 未配置时退回浏览器本地存储，单机可登记，不跨设备。
 * 对外接口：STORE.load() / STORE.add() / STORE.update() / STORE.remove()
 */
(function () {
  var CFG = window.SUPABASE_CONFIG || {};
  var url = String(CFG.url || '').replace(/\/+$/, '');
  var key = CFG.key || '';
  var TABLE = CFG.table || 'trades';
  var LS_KEY = 'wealth3.trades.v1';
  var online = !!(url && key);

  function headers(extra) {
    var h = { apikey: key, 'Content-Type': 'application/json', Prefer: 'return=representation' };
    h.Authorization = 'Bearer ' + key;
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
      shares: Number(r.shares),
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

  function fileItems() {
    return (window.TRANSACTIONS && window.TRANSACTIONS.items) || [];
  }

  function applyTrades(items) {
    window.TRANSACTIONS = window.TRANSACTIONS || {};
    window.TRANSACTIONS.items = items;
  }

  function localList() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      var list = raw ? JSON.parse(raw) : null;
      return Array.isArray(list) ? list : null;
    } catch (e) { return null; }
  }

  function localSave(list) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function newId(confirmDate) {
    var d = String(confirmDate || '').replace(/-/g, '') || String(Date.now());
    return 'TX' + d + String(Math.floor(Math.random() * 900) + 100);
  }

  function load() {
    if (!online) {
      var ls = localList();
      if (ls) applyTrades(ls);
      return Promise.resolve(fileItems());
    }
    return fetch(url + '/rest/v1/' + TABLE + '?select=*&order=id.asc', { headers: headers() })
      .then(function (r) {
        if (!r.ok) throw new Error('读取云端交易失败（' + r.status + '）');
        return r.json();
      })
      .then(function (rows) {
        if (rows.length) {
          applyTrades(rows.map(rowToTx));
          return fileItems();
        }
        /* 云端还是空表：把现有底稿（或本地缓存）一次性播种上去 */
        var seed = localList() || fileItems();
        if (!seed.length) return fileItems();
        return fetch(url + '/rest/v1/' + TABLE, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(seed.map(txToRow))
        }).then(function (r) {
          if (!r.ok) throw new Error('初始化云端交易失败（' + r.status + '）');
          return r.json();
        }).then(function (saved) {
          applyTrades((saved || seed.map(txToRow)).map(rowToTx));
          return fileItems();
        });
      })
      .catch(function (e) {
        console.warn(e.message + '，本次使用本地底稿');
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
    if (!online) {
      var list = localList() || fileItems().slice();
      list.push(item);
      localSave(list);
      applyTrades(list);
      return Promise.resolve({ ok: true, message: '已录入（本机保存）', item: item });
    }
    return fetch(url + '/rest/v1/' + TABLE, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(txToRow(item))
    }).then(function (r) {
      if (!r.ok) throw new Error('写入云端失败（' + r.status + '）');
      return r.json();
    }).then(function () {
      return { ok: true, message: '已录入云端', item: item };
    });
  }

  function update(id, tx) {
    var patch = txToRow({
      id: id,
      pid: tx.pid,
      type: tx.type,
      applyDate: tx.applyDate,
      confirmDate: tx.confirmDate,
      amount: tx.amount,
      shares: tx.shares,
      confirmNav: tx.confirmNav,
      saleChannel: tx.saleChannel
    });
    delete patch.id;
    if (!online) {
      var list = localList() || fileItems().slice();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          list[i] = Object.assign({}, list[i], {
            pid: tx.pid, type: tx.type, applyDate: tx.applyDate, confirmDate: tx.confirmDate,
            amount: tx.amount, shares: tx.shares, confirmNav: tx.confirmNav,
            saleChannel: tx.saleChannel || list[i].saleChannel
          });
          break;
        }
      }
      localSave(list);
      applyTrades(list);
      return Promise.resolve({ ok: true, message: '已修改（本机保存）' });
    }
    return fetch(url + '/rest/v1/' + TABLE + '?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(patch)
    }).then(function (r) {
      if (!r.ok) throw new Error('修改云端交易失败（' + r.status + '）');
      return { ok: true, message: '已修改云端交易' };
    });
  }

  function remove(id) {
    if (!online) {
      var list = (localList() || fileItems().slice()).filter(function (t) { return t.id !== id; });
      localSave(list);
      applyTrades(list);
      return Promise.resolve({ ok: true, message: '已删除（本机保存）' });
    }
    return fetch(url + '/rest/v1/' + TABLE + '?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: headers()
    }).then(function (r) {
      if (!r.ok) throw new Error('删除云端交易失败（' + r.status + '）');
      return { ok: true, message: '已删除云端交易' };
    });
  }

  window.STORE = {
    online: online,
    load: load,
    add: add,
    update: update,
    remove: remove,
    reset: function () { try { localStorage.removeItem(LS_KEY); } catch (e) {} }
  };
  window.STORE_READY = load();
})();
