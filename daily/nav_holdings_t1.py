"""持仓产品 T-1 净值攻坚（持仓优先 + 多路径兜底）。

背景：盈亏汇总里的持仓产品（交易记录中所有 pid）净值一度停在 T-5，
根因是旧轮换脚本只走中国理财网（T+N 时滞）且只认 data.js 的 4 只持仓。
本脚本按「真实持仓清单优先」实时抓取，能用多路径取到 T-1 就取：

  路径 1a 建行官网 NLC165 精确渠道代码 ECD（IvsmPd_ECD）——最可靠，
         凭 reg_alias.json「登记编码 -> ECD」映射，跨渠道改名/加前后缀仍能精确命中；
         解决「南极星/（代销）/（数字人民币专享）」等名称写法不一致导致的匹配失败；
  路径 1b 建行官网 NLC165 产品全名归一匹配（含 contains 兜底）——覆盖大多数持仓；
  路径 1c 建行官网 NLC165 身份核匹配（identity_key）——解决机构名前后缀/份额字母/
         渠道专享写法不一致导致的"名称对不上"（贝莱德机构名后缀、光大 D/I 份额等）；
  路径 2  中邮理财官网列表（psbc-wm.com，返回 Z7 登记编码 + 最新净值 + 日期）——
         按需（--psbc-pages）补 NLC165 未命中的中邮产品；
  路径 3  建信理财官网 chart（wealthccb.com，凭 ccb_map.json 的 ecd）——
         补建信系产品历史净值序列；全库扩展另含交银官网按 fundcode 单点兜底
         （BOCOM_FUNDCODES，补 NLC165 未收录的灵动慧利132/133号等）；
  路径 4  中国理财网主源（nav_bulk，按 Z7 登记编码）——最后兜底，
         仅当上面官网渠道都取不到 T-1 时才用（默认关闭 --cw，限频防人机验证）。

匹配优先级：ECD 精确 > 名称归一 > 其他官网 > 理财网兜底。绝不伪造净值；
若某产品所有官方渠道都未披露 T-1（如部分中邮产品披露时滞长），则取全网最新可得点，
并在末尾 T-1 覆盖汇总中如实标记为「滞后」，前端显示真实披露日。

只写「比现有更新」的净值点：不回退、不重复、不覆盖历史序列，不碰隔离数据。
净值追加到该产品的 dates/nav/per10k 末尾，并刷新 latestDate/latestNav。
数据源自包含（urllib + 标准库 + legacy TLS 兼容），不依赖技能目录，可在 CI 跑。

用法：
  python daily/nav_holdings_t1.py            # 抓全部持仓并写回
  python daily/nav_holdings_t1.py --dry-run  # 只打印将更新什么，不写文件
  python daily/nav_holdings_t1.py --gap 0.15 # 分页间隔秒
"""
import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA_JS = os.path.join(ROOT, "assets", "data.js")
LIB_JS = os.path.join(ROOT, "assets", "library.js")
LIB_JSON = os.path.join(HERE, "library.json")
TX_JS = os.path.join(ROOT, "assets", "transactions.js")
CCB_MAP = os.path.join(HERE, "ccb_map.json")
REG_ALIAS = os.path.join(HERE, "reg_alias.json")
CN = timezone(timedelta(hours=8))

DESKTOP_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


# ---------------- 通用 HTTP（含旧式 TLS 重协商兼容） ----------------
def _legacy_ctx():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        ctx.options |= ssl.OP_LEGACY_SERVER_CONNECT
    except AttributeError:
        ctx.options |= 0x4
    return ctx


