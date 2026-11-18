"""持仓产品 T-1 净值攻坚（持仓优先 + 多路径兜底）。

背景：盈亏汇总里的持仓产品（交易记录中所有 pid）净值一度停在 T-5，
根因是旧轮换脚本只走中国理财网（T+N 时滞）且只认 data.js 的 4 只持仓。
本脚本按「真实持仓清单优先」实时抓取，能用多路径取到 T-1 就取：

  路径 1a 建行官网 NLC165 精确渠道代码 ECD（IvsmPd_ECD）——最可靠，
         凭 reg_alias.json「登记编码 -> ECD」映射，跨渠道改名/加前后缀仍能精确命中；
         解决「南极星/（代销）/（数字人民币专享）」等名称写法不一致导致的匹配失败；
  路径 1b 建行官网 NLC165 产品全名归一匹配（含 contains 兜底）——覆盖大多数持仓；
  路径 2  中邮理财官网列表（psbc-wm.com，返回 Z7 登记编码 + 最新净值 + 日期）——
         按需（--psbc-pages）补 NLC165 未命中的中邮产品；
  路径 3  建信理财官网 chart（wealthccb.com，凭 ccb_map.json 的 ecd）——
         补建信系产品历史净值序列；
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


def name_key(s):
    """产品名归一：去标点/空格/代销字样，用于精确匹配。"""
    out = "".join(ch for ch in str(s or "") if ch not in _DROP)
    return out.replace("代销", "")


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
    if not per:
        per.append(None)
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
    print("  NLC165 有效净值 %d 只（名称 %d / ECD %d）" %
          (len(nlc_by_name), len(nlc_by_name), len(nlc_by_ecd)), flush=True)
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
