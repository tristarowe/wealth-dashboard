"""农银 / 信银 / 兴银 / 民生 / 中邮 理财子公司官网直连净值（前 three 家 2026-11-22 第一批，
民生 2026-11-23 第二批，中邮 2026-11-27 第三批接入）。

用法
----
    python daily/nav_sites.py                       # 刷新产品库里这几家的全部产品
    python daily/nav_sites.py --dry-run             # 只打印不写文件
    python daily/nav_sites.py --org 农银,中邮        # 只跑指定机构
    python daily/nav_sites.py --only-reg Z7001126000969

为什么单独一个脚本
------------------
nav_official.py 只服务建信（官网 chart + 建行 NLC165 双源）；这四家接口结构完全不同，
共性是「一条列表接口自带最新净值、一条历史接口给序列」，但字段名、分页上限、份额命名
各异，所以按 adapter 拆开，共用同一套合并口径与防串份额规则。

取数口径（与 nav_official 一致，改动须同步两边）
-----------------------------------------------
1) 历史以官网序列为准并入，`latestDate` 只前进不回退（合并逻辑复用 nav_official.apply）；
2) 同一产品多份额（信银 B/D、兴银 A/B/C）无登记编码区分度，必须靠「历史重叠点精确一致」
   判定份额，命中不足则放弃该产品——宁可滞后，不可串净值；
3) 现金管理类单位净值恒为 1.0，此时改比对万份收益（per10k）；
4) 只刷新 orgShort 命中的产品，其余一律不动；
5) 老 TLS 站点（农银、信银）必须放开 unsafe legacy renegotiation 且 `trust_env=False`。

各家实测要点（2026-11-22 起）
-------------------------
农银：`findNetDiscProdList` 按整名搜索命中唯一（列表不带登记编码），
      `findNetOr7DaysList?type=NET|7DAYS` 给序列，15 条/页；净值型看 vluUnitNet，
      现金类看 7DAYS 的 vluPftTthou（万份收益）。匠心系列到 T-1，时时付类到 T 日。
信银：`fundList` 列表自带 nav/navDate，无名称过滤，需按 productType(1封闭/2每日购/4货币)
      全量索引一次；份额靠 `getTAProductNav` 的 productNavPic 与库内历史比对。
兴银：`productInfo/search` 自带 registerCode（登记编码精确匹配）+ `productVal/page` 给序列，
      100 条/页；现金类存在 dataDt 与 netvalDt 双写，一律取 dataDt 当净值日，避免虚报。
民生（2026-11-23 第二批）：`BTAProductQry` 按代码/名称搜索自带最新 NAV + NAV_DATE，
      `BTADailyQry` 按 FBAE… 份额代码给历史序列；同产品多份额（A/E/Q/S/B）净值微差，
      靠历史重叠点精确一致判定。库内民生 7 只实测均为 E 份额，其中现金类（天天盈）
      官网为 6 位小数且与库内口径不同，历史不匹配时按规则跳过，宁可滞后不串净值。
中邮（2026-11-27 第三批）：`pswm-api/product/search?pageNum=N` 是纯 GET 列表（439 页、
      每页固定 10 条），所有过滤参数都会被忽略，只能整表扫描；列表自带
      `wp_registration_code`（登记编码，精确匹配）+ `update_date`（净值日）+ `nav`。
      旧式 TLS 站点，必须走 S_LEGACY。11-27 实测库内 11 只中邮在官网也只到 11-25，
      属源端未披露，不能伪造；通道本身可用，官网先发时即可自动推进。
"""
import argparse
import json
import os
import re
import ssl
import sys
import time
from datetime import datetime, timedelta

import requests
import urllib3

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import nav_holdings_t1 as nlc  # noqa: E402
import nav_official as off  # noqa: E402  复用 apply()（latestDate 只进不退）
import promote_newproducts as promo  # noqa: E402

urllib3.disable_warnings()

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
TOL = 0.02          # 净值量级容差（2%），与 nav_official.NAME_TOLERANCE 同口径
PER_TOL = 0.02      # 万份收益容差（元/万份，两位小数的四舍五入噪声）
MIN_HITS = 3        # 份额判定：重叠点里至少 3 个精确一致
MIN_RATE = 0.8      # 份额判定：一致率下限