def http_get(url, referer="", timeout=25, legacy=False):
    headers = {"User-Agent": DESKTOP_UA, "Accept": "application/json, text/plain, */*",
               "Accept-Language": "zh-CN,zh;q=0.9"}
    if referer:
        headers["Referer"] = referer
    try:
        req = urllib.request.Request(url, headers=headers)
        kw = {"timeout": timeout}
        if legacy:
            kw["context"] = _legacy_ctx()
        with urllib.request.urlopen(req, **kw) as r:
            raw = r.read()
            ctype = r.headers.get("Content-Type", "")
            m = re.search(r"charset=([\w-]+)", ctype, re.I)
            return r.status, raw.decode(m.group(1) if m else "utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception:
        return 0, ""


def norm_date(s):
    s = str(s or "").strip()
    if len(s) == 8 and s.isdigit():
        return "%s-%s-%s" % (s[:4], s[4:6], s[6:])
    m = re.match(r"(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})", s)
    if m:
        return "%s-%02d-%02d" % (m.group(1), int(m.group(2)), int(m.group(3)))
    return ""


def fnum(v):
    try:
        f = float(v)
        return f if f == f and abs(f) != float("inf") else None
    except (TypeError, ValueError):
        return None


_DROP = set(" \t\r\n（）()·•-—、`[]【】")

# 建行代销网对部分产品会加"代销冠名前缀"（如 南极星稳富7天持有期7号 = 中银稳富7天持有期7号）。
# 这些前缀不含数字编号，用它拼出候选全名再做"完整 key 命中"，可安全救回被前缀挡住的产品，
# 不会像裸 contains 那样把"7号"错配到"27号"。仅用于 --all 全库扫描的兜底。
NLC_SAFE_PREFIXES = ("南极星", "中银理财", "建信理财", "交银理财", "光大理财",
                     "民生理财", "中邮理财", "农银理财", "信银理财", "兴银理财")


def name_key(s):
    """产品名归一：去标点/空格/代销字样，用于精确匹配。"""
    out = "".join(ch for ch in str(s or "") if ch not in _DROP)
    return out.replace("代销", "")


# ---------------------------------------------------------------------------
# 身份核归一（2026-11-23）：解决"名称对不上导致抓不到最新净值"。
# 建行代销网 NLC165 的产品名写法与产品库名存在系统性差异：
#   - 机构名位置不同：库内"贝莱德建信理财贝淳金元100天…"，代销"贝淳金元100天…贝莱德建信理财"（后缀）
#   - 份额字母后缀：代销"光大理财阳光金乐盈日开31号…D/I"（尾部单字母），库内无
#   - 渠道专享后缀：代销"…21天最低持有D房贷专享"，库内无
#   - 代销冠名前缀：代销"南极星稳富7天…"（旧规则已处理）
# 身份核 = 剥离机构名(前/后) + 渠道专享字样 + 尾部份额字母后的稳定核心标识。
# 用身份核做"精确等值"匹配（不是裸 contains，避免"7号"错配"27号"），
# 命中后仍须通过原有 现金类占位/量级±5%/万份收益±5 校验，宁可滞后不串份额。
# ---------------------------------------------------------------------------
# 机构名 token：按长度降序，确保"贝莱德建信理财"先于"建信理财"被剥离，
# 避免长机构名被短 token 截断后残留导致身份核不一致。
ORG_TOKENS = tuple(sorted([
    "贝莱德建信理财", "中银理财", "建信理财", "交银理财", "光大理财", "光银理财",
    "中邮理财", "邮银理财", "农银理财", "信银理财", "兴银理财", "民生理财",
    "浦银理财", "工银理财", "华夏理财", "招银理财", "平安理财", "南银理财",
    "苏银理财", "北银理财", "上银理财", "徽银理财", "杭银理财", "宁银理财",
    "青银理财", "南极星", "中银", "建信", "交银", "光大", "中邮", "农银",
    "信银", "兴银", "民生", "浦银", "工银", "华夏", "招银", "平安",
    "固定收益类", "理财产品", "理财", "股份", "有限公司", "责任", "银行",
], key=len, reverse=True))
# 渠道专享后缀：这类字样代销网有、产品库名没有，归一前统一剥离。
CHANNEL_SUFFIX = ("数字人民币专享", "房贷专享", "私行专享", "代销", "专属", "尊享")
# 尾部份额字母正则：代销网用单个大写字母标识份额（A/B/D/I/E…），库内名不带。
_SHARE_TAIL_RE = re.compile(r"[A-Z]$")


def identity_key(s):
    """身份核：机构名(前/后)/渠道专享/尾部份额字母剥离后的稳定核心标识。"""
    k = name_key(s)
    if not k:
        return ""
    for tok in ORG_TOKENS:
        tk = name_key(tok)
        if not tk:
            continue
        # 反复剥离，覆盖"机构名+机构名"叠加写法；保留至少 4 字核心避免清空
        while len(k) > len(tk) + 3 and k.startswith(tk):
            k = k[len(tk):]
        while len(k) > len(tk) + 3 and k.endswith(tk):
            k = k[:-len(tk)]
    for suf in CHANNEL_SUFFIX:
        sk = name_key(suf)
        if sk and len(k) > len(sk) + 3:
            k = k.replace(sk, "")
    k = _SHARE_TAIL_RE.sub("", k)
    return k


def build_identity_index(by_name):
    """从 NLC 名称索引派生身份核索引：{身份核: [(date, nav, 代销全名), ...]}。

    保留同身份核的所有候选（多份额/多写法），供 pick_identity 按净值连续性择优。
    """
    idx = {}
    for nm, (d, v) in by_name.items():
        ik = identity_key(nm)
        if ik:
            idx.setdefault(ik, []).append((d, v, nm))
    return idx


def pick_identity(identity_idx, name, cur_date="", cur_nav=None):
    """按身份核精确匹配 NLC 产品，多候选时安全择优。

    返回 (date, nav, 代销全名) 或 None。安全策略：
      1. 身份核精确等值命中（非 contains）；
      2. 只在日期比库内更新时才考虑推进；
      3. 多候选先按隐含万份收益 (nav-cur_nav)*10000 ∈ [-5,5] 过滤错配份额，
         再取日期最新、净值与库内最接近的一条；
      4. 若同日候选彼此净值差异 >0.5%（疑似不同份额/产品线），整只放弃。
    """
    ik = identity_key(name)
    if not ik:
        return None
    cands = list(identity_idx.get(ik) or [])
    if not cands:
        return None
    cands = [c for c in cands if c[1] and c[1] > 0 and (not cur_date or c[0] > cur_date)]
    if not cands:
        return None
    if cur_nav:
        ok = [c for c in cands if -5 <= (c[1] - cur_nav) * 10000 <= 5]
        if not ok:
            return None
        cands = ok
    max_date = max(c[0] for c in cands)
    same_day = [c for c in cands if c[0] == max_date]
    # 同日多候选净值差异过大 → 疑似串到不同份额/产品线，放弃
    if len(same_day) > 1:
        vals = [c[1] for c in same_day]
        if (max(vals) - min(vals)) / max(min(vals), 1e-9) > 0.005:
            return None
    if cur_nav:
        return min(same_day, key=lambda c: abs(c[1] - cur_nav))
    return min(same_day, key=lambda c: c[1])


def lookup_nlc(nlc, name):
    """在 NLC165 索引里查产品：先精确，再包含匹配。

    包含匹配要求网页全名 key 完整出现在官网名里（防止"2号"错配"27号"）；
    多份额（A/B/D/I 类）会命中多条，取日期最新的；同日多条取净值最小值
    （通常是主/基准份额），确保至少把时滞推进到最新披露日。
    """
    key = name_key(name)
    if key in nlc:
        return nlc[key]
    if not key:
        return None
    hits = [v for k, v in nlc.items() if key in k and v]
    if not hits:
        return None
    max_date = max(h[0] for h in hits)
    same_day = [h for h in hits if h[0] == max_date]
    return (max_date, min(h[1] for h in same_day))


# ---------------- 读取网页数据 ----------------
def load_js_var(path, var):
    txt = open(path, encoding="utf-8").read()
    m = re.search(r"window\.%s\s*=\s*(\{.*\})\s*;?\s*$" % re.escape(var), txt, re.S)
    if not m:
        raise SystemExit("无法解析 %s 的 window.%s" % (path, var))
    return json.loads(m.group(1)), txt


def holding_regcodes():
    """交易记录里所有出现过的 pid → regCode（去重）"""
    tx, _ = load_js_var(TX_JS, "TRANSACTIONS")
    pids = sorted(set(it["pid"] for it in tx.get("items", [])))
    lib, _ = load_js_var(LIB_JS, "PRODUCT_LIBRARY")
    data, _ = load_js_var(DATA_JS, "REPORT_DATA")
    byid = {x["id"]: x for x in lib.get("items", [])}
    byid.update({x["id"]: x for x in data.get("products", [])})
    out = []
    for pid in pids:
        x = byid.get(pid)
        if x and x.get("regCode"):
            out.append((pid, x["regCode"], x))
    return out


# ---------------- 路径 1：建行官网 NLC165 全量 ----------------
NLC165 = ("https://wealth3.ccb.com/tran/WCCMainPlatV5?CCB_IBSVersion=V5"
          "&SERVLET_NAME=WCCMainPlatV5&TXCODE=NLC165&Rs_MtdCd=1"
          "&REC_IN_PAGE=1000&PAGE_JUMP={page}")
NLC165_REF = "https://wealth3.ccb.com/cn/finance/products/net_value/list.html"


def pull_nlc165(gap):
    """返回 (by_name, by_ecd) 两个索引，只保留有效净值点。

    by_name: {name_key: (date, nav)}   —— 名称匹配兜底
    by_ecd:  {IvsmPd_ECD: (date, nav)} —— 渠道精确代码，跨渠道改名时最可靠
    """
    by_name = {}
    by_ecd = {}
    today = datetime.now(CN).strftime("%Y-%m-%d")
    page = 1
    while page <= 20:
        code, text = http_get(NLC165.format(page=page), referer=NLC165_REF,
                              timeout=30, legacy=True)
        if code != 200 or not text:
            break
        try:
            j = json.loads(text)
        except json.JSONDecodeError:
            break
        if str(j.get("SUCCESS")).lower() != "true":
            break
        arr = j.get("PROD_MARKET_LIST") or []
        for x in arr:
            nd = norm_date(x.get("Valt_Dt"))
            nav = fnum(x.get("Unit_Ast_NetVal"))
            nm = name_key(x.get("Fnd_Nm"))
            ecd = str(x.get("IvsmPd_ECD") or "").strip()
            if not nd or nav is None or nav <= 0 or nd > today:
                continue
            if nm:
                prev = by_name.get(nm)
                if prev is None or nd > prev[0]:
                    by_name[nm] = (nd, nav)
            if ecd:
                prev = by_ecd.get(ecd)
                if prev is None or nd > prev[0]:
                    by_ecd[ecd] = (nd, nav)
        total_page = int(j.get("TOTAL_PAGE") or 1)
        if not arr or page >= total_page:
            break
        page += 1
        if gap:
            time.sleep(gap)
    return by_name, by_ecd


# ---------------- 路径 2：中邮理财官网列表 ----------------
PSBC_LIST = "https://www.psbc-wm.com/pswm-api/product/search?pageNum={page}"


def pull_psbc(gap, max_pages=0):
    """返回 {regCode: (date, nav)}。max_pages=0 表示不抓。"""
    idx = {}
    if not max_pages:
        return idx
    page = 1
    while page <= max_pages:
        code, text = http_get(PSBC_LIST.format(page=page),
                              referer="https://www.psbc-wm.com/", timeout=25, legacy=True)
        if code != 200 or not text:
            break
        try:
            j = json.loads(text)
        except json.JSONDecodeError:
            break
        data = j.get("data") or {}
        arr = data.get("list") or []
        for x in arr:
            reg = str(x.get("wp_registration_code") or "").strip()
            nd = norm_date(x.get("update_date"))
            nav = fnum(x.get("nav"))
            today = datetime.now(CN).strftime("%Y-%m-%d")
            if not reg or not nd or nav is None or nav <= 0 or nd > today:
                continue
            prev = idx.get(reg)
            if prev is None or nd > prev[0]:
                idx[reg] = (nd, nav)
        if not arr or data.get("lastPage") or page >= int(data.get("totalPage") or 1):
            break
        page += 1
        if gap:
            time.sleep(gap)
    return idx


# ---------------- 路径 2b：交银理财官网单点兜底 ----------------
# 少数交银产品（如灵动慧利日开132/133号、固收精选日开12号）官网已披露 T-1，
# 但建行代销 NLC165 未收录或持平，用官网 fundcode 直接抓最新点补上。
# fundcode 由产品登记编码映射，避免按名称匹配（同名多期易串）。
BOCOM_FUNDCODES = {
    "LZ7000926001562": "5811226658",  # 稳享灵动慧利日开133号（7天持有期）
    "LZ7000926001560": "5811226608",  # 稳享灵动慧利日开132号（7天持有期）
    "LZ7000926001674": "5811226579",  # 稳享固收精选日日开12号
}
BOCOM_BASE = "https://www.bocommwm.com"
BOCOM_LIST = "/SITE/queryJylcProductInfo.do"
BOCOM_REF = (BOCOM_BASE + "/BankCommSite/shtml/jylc/cn/2503327/2503412/list.shtml"
             "?channelId=2503327")


def _bocom_post(path, body):
    """交银官网 REQ_MESSAGE 包裹协议（需 legacy TLS + 绕代理）。"""
    msg = json.dumps({"REQ_HEAD": {"TRAN_PROCESS": "", "TRAN_ID": ""},
                      "REQ_BODY": body}, ensure_ascii=False, separators=(",", ":"))
    import urllib.parse
    data = urllib.parse.urlencode({"REQ_MESSAGE": msg}).encode()
    req = urllib.request.Request(BOCOM_BASE + path, data=data, headers={
        "User-Agent": DESKTOP_UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest", "Origin": BOCOM_BASE,
        "Referer": BOCOM_REF, "Accept": "application/json, text/javascript, */*; q=0.01"})
    ctx = _legacy_ctx()
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ctx), urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=25) as r:
        payload = json.loads(r.read().decode("utf-8"))
    head = payload.get("RSP_HEAD") or {}
    if head.get("TRAN_SUCCESS") != "1":
        return []
    result = (payload.get("RSP_BODY") or {}).get("result") or []
    return result if isinstance(result, list) else []


