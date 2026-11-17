"""产品库补漏：按登记编码或产品名称，把遗漏的产品主动抓入产品库。

背景：产品库（library.json）长期只靠「建行新品公告 → 销售文件要素表 PDF」单链路入库，
覆盖不全——部分已存续产品（如中银理财-悦享天添24号 Z7001026001506）虽在建行代销、
有公开净值，但从未出现在新品公告窗口内，导致产品库漏收，只能靠用户手工添加。

本工具补上「按登记编码/名称主动补漏」通道：
  1) 给 --reg 直接用；给 --name 时按名称在中国理财网反查登记编码（精确匹配优先）；
  2) 中国理财网按登记编码抓全量历史净值（nav_bulk）；
  3) 若 daily/reg_alias.json 里配了该产品的建行官网 ECD，再用官网最新点补进序列
     （官网披露通常早于理财网，遵守「官网优先、理财网兜底」规则）；
  4) 产品主档（成立日/风险/机构/份额）取自中国理财网详情接口；
  5) 幂等入库：已存在则按日期合并净值（只加更新点、不回退），不存在则新增。

用法：
  python daily/backfill_byname.py --name 中银理财-悦享天添24号
  python daily/backfill_byname.py --reg Z7001026001506
  python daily/backfill_byname.py --reg Z7001026001506 --dry-run
"""
import argparse
import json
import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import nav_bulk  # noqa: E402

LIB_JSON = os.path.join(HERE, "library.json")
LIB_JS = os.path.join(ROOT, "assets", "library.js")
REG_ALIAS = os.path.join(HERE, "reg_alias.json")
RISK_MAP = {"01": "R1", "02": "R2", "03": "R3", "04": "R4", "05": "R5"}


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f) or default


def resolve_reg(name):
    """按产品名称在中国理财网反查登记编码，精确匹配优先。"""
    data = nav_bulk._call(lambda: nav_bulk.client().search_products(name=name, page=1, size=20)) or {}
    items = data.get("list") or []
    if not items:
        return "", {}
    exact = [it for it in items if (it.get("prodName") or "").strip() == name.strip()]
    it = exact[0] if exact else items[0]
    return str(it.get("prodRegCode") or "").strip(), it


def detail(reg):
    """产品详情：成立日 / 风险 / 机构 / 运作模式。失败返回空字典，不影响主流程。"""
    try:
        data = nav_bulk._call(lambda: nav_bulk.client()._request(
            "/product/getProductDetail", {"prodRegCode": reg})) or {}
    except Exception:
        return {}
    basic = data.get("prodBasicInfoVo") or {}
    return {
        "inception": str(basic.get("prodSdate") or "").replace("/", "-"),
        "risk": RISK_MAP.get(str(basic.get("prodRiskLevel") or ""), ""),
        "org": basic.get("orgName") or "",
        "operateMode": basic.get("prodOperateModeName") or "",
        "investNature": basic.get("prodInvestNatureName") or "",
        "currency": basic.get("collCcyName") or "",
        "prodName": basic.get("prodName") or "",
    }


def alias_for(reg, aliases):
    return aliases.get(str(reg)) or {}


def fetch_official_history(alias):
    """官网优先抓历史：中银理财按份额代码走 bocwm，返回 (rows, source)。"""
    share = alias.get("share") or ""
    issuer = alias.get("issuer") or ""
    if share:
        try:
            import sources
            if "中银" in issuer or share.upper().startswith("YX"):
                rows = sources.fetch("boc", {"productCode": share}, "2020-01-01", "2100-01-01")
                if rows:
                    return [{"date": r["date"], "nav": float(r["nav"])} for r in rows], "中银官网"
        except Exception as exc:
            print("  ! 中银官网抓取失败：%s" % str(exc)[:100], flush=True)
    return [], ""


def nlc_latest(ecd):
    """建行官网 ECD 精确取最新 (date, nav)；只给一点，用作官网优先补丁。"""
    if not ecd:
        return None
    try:
        import nav_holdings_t1 as nh
        _, by_ecd = nh.pull_nlc165(0.05)
        return by_ecd.get(ecd)
    except Exception as exc:
        print("  ! 建行官网抓取失败：%s" % str(exc)[:100], flush=True)
        return None


def merge_points(base_rows, official_point):
    """把官网最新点并入理财网历史序列：同日以官网为准，新增日追加，不回退。"""
    rows = [{"date": r["date"], "nav": float(r["nav"])} for r in base_rows if r.get("date") and r.get("nav")]
    if official_point and official_point[0] and official_point[1]:
        d, v = official_point[0], float(official_point[1])
        rows = [r for r in rows if r["date"] != d]
        rows.append({"date": d, "nav": v})
    dedup = {}
    for r in rows:
        dedup[r["date"]] = r["nav"]
    return [{"date": k, "nav": dedup[k]} for k in sorted(dedup)]