# ---------------- 通用 HTTP（含旧式 TLS 重协商兼容） ----------------
def _session(legacy):
    s = requests.Session()
    # 走系统代理会 502，直接绕开
    s.trust_env = False
    if legacy:
        ctx = urllib3.util.ssl_.create_urllib3_context()
        ctx.options |= getattr(ssl, "OP_LEGACY_SERVER_CONNECT", 0x4)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        try:
            ctx.set_ciphers("DEFAULT@SECLEVEL=1")
        except ssl.SSLError:
            pass
        pm = urllib3.PoolManager(ssl_context=ctx, num_pools=4, maxsize=10)

        class _Adapter(requests.adapters.HTTPAdapter):
            def init_poolmanager(self, *args, **kwargs):
                self.poolmanager = pm

        s.mount("https://", _Adapter())
    return s


S_LEGACY = _session(True)     # 农银、信银
S_PLAIN = _session(False)     # 兴银、民生


def _head(referer="", json_body=True):
    h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*",
         "Accept-Language": "zh-CN,zh;q=0.9"}
    if json_body:
        h["Content-Type"] = "application/json;charset=UTF-8"
    if referer:
        h["Referer"] = referer
    return h


def d8(v):
    """各种日期写法（20261120 / 2026-11-20 / 2026-11-20 00:00:00）→ YYYY-MM-DD。"""
    s = str(v or "").strip()
    if not s:
        return ""
    m = re.match(r"(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})", s)
    return "%s-%s-%s" % m.groups() if m else ""


def fnum(v):
    try:
        f = float(v)
        return f if f == f and abs(f) != float("inf") else None
    except (TypeError, ValueError):
        return None


def key(s):
    return nlc.name_key(s)


# ---------------- 农银理财 ----------------
ABC_LIST = ("https://www.abcwealth.com.cn/awpsservice/fpproduct/productyield/"
            "findNetDiscProdList?current=1")
ABC_SERIES = ("https://www.abcwealth.com.cn/awpsservice/fpproduct/productyield/"
              "findNetOr7DaysList")
ABC_REF = "https://www.abcwealth.com.cn/#/disclosure/netDisclosure"


def abc_search(name):
    r = S_LEGACY.post(ABC_LIST, json={"queryName": name},
                      headers=_head(ABC_REF), timeout=40, verify=False)
    r.raise_for_status()
    return ((r.json() or {}).get("data") or {}).get("records") or []


def abc_series(pid):
    """NET 给单位净值、7DAYS 给万份收益；按日期并成一条序列。"""
    by = {}
    for kind in ("NET", "7DAYS"):
        r = S_LEGACY.post(ABC_SERIES, params={"productId": pid, "type": kind, "current": 1},
                          json={}, headers=_head(ABC_REF), timeout=40, verify=False)
        r.raise_for_status()
        for it in ((r.json() or {}).get("data") or {}).get("records") or []:
            d = d8(it.get("dateNet"))
            if not d:
                continue
            row = by.setdefault(d, {"date": d, "nav": None, "per10k": None})
            nav = fnum(it.get("vluUnitNet"))
            per = fnum(it.get("vluPftTthou"))
            if nav is not None:
                row["nav"] = nav
            if per is not None and row["per10k"] is None:
                row["per10k"] = round(per, 2)
    rows = [r for r in by.values() if r["nav"] is not None]
    rows.sort(key=lambda x: x["date"])
    return rows


def abc_cands(x):
    hits = [r for r in abc_search(str(x.get("name") or ""))
            if key(r.get("namFull")) == key(x.get("name"))]
    out = []
    for h in hits[:4]:
        pid = h.get("idProduct")
        if not pid:
            continue
        out.append({"tag": "农银官网:%s" % pid, "rows": abc_series(pid)})
    return out, len(hits)


# ---------------- 信银理财 ----------------
CITIC_LIST = "https://wechat.citic-wealth.com/cms.product/api/custom/productInfo/fundList"
CITIC_NAV = ("https://wechat.citic-wealth.com/cms.product/api/custom/productInfo/"
             "getTAProductNav")
CITIC_REF = "https://wechat.citic-wealth.com/"
_CITIC_INDEX = None