def pull_bocom_index(fundcodes):
    """按 fundcode 批量取交银官网最新点：{fundcode: (date, nav)}。

    全量列表只拉一次（keyWord 按所需产品名逐个查更慢且 name 易变），
    用 fundcode 精确匹配，避免同名多期串数据。
    """
    out = {}
    want = set(fundcodes)
    if not want:
        return out
    # 一次拉全量（pageStart/pageEnd 是行号，这里取足够多覆盖交银全系）
    try:
        rows = _bocom_post(BOCOM_LIST, {
            "pageStart": 1, "pageEnd": 400, "product": "personal", "keyWord": ""})
    except Exception:
        rows = []
    for it in rows:
        fc = str(it.get("c_fundcode") or "").strip()
        if fc in want:
            d = norm_date(it.get("d_cdate"))
            nav = fnum(it.get("f_netvalue"))
            if d and nav and nav > 0:
                out[fc] = (d, nav)
    # 全量未覆盖的，按 fundcode 精确查一次（官网列表支持代码检索）
    for fc in want - set(out):
        try:
            hits = _bocom_post(BOCOM_LIST, {
                "pageStart": 1, "pageEnd": 15, "product": "personal", "keyWord": fc})
            for it in hits:
                if str(it.get("c_fundcode") or "").strip() == fc:
                    d = norm_date(it.get("d_cdate"))
                    nav = fnum(it.get("f_netvalue"))
                    if d and nav and nav > 0:
                        out[fc] = (d, nav)
                        break
        except Exception:
            continue
    return out