def to_item(reg, meta, det, rows):
    dates = [r["date"] for r in rows]
    nav = [round(r["nav"], 6) for r in rows]
    per10k = [None]
    for k in range(1, len(nav)):
        per10k.append(round((nav[k] - nav[k - 1]) * 10000, 2))
    org = det.get("org") or "中银理财有限责任公司"
    org_short = org.replace("有限责任公司", "").replace("股份有限公司", "").replace("有限公司", "")
    name = det.get("prodName") or meta.get("name") or ""
    short = name
    for kw in ("中银理财-", "中银理财", "理财产品"):
        short = short.replace(kw, "")
    return {
        "id": "L" + reg,
        "name": name,
        "short": short,
        "org": org,
        "orgShort": org_short,
        "regCode": reg,
        "risk": det.get("risk") or meta.get("risk") or "",
        "saleChannel": "",
        "inception": det.get("inception") or "",
        "raiseStart": "",
        "raiseEnd": "",
        "dates": dates,
        "nav": nav,
        "per10k": per10k,
        "latestDate": dates[-1] if dates else "",
        "latestNav": nav[-1] if nav else None,
        "backfilledAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def save(items):
    items.sort(key=lambda x: x.get("inception") or "", reverse=True)
    asof = max((x.get("latestDate") or "") for x in items) or datetime.now().strftime("%Y-%m-%d")
    payload = {
        "asOf": asof,
        "fetchedAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": "建行新品公告·销售文件要素表 + 中国理财网净值 + 官网补漏",
        "window": {"start": "2026-08-01", "end": asof},
        "items": items,
    }
    with open(LIB_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    with open(LIB_JS, "w", encoding="utf-8") as f:
        f.write("window.PRODUCT_LIBRARY = " + json.dumps(payload, ensure_ascii=False) + ";\n")


def main():
    ap = argparse.ArgumentParser(description="产品库按登记编码/名称补漏")
    ap.add_argument("--reg", default="", help="登记编码（Z7）")
    ap.add_argument("--name", default="", help="产品名称（按名称反查登记编码）")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写产品库")
    ap.add_argument("--no-nlc", action="store_true", help="不补建行官网最新点")
    ap.add_argument("--delay", type=float, default=3.0, help="理财网请求间隔秒（限流时可加大）")
    a = ap.parse_args()

    nav_bulk.client(delay=a.delay)  # 限流窗口下放慢请求，降低触发人机验证概率

    reg = a.reg.strip()
    if not reg and a.name.strip():
        print("按名称反查登记编码：%s" % a.name, flush=True)
        reg, hit = resolve_reg(a.name.strip())
        print("  -> %s (%s)" % (reg, hit.get("prodName", "")), flush=True)
    if not reg:
        raise SystemExit("必须提供 --reg 或 --name")

    aliases = load_json(REG_ALIAS, {}).get("aliases", {})
    alias = alias_for(reg, aliases)
    meta, det = {}, {}

    # 官网优先：中银等有份额代码的先走官网，避免理财网限流
    rows, src = fetch_official_history(alias)
    print("官网(%s)净值 %d 条，最新 %s" % (src or "-", len(rows), rows[-1] if rows else "-"), flush=True)

    # 理财网兜底：官网没抓到才用（限流时跳过不影响主流程）
    if not rows:
        try:
            meta = nav_bulk.product_meta(reg) or {}
            rows, _ = nav_bulk.fetch(reg)
            print("理财网净值 %d 条，最新 %s" % (len(rows), rows[-1] if rows else "-"), flush=True)
        except Exception as exc:
            print("  ! 理财网兜底失败（限流/验证）：%s，继续用官网数据" % str(exc)[:100], flush=True)
    # 详情仅用于补主档字段（成立日/风险/机构），失败也能用别名里的名称入库
    if not det:
        try:
            det = detail(reg)
        except Exception:
            det = {}
    if not det.get("prodName"):
        det["prodName"] = alias.get("name") or meta.get("name") or ""

    # 建行官网 ECD 补最新点（官网披露常早于理财公司官网）
    ecd = alias.get("ecd") or ""
    pt = None if a.no_nlc else nlc_latest(ecd)
    if pt:
        print("建行官网 ECD=%s 最新 %s %s" % (ecd, pt[0], pt[1]), flush=True)
    rows = merge_points(rows, pt)
    item = to_item(reg, meta, det, rows)
    print("入库记录：%s | %s | %s | %s | %s | 净值 %d 条 最新 %s %s" % (
        item["id"], item["short"], item["risk"], item["inception"],
        item["orgShort"], len(rows), item["latestDate"], item["latestNav"]), flush=True)

    if a.dry_run:
        print("DRY-RUN：未写产品库", flush=True)
        return 0

    lib = load_json(LIB_JSON, {"items": []})
    items = lib.get("items") or []
    idx = next((i for i, x in enumerate(items) if str(x.get("regCode") or "") == reg), -1)
    if idx >= 0:
        old = items[idx]
        # 合并：以新抓序列为准覆盖（已含官网最新点），保留原有的手工补充字段
        old.update({k: item[k] for k in ("dates", "nav", "per10k", "latestDate", "latestNav")})
        for k in ("name", "short", "org", "orgShort", "risk", "inception", "backfilledAt"):
            if item.get(k):
                old[k] = item[k]
        print("已存在，更新净值序列与主档", flush=True)
    else:
        items.append(item)
        print("新产品，已加入产品库", flush=True)
    save(items)
    print("产品库共 %d 只，已写回 library.json / library.js" % len(items), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