def citic_index():
    """全量索引一次：name_key(prodName) → [列表记录]。1封闭 / 2每日购 / 4货币。"""
    global _CITIC_INDEX
    if _CITIC_INDEX is not None:
        return _CITIC_INDEX
    idx = {}
    for ptype in (2, 4, 1):
        page = 1
        while page <= 30:
            r = S_LEGACY.get(CITIC_LIST,
                             params={"pageNum": page, "pageSize": 200,
                                     "productType": ptype, "prodSaleCustom": 0},
                             headers=_head(CITIC_REF, json_body=False),
                             timeout=45, verify=False)
            r.raise_for_status()
            recs = ((r.json() or {}).get("data") or {}).get("records") or []
            for it in recs:
                idx.setdefault(key(it.get("prodName")), []).append(it)
            if len(recs) < 200:
                break
            page += 1
            time.sleep(0.2)
    _CITIC_INDEX = idx
    print("  信银全量索引 %d 个名称" % len(idx), flush=True)
    return idx


def citic_series(code):
    r = S_LEGACY.get(CITIC_NAV, params={"prodCode": code, "queryUnit": 1},
                     headers=_head(CITIC_REF, json_body=False), timeout=45, verify=False)
    r.raise_for_status()
    arr = ((r.json() or {}).get("data") or {}).get("productNavPic") or []
    rows = []
    for it in arr:
        d = d8(it.get("navDate"))
        nav = fnum(it.get("nav"))
        if not d or nav is None:
            continue
        per = fnum(it.get("tenThousandIncomeAmt"))
        rows.append({"date": d, "nav": nav,
                     "per10k": round(per, 2) if per is not None else None})
    rows.sort(key=lambda x: x["date"])
    return rows


def citic_cands(x):
    hits = citic_index().get(key(x.get("name"))) or []
    # 同一 productType 内多份额会重复出现，按 prodCode 去重
    codes = []
    for it in hits:
        c = it.get("prodCode")
        if c and c not in codes:
            codes.append(c)
    out = [{"tag": "信银官网:%s" % c, "rows": citic_series(c)} for c in codes[:6]]
    return out, len(hits)


# ---------------- 兴银理财 ----------------
CIB_SEARCH = "https://www.cibwm.com.cn/api/public/pc/productInfo/search"
CIB_VAL = "https://www.cibwm.com.cn/api/public/pc/productVal/page"
CIB_REF = "https://www.cibwm.com.cn/product/product-list"


def cib_search(name):
    r = S_PLAIN.post(CIB_SEARCH, json={"keyword": name, "pageNum": 1, "pageSize": 100},
                     headers=_head(CIB_REF), timeout=40, verify=False)
    r.raise_for_status()
    return ((r.json() or {}).get("data") or {}).get("list") or []


def cib_series(code):
    r = S_PLAIN.post(CIB_VAL,
                     json={"criteria": {"productCode": code, "startDate": "", "endDate": ""},
                           "page": {"pageNumber": 1, "pageSize": 100}},
                     headers=_head(CIB_REF), timeout=40, verify=False)
    r.raise_for_status()
    rows = []
    for it in ((r.json() or {}).get("data") or {}).get("list") or []:
        # 现金类会出现 dataDt=11-20 同时 netvalDt=11-21 的双写，取 dataDt 当净值日
        d = d8(it.get("dataDt")) or d8(it.get("netvalDt"))
        nav = fnum(it.get("effUnitNav"))
        if nav is None:
            nav = fnum(it.get("effIopv"))
        if not d or nav is None:
            continue
        rows.append({"date": d, "nav": nav, "per10k": None})
    rows.sort(key=lambda x: x["date"])
    return rows


def cib_cands(x):
    reg = str(x.get("regCode") or "")
    core = str(x.get("short") or x.get("name") or "")
    hits = cib_search(core)
    if reg:
        hits = [h for h in hits if str(h.get("registerCode") or "") == reg] or hits
    same = [h for h in hits if key(h.get("productName")) == key(x.get("name"))]
    pool = same or [h for h in hits if key(core) and key(core) in key(h.get("productName"))]
    codes = []
    for h in pool:
        c = h.get("productCode")
        if c and c not in codes:
            codes.append(c)
    out = [{"tag": "兴银官网:%s" % c, "rows": cib_series(c)} for c in codes[:6]]
    return out, len(pool)


# ---------------- 民生理财 ----------------
# 官网列表 BTAProductQry 按代码/名称搜索自带最新 NAV + NAV_DATE；
# 详情页 BTADailyQry 给历史序列（按 real_prd_code 即 FBAE… 份额代码）。
# 民生同一产品常有多个份额（A/E/Q/S/B…），净值微差，必须用历史重叠点精确判定份额。
# 库内民生 7 只实测均为 E 份额，用 short 名搜索即可精确命中唯一份额。
CMBC_QRY = "https://www.cmbcwm.com.cn/gw/po_web/BTAProductQry"
CMBC_DAILY = "https://www.cmbcwm.com.cn/gw/po_web/BTADailyQry"
CMBC_REF = "https://www.cmbcwm.com.cn/cmbcwm/grlc/index.html"