# ---------------- 路径 3：建信官网 chart ----------------
CCB_CHART = "https://www.wealthccb.com/website/v1/api/product/chart?id={ecd}"


def pull_ccb_chart(ecd):
    """返回按日期升序的 [(date, nav)]。"""
    code, text = http_get(CCB_CHART.format(ecd=ecd), referer="https://www.wealthccb.com/", timeout=25)
    if code != 200 or not text:
        return []
    try:
        j = json.loads(text)
    except json.JSONDecodeError:
        return []
    rows = []
    for it in (j.get("data") or []):
        nd = norm_date(it.get("drivDt"))
        nav = fnum(it.get("netVal"))
        if nd and nav is not None:
            rows.append((nd, nav))
    rows.sort()
    return rows


# ---------------- 净值序列更新（只追加更新的点） ----------------

# 成立日确认净值（用户核验的凭据，不是推算）：
# 募集期官网/代销页展示的 nav=1.000000 只是占位（未成立、未起息、无份额），不得入账；
# 成立日/起息日按份额确认的 1.000000 是真实初始单位净值，可作为首个披露点入账。
# 键 = 登记编码，值 = (确认日, 净值, 来源)。只在库内还没有净值序列时写入，绝不覆盖真实披露。
INCEPTION_NAV_CONFIRMED = {
    "Z7001626001126": (
        "2026-11-27", 1.0,
        "建行App持仓明细·起息日份额按1.000000确认（用户截图核验 2026-11-27）",
    ),
}


