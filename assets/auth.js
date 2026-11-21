/* 登录模块：Supabase Auth（邮箱+密码），会话存 localStorage。
 * 兼容模式：未登录时不带令牌，store.js 仍用 anon key —— RLS 开启前站点照常读写，
 * RLS 开启后 anon 被服务端拒绝，用户登录后本模块提供 access_token 恢复读写。
 * 不依赖 supabase-js，直接用官方 Auth REST 端点，避免引入外部库。 */
(function () {
  var SB = window.SUPABASE_CONFIG || {};
  var url = String(SB.url || '').replace(/\/+$/, '');
  var anon = SB.key || '';
  var K = 'wealth3.auth.session';

  var sess = null;
  try { sess = JSON.parse(window.localStorage.getItem(K) || 'null'); } catch (e) { sess = null; }

  function persist() {
    try {
      if (sess) window.localStorage.setItem(K, JSON.stringify(sess));
      else window.localStorage.removeItem(K);
    } catch (e) { /* 隐私模式忽略 */ }
  }

  /* 会话里的 expires_at 为绝对秒；旧会话可能是 expires_in，兼容换算一次 */
  function normalize(d) {
    if (!d || !d.access_token) return null;
    if (!d.expires_at && d.expires_in) d.expires_at = Math.floor(Date.now() / 1000) + Number(d.expires_in);
    return d;
  }
  sess = normalize(sess);
  if (sess) persist();

  /* 历史遗留：旧版本退出登录时没清交易缓存。这里在初始化阶段补一刀——
     未登录（含会话已过期）就删掉本机残留的真实交易缓存，避免隐私数据长期滞留。 */
  function hasSession() { return !!(sess && token()); }
  if (!hasSession()) {
    try { window.localStorage.removeItem('wealth3.trades.cache'); } catch (e) {}
  }

  function expired(d) {
    return !!(d && d.expires_at && Date.now() / 1000 >= Number(d.expires_at) - 60);
  }

  function token() {
    if (!sess || !sess.access_token || expired(sess)) return '';
    return sess.access_token;
  }

  function email() {
    return (sess && sess.user && sess.user.email) || (sess && sess.email) || '';
  }

  function isLogin() { return !!token(); }

  function parseErr(r, d) {
    var m = (d && (d.msg || d.message || d.error_description || d.error)) || ('HTTP ' + r.status);
    return new Error(String(m));
  }

  function postToken(body) {
    return fetch(url + '/auth/v1/token?grant_type=' + body.grant_type, {
      method: 'POST',
      headers: { apikey: anon, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw parseErr(r, d);
        return normalize(d);
      });
    });
  }

  function signIn(mail, pw) {
    mail = String(mail || '').trim();
    pw = String(pw || '');
    if (!mail || !pw) return Promise.reject(new Error('请填写邮箱和密码'));
    return postToken({ grant_type: 'password', email: mail, password: pw }).then(function (d) {
      sess = d;
      persist();
      return d;
    });
  }

  function signOut() {
    sess = null;
    persist();
    /* 退出即清除交易数据本地缓存：登录期从 Supabase 拉到的真实明细会写入
       wealth3.trades.cache，若不清，重载后 store.load() 又把缓存渲染出来，
       等于绕过 RLS —— 表现为「按钮已显示登录，却仍看得到全部金额」。 */
    try { window.localStorage.removeItem('wealth3.trades.cache'); } catch (e) {}
  }

  /* 刷新令牌：access 过期但有 refresh_token 时续期，成功后重载页面让 store 用新令牌取数 */
  function tryRefresh() {
    if (!sess || !sess.refresh_token || !expired(sess)) return;
    postToken({ grant_type: 'refresh_token', refresh_token: sess.refresh_token }).then(function (d) {
      sess = d;
      persist();
      try { window.location.reload(); } catch (e) {}
    }).catch(function () { signOut(); });
  }
  tryRefresh();

  window.AUTH = {
    token: token,
    email: email,
    isLogin: isLogin,
    signIn: signIn,
    signOut: signOut
  };
  window.dispatchEvent(new Event('auth:ready'));
})();