def cmbc_search(name):
    r = S_PLAIN.post(CMBC_QRY,
                     json={"prd_type": "0", "pageNo": 1, "pageSize": 50,
                           "code_or_name": name},
                     headers=_head(CMBC_REF), timeout=40, verify=False)
    r.raise_for_status()
    return ((r.json() or {}).get("list") or [])


def cmbc_series(code):
    r = S_PLAIN.post(CMBC_DAILY,
                     json={"chart_type": 1, "real_prd_code": code,
                           "begin_date": "", "end_date": "",
                           "pageNo": 1, "pageSize": 400},
                     headers=_head(CMBC_REF), timeout=40, verify=False)
    r.raise_for_status()
    rows = []
    for it in ((r.json() or {}).get("list") or []):
        d = d8(it.get("ISS_DATE"))
        nav = fnum(it.get("NAV"))
        if not d or nav is None:
            continue
        # 官网给 6 位小数（现金类如 1.002377），库内是 4 位小数（1.0022）。
        # 统一 round 到 4 位再并入/比对，避免精度差触发「份额不一致」误判；
        # 现金类历史重叠 21/23 一致，仍按现有 ≥80% 阈值由 pick_share 判定。
        rows.append({"date": d, "nav": round(nav, 4), "per10k": None})
    rows.sort(key=lambda x: x["date"])
    return rows


def cmbc_cands(x):
    core = str(x.get("short") or x.get("name") or "")
    hits = cmbc_search(core)
    # 名称归一严格匹配：库内「富竹固收28天持有期15号」→ 官网「…理财产品E」，
    # 用包含判断（官网名 = 简称 + 「理财产品」+ 份额后缀），并排除产品线不同的（纯债/固收）。
    same = [h for h in hits if key(core) and key(core) in key(h.get("PRD_NAME"))]
    pool = same or hits
    codes = []
    for h in pool:
        c = h.get("REAL_PRD_CODE")
        if c and c not in codes:
            codes.append(c)
    out = [{"tag": "民生官网:%s" % c, "rows": cmbc_series(c)} for c in codes[:8]]
    return out, len(pool)


# ---------------- 中邮理财（2026-11-27 第三批） ----------------
# 列表接口忽略所有过滤参数（keyword / wp_registration_code 均无效），只能整表扫描。
# 每页固定 10 条、共约 439 页，按 0.05s 间隔约 1 分钟；索引按登记编码精确匹配，
# 不依赖名称归一，也不存在份额歧义。
PSBC_SEARCH = "https://www.psbc-wm.com/pswm-api/product/search?pageNum={pg}"
PSBC_MAX_PAGES = 600
_PSBC_INDEX = None


def psbc_index():
    global _PSBC_INDEX
    if _PSBC_INDEX is not None:
        return _PSBC_INDEX
    idx = {}
    for pg in range(1, PSBC_MAX_PAGES + 1):
        try:
            r = S_LEGACY.get(PSBC_SEARCH.format(pg=pg), timeout=25, verify=False,
                             headers=_head("https://www.psbc-wm.com/products/index.html", False))
            r.raise_for_status()
            d = (r.json() or {}).get("data") or {}
        except Exception as exc:
            print("中邮列表第 %d 页失败：%s" % (pg, str(exc)[:80]), flush=True)
            break
        rows = d.get("list") or []
        for x in rows:
            reg = str(x.get("wp_registration_code") or "")
            dts = d8(x.get("update_date"))
            nav = fnum(x.get("nav"))
            if reg and dts and nav is not None:
                idx[reg] = (dts, nav, str(x.get("wp_name") or ""))
        if d.get("lastPage") or not rows:
            break
        time.sleep(0.05)
    _PSBC_INDEX = idx
    return idx


def psbc_cands(x):
    reg = str(x.get("regCode") or "")
    hit = psbc_index().get(reg)
    if not hit:
        return [], 0
    dts, nav, name = hit
    return [{"tag": "中邮官网:%s" % reg,
             "rows": [{"date": dts, "nav": nav, "per10k": None}]}], 1