def is_pre_inception_placeholder(product, date, nav):
    """募集期 nav=1.0 占位过滤：日期早于成立日的一律不认；
    成立日当日及之后的 1.0 是份额按 1 确认的真实初始净值，允许入账。"""
    if nav is None:
        return True
    try:
        if abs(float(nav) - 1.0) > 1e-9:
            return False
    except (TypeError, ValueError):
        return True
    inc = str(product.get("inception") or "")
    return bool(inc) and str(date) < inc


def apply_inception_seeds(lib_items):
    """把已核验的成立日确认净值写成产品库首个净值点，返回写入数量。"""
    n = 0
    for x in lib_items:
        seed = INCEPTION_NAV_CONFIRMED.get(str(x.get("regCode") or ""))
        if not seed:
            continue
        date, nav, src = seed
        if x.get("dates") or x.get("latestDate"):
            continue  # 已有真实披露序列，不用初始点覆盖
        inc = str(x.get("inception") or "")
        if inc and date < inc:
            continue
        if not apply_point(x, date, nav):
            continue
        x["source"] = src
        x["navTried"] = date  # 当天不再重复尝试，避免募集期占位被写回
        n += 1
        print("  成立日确认净值 %-18s %s nav=%.6f [%s]" %
              (str(x.get("regCode"))[-8:], date, nav, src), flush=True)
    return n


def apply_point(product, date, nav):
    """把单个净值点追加到产品序列，返回是否真的更新。"""
    dates = list(product.get("dates") or [])
    navs = list(product.get("nav") or [])
    per = list(product.get("per10k") or [])
    if dates and date <= dates[-1]:
        return False
    if dates and navs and len(navs) != len(dates):
        return False  # 结构异常，跳过避免污染
    dates.append(date)
    navs.append(round(nav, 6))
    # 占位产品初始化时 per10k 可能是 [None]（nav 为空）。追加首点时必须把数组
    # 收敛到与 nav 等长，否则 check_data 的结构校验会报长度不等。
    while len(per) > len(navs) - 1:
        per.pop()
    while len(per) < len(navs) - 1:
        per.append(None)
    if len(navs) >= 2 and navs[-2]:
        per.append(round((navs[-1] - navs[-2]) * 10000, 2))
    else:
        per.append(None)
    product["dates"] = dates
    product["nav"] = navs
    product["per10k"] = per
    product["latestDate"] = date
    product["latestNav"] = round(nav, 6)
    return True


def save(data, lib, data_changed=False, lib_changed=False):
    """只写确实有净值更新的文件；asOf/fetchedAt 只前进一步，不回退快照日。"""
    now = datetime.now(CN).strftime("%Y-%m-%d %H:%M")
    if data_changed:
        data["fetchedAt"] = now
        # asOf 只升不降：产品最大净值日不应把"数据截至快照日"改小
        calc = max([p.get("latestDate", "") for p in data.get("products", [])] or [""])
        if calc > data.get("asOf", ""):
            data["asOf"] = calc
        with open(DATA_JS, "w", encoding="utf-8") as f:
            f.write("window.REPORT_DATA = " + json.dumps(data, ensure_ascii=False, indent=2) + ";\n")
    if lib_changed:
        items = lib.get("items", [])
        items.sort(key=lambda x: x.get("inception") or "", reverse=True)
        calc = max([x.get("latestDate", "") for x in items] or [""])
        if calc > lib.get("asOf", ""):
            lib["asOf"] = calc
        lib["fetchedAt"] = now
        with open(LIB_JSON, "w", encoding="utf-8") as f:
            json.dump(lib, f, ensure_ascii=False, indent=2)
        with open(LIB_JS, "w", encoding="utf-8") as f:
            f.write("window.PRODUCT_LIBRARY = " + json.dumps(lib, ensure_ascii=False) + ";\n")


def main():
    ap = argparse.ArgumentParser(description="持仓产品 T-1 净值攻坚")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写文件")
    ap.add_argument("--all", action="store_true",
                    help="扩展到全库非持仓产品：用已抓取的 NLC165 索引补滞后净值。"
                         "接受精确名称/ECD 命中 + 安全代销前缀(南极星等)命中 + 身份核命中"
                         "(机构名前后缀/份额字母/渠道专享归一) + 交银官网单点兜底 + 真实净值"
                         "（跳过募集期 nav=1.0 占位与现金类等量级占位；成立日当日及之后的 1.0 "
                         "按份额确认的真实初始净值入账，前缀/身份核命中另过万份收益与净值差校验）；"
                         "默认关闭，仅处理持仓")
    ap.add_argument("--gap", type=float, default=0.15, help="分页间隔秒")
    ap.add_argument("--cw", action="store_true",
                    help="启用中国理财网兜底（限频、慢，默认关闭；常规由 nav_rotate.py 轮换补）")
    ap.add_argument("--psbc-pages", type=int, default=0,
                    help="中邮官网列表抓取页数（默认 0=跳过；全量 435 页很慢，一般靠中国理财网兜底即可）")
    ap.add_argument("--cw-gap", type=float, default=16.0,
                    help="中国理财网兜底调用间隔秒（平台限频默认 15s，避免触发人机验证）")
    ap.add_argument("--cw-max", type=int, default=6,
                    help="中国理财网兜底最多处理几只（避免 CI 超时）")
    a = ap.parse_args()
    # 目标 T-1：今天往前一个自然日（周末无净值，用最近的目标做阈值即可）
    t1 = (datetime.now(CN) - timedelta(days=1)).strftime("%Y-%m-%d")

    holds = holding_regcodes()
    print("真实持仓 %d 只（按交易记录）" % len(holds), flush=True)
    data, _ = load_js_var(DATA_JS, "REPORT_DATA")
    lib, _ = load_js_var(LIB_JS, "PRODUCT_LIBRARY")
    lib_items = lib.get("items", [])
    byid = {x["id"]: x for x in lib_items}
    byid.update({x["id"]: x for x in data.get("products", [])})
    cmap = {}
    if os.path.exists(CCB_MAP):
        try:
            cmap = json.load(open(CCB_MAP, encoding="utf-8"))
        except Exception:
            cmap = {}

    # 先落已核验的成立日确认净值：必须早于 before/candidates 计算，
    # 否则同日的建行募集期 1.0 占位可能先把首点写成成立日之前。
    seeded = 0 if a.dry_run else apply_inception_seeds(lib_items)
    changed = seeded
    changed_lib = seeded > 0
    if seeded:
        print("成立日确认净值已补入 %d 只（仅库内无净值者）" % seeded, flush=True)

    before = {pid: (byid[pid].get("latestDate") or "") for pid, _, _ in holds}
    data_pids = set(x["id"] for x in data.get("products", []))  # 区分写回哪个文件

    # 精确渠道代码映射：登记编码 -> {ecd,...}，跨渠道改名时仍可精确命中
    alias = {}
    if os.path.exists(REG_ALIAS):
        try:
            alias = json.load(open(REG_ALIAS, encoding="utf-8")).get("aliases", {})
        except Exception:
            alias = {}

    print("抓取建行官网 NLC165 全量...", flush=True)
    nlc_by_name, nlc_by_ecd = pull_nlc165(a.gap)
    # 身份核索引：解决机构名前后缀/份额字母/渠道专享写法不一致导致的名称对不上
    nlc_identity = build_identity_index(nlc_by_name)
    print("  NLC165 有效净值 %d 只（名称 %d / ECD %d / 身份核 %d）" %
          (len(nlc_by_name), len(nlc_by_name), len(nlc_by_ecd), len(nlc_identity)), flush=True)
    psbc = {}
    if a.psbc_pages:
        print("抓取中邮理财官网列表（%d 页）..." % a.psbc_pages, flush=True)
        psbc = pull_psbc(a.gap, a.psbc_pages)
        print("  中邮列表有效净值 %d 只" % len(psbc), flush=True)

    # 中国理财网兜底：按需加载（延迟 import，避免在 dry-run/无依赖环境失败）
    nav_bulk = None
    cw_used = 0

    changed = 0
    changed_data = False
    changed_lib = False
    t1_report = []  # (pid, short, best_date, reached, src) 供末尾汇总
    for pid, reg, _prod in holds:
        # 关键：必须取自主函数 load 的 byid，apply_point 的修改才会被 save 写回
        prod = byid.get(pid)
        if prod is None:
            continue
        candidates = []  # (date, nav, source)
        # 路径 1a（最可靠）：精确渠道代码 ECD —— 优先用映射表，其次 ccb_map（建信自用）
        ecd = (alias.get(str(reg)) or {}).get("ecd") or cmap.get(str(reg))
        if ecd and ecd in nlc_by_ecd:
            h = nlc_by_ecd[ecd]
            candidates.append((h[0], h[1], "建行官网ECD"))
        # 路径 1b：名称归一匹配（含 contains 兜底）
        hit = lookup_nlc(nlc_by_name, prod.get("name"))
        if hit:
            candidates.append((hit[0], hit[1], "建行官网"))
        # 路径 1c：身份核匹配（机构名前后缀/份额字母/渠道专享写法不一致时兜底）
        ident = pick_identity(nlc_identity, prod.get("name"), before.get(pid, ""),
                              prod.get("latestNav"))
        if ident and not (hit and ident[0] <= hit[0]):
            candidates.append((ident[0], ident[1], "建行官网身份核"))
        if reg in psbc:
            candidates.append((psbc[reg][0], psbc[reg][1], "中邮官网"))
        # 建信官网 chart（ccb_map 的 ecd，通常是 JX/JXJXB 前缀）
        chart_ecd = cmap.get(str(reg))
        if chart_ecd and chart_ecd != ecd:
            rows = pull_ccb_chart(chart_ecd)
            if rows:
                candidates.append((rows[-1][0], rows[-1][1], "建信官网"))
        # 路径 4：上面没取到 T-1 就补中国理财网主源（官网优先，理财网仅兜底）
        best_so_far = max([c[0] for c in candidates], default="")
        if a.cw and best_so_far < t1 and cw_used < a.cw_max:
            cw_used += 1
            try:
                if nav_bulk is None:
                    import nav_bulk as _nb
                    nav_bulk = _nb
                elif a.cw_gap:
                    time.sleep(a.cw_gap)  # 限频：两次中国理财网调用之间拉开间隔
                cw_rows, _meta = nav_bulk.fetch(reg)
                if cw_rows:
                    r = cw_rows[-1]
                    candidates.append((r["date"], r["nav"], "中国理财网"))
            except Exception as exc:
                if "验证" in str(exc):
                    print("  中国理财网触发人机验证，跳过该产品", flush=True)
                # 其它异常静默跳过，不影响其它路径
        short = (prod.get("short") or prod.get("name", ""))[:26]
        if not candidates:
            best = before[pid]
            t1_report.append((pid, short, best, best >= t1, "-"))
            print("  %-18s %-28s 无新源命中（保持 %s）" % (pid, short, best), flush=True)
            continue
        candidates.sort(key=lambda x: x[0], reverse=True)
        date, nav, src = candidates[0]
        t1_report.append((pid, short, date, date >= t1, src))
        if is_pre_inception_placeholder(prod, date, nav):
            print("  %-18s %-28s 跳过：%s 的 nav=1.0 是募集期占位（成立日 %s）" %
                  (pid, short, date, prod.get("inception") or "-"), flush=True)
            continue
        if date <= before[pid]:
            print("  %-18s %-28s 最优源 %s=%s 不比现有新（%s）" %
                  (pid, short, src, date, before[pid]), flush=True)
            continue
        if not a.dry_run:
            if not apply_point(prod, date, nav):
                print("  %-18s 序列异常，跳过" % pid, flush=True)
                continue
        changed += 1
        if pid in data_pids:
            changed_data = True
        else:
            changed_lib = True
        print("  %-18s %-28s %s -> %s  nav=%s  [%s]" %
              (pid, short, before[pid] or "-", date, nav, src), flush=True)

    # ---- 全库扩展（--all）：用同一份 NLC165 索引补非持仓产品的滞后净值 ----
    # 防护比持仓更严：只接受精确名称/ECD 命中（不用 contains 兜底，防"7号"错配"27号"），
    # 只接受真实且同量级的净值（NLC165 对现金类给 nav=1.0 占位，直接写入会污染 per10k）。
    all_changed = 0
    if a.all:
        print("\n=== 全库扩展扫描（--all）：非持仓产品 NLC165 精确匹配 ===", flush=True)
        hold_pids = set(pid for pid, _, _ in holds)
        # 交银官网兜底：NLC165 未收录/持平的产品（如灵动慧利132/133号）官网已披露更新
        bocom_idx = pull_bocom_index(BOCOM_FUNDCODES.values())
        if bocom_idx:
            print("  交银官网兜底可用 %d 只" % len(bocom_idx), flush=True)
        for x in lib_items:
            pid = x.get("id")
            if not pid or pid in hold_pids or pid in data_pids:
                continue  # 持仓已在上面处理；data.js 产品由 sync_nav_data 回填
            reg = str(x.get("regCode") or "")
            cur = x.get("latestDate") or ""
            curnav = x.get("latestNav")
            hit = None
            src = ""
            # 精确 ECD 优先
            ecd = (alias.get(reg) or {}).get("ecd") or cmap.get(reg)
            if ecd and ecd in nlc_by_ecd:
                hit = nlc_by_ecd[ecd]
                src = "建行官网ECD"
            # 精确名称（不 contains）
            if hit is None:
                key = name_key(x.get("name") or x.get("short") or "")
                if key and key in nlc_by_name:
                    hit = nlc_by_name[key]
                    src = "建行官网"
            # 安全前缀兜底：建行代销对部分产品加冠名前缀（如"南极星"+产品名），
            # 精确匹配会漏掉。用"前缀+简称/全名"的完整 key 命中，不做裸 contains，
            # 避免"7号"错配"27号"。命中后仍须通过下方净值量级 + 万份收益校验。
            if hit is None:
                sk = name_key(x.get("short") or "")
                nk = name_key(x.get("name") or "")
                cands = []
                for _pfx in NLC_SAFE_PREFIXES:
                    pk = name_key(_pfx)
                    for _base, _label in ((sk, "简称"), (nk, "全名")):
                        if _base and (pk + _base) in nlc_by_name:
                            cands.append((nlc_by_name[pk + _base], _pfx, _label))
                if cands:
                    _best = max(cands, key=lambda c: c[0][0])
                    hit = _best[0]
                    src = "建行官网前缀(%s/%s)" % (_best[1], _best[2])
            # 身份核兜底：机构名后缀(贝莱德建信理财)/份额字母(光大 D/I)/渠道专享
            # 等写法差异，精确名和固定前缀都覆盖不到时用身份核精确等值匹配。
            # pick_identity 已内置"隐含万份收益±5 + 同日多候选净值差>0.5%放弃"防串校验。
            if hit is None:
                ident = pick_identity(nlc_identity, x.get("name"), cur, curnav)
                if ident:
                    hit = (ident[0], ident[1])
                    src = "建行官网身份核"
            # 交银官网单点兜底：按 pid 精确锁定 fundcode，官网已披露更新时采用。
            # 必须过隐含万份收益 ±5 校验，防 fundcode 映射错配串份额。
            if hit is None and pid in BOCOM_FUNDCODES:
                bp = bocom_idx.get(BOCOM_FUNDCODES[pid])
                if bp and curnav and -5 <= (bp[1] - curnav) * 10000 <= 5:
                    hit = bp
                    src = "交银理财官网"
            if not hit or hit[0] <= cur:
                continue
            # 真实净值校验：NLC165 对现金管理类给 1.0 占位（库内是 1.00x 折算净值），
            # 直接写入会把 per10k 算成大负数 -> 跳过 nav=1.0 且与库内不同量级的项
            nnav = hit[1]
            if nnav is None or nnav <= 0:
                continue
            # 募集期的 1.0 是占位；成立日当日及之后的 1.0 才是真实初始净值。
            if is_pre_inception_placeholder(x, hit[0], nnav):
                print("  %-18s %-22s 跳过：%s 的 nav=1.0 是募集期占位（成立日 %s）" %
                      (pid, (x.get("short") or "")[:22], hit[0],
                       x.get("inception") or "-"), flush=True)
                continue
            if nnav == 1.0 and curnav and abs(curnav - 1.0) > 1e-6:
                print("  %-18s %-22s 跳过：现金类 nav=1.0 占位" %
                      (pid, (x.get("short") or "")[:22]), flush=True)
                continue
            if curnav and (nnav < curnav * 0.95 or nnav > curnav * 1.05):
                print("  %-18s %-22s 跳过：净值量级异常 %s vs %s" %
                      (pid, (x.get("short") or "")[:22], nnav, curnav), flush=True)
                continue
            # 前缀兜底命中额外校验：隐含万份收益 (新nav-旧nav)*10000 须在 ±5 内。
            # 正常日收益远小于此；若错配到别的份额/产品线，这里会拦截（宁可滞后不串份额）。
            if "前缀" in src and curnav:
                implied = (nnav - curnav) * 10000
                if implied < -5 or implied > 5:
                    print("  %-18s %-22s 跳过：前缀匹配万份收益异常 %.2f（疑似错配）" %
                          (pid, (x.get("short") or "")[:22], implied), flush=True)
                    continue
            if not a.dry_run:
                if not apply_point(x, hit[0], nnav):
                    continue
            all_changed += 1
            changed_lib = True
            print("  %-18s %-22s %s -> %s  nav=%s  [%s]" %
                  (pid, (x.get("short") or "")[:22], cur or "-", hit[0], nnav, src),
                  flush=True)
        print("全库扩展：将更新 %d 只非持仓产品" % all_changed, flush=True)
        changed += all_changed
    else:
        print("\n（未启用 --all，跳过全库非持仓产品；加 --all 扩展）", flush=True)

    # T-1 覆盖汇总：让"是否取到 T-1"一目了然
    reached = [r for r in t1_report if r[3]]
    lagging = [r for r in t1_report if not r[3]]
    print("\n=== T-1(%s) 覆盖：%d/%d 已达标 ===" % (t1, len(reached), len(t1_report)), flush=True)
    for pid, short, date, ok, src in sorted(t1_report, key=lambda r: (r[3], r[2])):
        print("  [%s] %-18s %-28s %s  %s" %
              ("OK" if ok else "滞后", pid, short, date, src), flush=True)
    if lagging:
        print("  说明：滞后产品为各官方渠道均未披露 T-1，已取全网最新可得点（不伪造净值）。", flush=True)

    if a.dry_run:
        print("DRY-RUN：将更新 %d 只，未写文件" % changed, flush=True)
        return 0
    if changed:
        save(data, lib, changed_data, changed_lib)
        print("已写回：更新 %d 只持仓净值（data.js=%s library.js=%s）" %
              (changed, changed_data, changed_lib), flush=True)
    else:
        print("无持仓净值需要更新", flush=True)
    # 按 regCode 把 library 较新净值同步回填 data.js，避免双源不同步
    # （本脚本按交易 pid 写回，data.js 里同 regCode 的 p-id 可能没被直接命中）
    try:
        import sync_nav_data
        sc, sd = sync_nav_data.sync_files(write=True)
        if sc:
            print("已按登记编码回填 data.js：%d 只 %s" % (sc, sd), flush=True)
    except Exception as exc:
        print("data.js 净值同步跳过：%s" % str(exc)[:120], flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