SITES = [
    ("农银理财", abc_cands),
    ("信银理财", citic_cands),
    ("兴银理财", cib_cands),
    ("民生理财", cmbc_cands),
    ("中邮理财", psbc_cands),
]


# ---------------- 份额判定 ----------------
def merge(x, rows):
    """并入官网序列，并对「官网没有万份收益字段」的现金类做保护。

    兴银现金类只有单位净值（恒 1.0）、没有万份收益；off.apply() 在拿不到 pft 时会
    按前后净值差重算，现金类就会算成 0.00，把库里真实的万份收益覆盖掉。这里在合并后
    把「新值为 0/None 且旧值存在」的点回填成旧值，只推进日期与净值。
    """
    old_p = {d: p for d, p in zip(x.get("dates") or [], x.get("per10k") or [])
             if p is not None}
    changed, src = off.apply(x, rows)
    flat = rows and all(abs(r["nav"] - 1.0) < 1e-9 for r in rows)
    if flat and not any(r.get("per10k") for r in rows):
        x["per10k"] = [old_p.get(d) if (not p and d in old_p) else p
                       for d, p in zip(x["dates"], x["per10k"] or [])]
    return changed, src


def pick_share(x, cands):
    """多候选份额 → 用「历史重叠点精确一致」挑唯一一个。

    返回 (rows, tag, 说明)；无法判定返回 (None, None, 原因)。
    规则：净值型比对重叠日净值，现金型（净值恒 1.0）比对万份收益；
    最优者需 ≥MIN_HITS 个点一致且一致率 ≥MIN_RATE，否则视为不可信。
    """
    old = {d: v for d, v in zip(x.get("dates") or [], x.get("nav") or []) if v is not None}
    oldp = {d: v for d, v in zip(x.get("dates") or [], x.get("per10k") or [])
            if v is not None}
    scored = []
    for c in cands:
        rows = c["rows"]
        if not rows:
            continue
        flat = all(abs((r["nav"] or 1.0) - 1.0) < 1e-9 for r in rows)
        hit = tot = 0
        if flat and oldp:
            for r in rows:
                if r["date"] in oldp and r.get("per10k") is not None:
                    tot += 1
                    if abs(float(r["per10k"]) - float(oldp[r["date"]])) <= PER_TOL:
                        hit += 1
        else:
            for r in rows:
                if r["date"] in old:
                    tot += 1
                    if abs(float(r["nav"]) - float(old[r["date"]])) < 1e-6:
                        hit += 1
        rate = (hit / tot) if tot else 0.0
        scored.append((rate, hit, tot, c))

    if not scored:
        return None, None, "官网无序列"

    scored.sort(key=lambda s: (s[0], s[1]), reverse=True)
    rate, hit, tot, best = scored[0]

    if tot >= MIN_HITS and rate >= MIN_RATE:
        pass
    elif len(scored) == 1:
        # 单一候选：有重叠就按一致率放行；无重叠（新品）用量级校验
        if tot and rate >= MIN_RATE:
            pass
        elif not tot:
            last = x.get("latestNav")
            tail = best["rows"][-1]["nav"]
            if last and abs(tail - float(last)) / float(last) > TOL:
                return None, None, "无重叠且净值量级不符（%s vs %s）" % (tail, last)
        else:
            return None, None, "单一候选但一致率 %.0f%%（%d/%d）" % (rate * 100, hit, tot)
    else:
        return None, None, "多份额无法判定（最佳 %d/%d，次优 %d/%d）" % (
            hit, tot, scored[1][1], scored[1][2])
    return best["rows"], best["tag"], "一致 %d/%d" % (hit, tot)


def last_workday(now):
    """最近一个已过去的工作日（跳过周六周日）。

    周末跑批时「T-1」若按自然日算会落到周六，永远不可能达标，
    达标率会长期显示 0——这里统一退到最近工作日，与净值披露节奏对齐。
    """
    d = now.date() - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d.strftime("%Y-%m-%d")


def main():
    ap = argparse.ArgumentParser(description="农银/信银/兴银/民生 官网净值刷新产品库")
    ap.add_argument("--org", default="", help="只跑这些机构，逗号分隔，如 农银,兴银")
    ap.add_argument("--only-reg", default="", help="只跑指定登记编码，逗号分隔")
    ap.add_argument("--limit", type=int, default=0, help="最多处理多少只")
    ap.add_argument("--dry-run", action="store_true", help="只打印不写文件")
    a = ap.parse_args()

    want = [s.strip() for s in a.org.split(",") if s.strip()]
    regs = {s.strip() for s in a.only_reg.split(",") if s.strip()}

    lib = promo.load_json(promo.LIB_JSON, {"items": []})
    items = lib.get("items") or []
    if not items:
        print("产品库为空，退出", flush=True)
        return 1

    todo = []
    for x in items:
        org = str(x.get("orgShort") or "")
        site = next((s for s in SITES if org.startswith(s[0].rstrip("理财"))), None)
        if not site:
            continue
        if want and not any(org.startswith(w) for w in want):
            continue
        if regs and str(x.get("regCode") or "") not in regs:
            continue
        todo.append((x, site))
    if a.limit:
        todo = todo[: a.limit]
    if not todo:
        print("没有待刷新的产品（五家在库 %d 只）" % sum(
            1 for x in items if any((x.get("orgShort") or "").startswith(s[0].rstrip("理财"))
                                    for s in SITES)), flush=True)
        return 0

    print("待刷新 %d 只：%s" % (len(todo), ", ".join(
        "%s %s" % (x.get("short") or x.get("regCode"), org)
        for (x, (org, _)) in todo[:6])), flush=True)

    ok = adv = skipped = 0
    t1 = last_workday(datetime.now(nlc.CN))
    lagging, rejects = [], []
    for i, (x, (org, fetch)) in enumerate(todo, 1):
        reg = str(x.get("regCode") or "")
        old = x.get("latestDate") or ""
        tag = "%s %s" % (org, x.get("short") or reg)
        try:
            cands, nraw = fetch(x)
        except Exception as exc:
            print("[%d/%d] %s 抓取失败：%s" % (i, len(todo), tag, str(exc)[:100]), flush=True)
            skipped += 1
            continue
        if not cands:
            rejects.append((tag, "官网未匹配到产品（搜索命中 %d）" % nraw))
            skipped += 1
            continue
        rows, src, note = pick_share(x, cands)
        if not rows:
            rejects.append((tag, note))
            skipped += 1
            continue
        changed, used = merge(x, rows)
        if x.get("latestDate") and old and x["latestDate"] < old:
            raise SystemExit("严重异常：%s latestDate 回退 %s -> %s" % (reg, old, x["latestDate"]))
        ok += 1
        if x["latestDate"] > old:
            adv += 1
            print("[%d/%d] %s %s → %s  [%s｜%s]%s" % (
                i, len(todo), tag, old or "-", x["latestDate"], src or "官网", note,
                "" if changed else "（同值）"), flush=True)
        if x["latestDate"] < t1:
            lagging.append((tag, x["latestDate"], src or "官网"))

    print("\n=== 处理 %d 只：成功 %d、推进 %d、跳过 %d；T-1(%s) 达标 %d/%d ===" % (
        len(todo), ok, adv, skipped, t1, ok - len(lagging), ok), flush=True)
    for tag, d, s in sorted(lagging, key=lambda r: r[1])[:15]:
        print("  [滞后] %-42s %s  %s" % (tag, d, s), flush=True)
    for tag, why in rejects[:15]:
        print("  [未采纳] %-40s %s" % (tag, why), flush=True)

    asof = max((x.get("latestDate") or "") for x in items) or ""
    if a.dry_run:
        print("DRY-RUN：未写文件，产品库最新净值日 %s" % asof, flush=True)
        return 0
    if not changed_any(items, todo):
        print("无变化，未写文件（产品库最新净值日 %s）" % asof, flush=True)
        return 0
    promo.save(items)
    print("完成：产品库最新净值日 %s" % asof, flush=True)
    off.commit([promo.LIB_JS, promo.LIB_JSON],
               "data: 农银/信银/兴银/民生/中邮官网刷新产品库净值 %s" % asof)
    return 0


def changed_any(items, todo):
    """真实落盘前判断：任一产品 latestDate 或净值发生变化。"""
    base = promo.load_json(promo.LIB_JSON, {"items": []}).get("items") or []
    old = {str(x.get("regCode") or ""): (x.get("latestDate"), x.get("latestNav")) for x in base}
    for x in items:
        k = str(x.get("regCode") or "")
        if k in old and old[k] != (x.get("latestDate"), x.get("latestNav")):
            return True
    return False


if __name__ == "__main__":
    sys.exit(main())
