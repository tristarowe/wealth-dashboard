"""产品库查漏补缺：把候选清单中尚未入库的产品补抓净值后并入。

口径：成立日 ∈ [2026-08-01, 今天)、开放式、人民币、建行代销（候选清单已过滤）。
净值：中国理财网；不足 2 条先占位，后续每日由 promote_newproducts.py 自动补齐。
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from promote_newproducts import fetch_nav, save, meta_risk  # noqa: E402

CAND_JSON = os.path.join(HERE, "library_candidates.json")
LIB_JSON = os.path.join(HERE, "library.json")
LIB_START = "2026-08-01"

BANK_SHORT = {
    "中国建设银行": "建设银行", "中国工商银行": "工商银行", "中国农业银行": "农业银行",
    "中国邮政储蓄银行": "邮储银行", "中国民生银行": "民生银行", "中国光大银行": "光大银行",
    "中国华夏银行": "华夏银行", "上海浦东发展银行": "浦发银行", "浦东发展银行": "浦发银行",
    "中国平安银行": "平安银行", "中国兴业银行": "兴业银行", "中国中信银行": "中信银行",
    "中国招商银行": "招商银行", "中国广发银行": "广发银行", "中国渤海银行": "渤海银行",
    "中国浙商银行": "浙商银行", "中国恒丰银行": "恒丰银行",
}


def _org_short(issuer):
    s = issuer.replace("有限责任公司", "").replace("股份有限公司", "").replace("有限公司", "")
    return s or issuer


def bank_short(name):
    s = re.sub(r"(股份有限公司|有限责任公司|有限公司)$", "", (name or "").strip()).strip()
    if s in BANK_SHORT:
        return BANK_SHORT[s]
    if s.startswith("中国") and s.endswith("银行") and len(s) > 5:
        return s[2:]
    return s


def clean_channels(raw):
    parts = [p.strip() for p in re.split(r"[；;/,，]", raw or "") if p.strip()]
    out = []
    for p in parts:
        short = bank_short(p)
        if not short.endswith("银行") or "理财" in short:
            continue
        if short not in out:
            out.append(short)
    return "；".join(out)


def clean_short(name):
    s = (name or "").strip().lstrip("为").lstrip("【[").rstrip("】]").strip()
    s = re.sub(r"^[（(][^）)]{2,12}[）)]", "", s).strip()
    s = re.sub(r"^[\u4e00-\u9fa5]{2,8}理财[·\-－—]?", "", s)
    s = re.sub(r"(固定收益类|混合类|权益类|商品及金融衍生品类|理财产品)", "", s)
    return s.strip() or (name or "")


def main():
    ap = argparse.ArgumentParser(description="产品库查漏补缺")
    ap.add_argument("--today", default=datetime.now().strftime("%Y-%m-%d"))
    ap.add_argument("--max", type=int, default=40, help="单次最多补入条数")
    ap.add_argument("--gap", type=float, default=1.2)
    ap.add_argument("--no-nav", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    cand = json.load(open(CAND_JSON, encoding="utf-8"))["items"]
    lib = json.load(open(LIB_JSON, encoding="utf-8"))
    items = lib.get("items") or []
    have = {x["regCode"] for x in items}

    miss, seen = [], set()
    for c in cand:
        reg = (c.get("regCode") or "").strip()
        est = c.get("establish") or ""
        if not reg or reg in have or reg in seen:
            continue
        if not (LIB_START <= est < a.today):
            continue
        seen.add(reg)
        miss.append(c)
    miss.sort(key=lambda x: x["establish"], reverse=True)
    print("候选 %d 只 | 产品库 %d 只 | 待补 %d 只" % (len(cand), len(items), len(miss)), flush=True)
    if a.dry_run:
        for m in miss:
            print("  ", m["establish"], m["regCode"], clean_short(m["name"]), m.get("saleChannel"))
        return 0

    added = 0
    for i, m in enumerate(miss[: a.max], 1):
        rows = [] if a.no_nav else fetch_nav(m["regCode"])
        dates = [r["date"] for r in rows]
        nav = [round(float(r["nav"]), 6) for r in rows]
        per10k = [None]
        for k in range(1, len(nav)):
            per10k.append(round((nav[k] - nav[k - 1]) * 10000, 2))
        items.append({
            "id": "L" + m["regCode"],
            "name": m["name"],
            "short": clean_short(m["name"]),
            "org": m["issuer"],
            "orgShort": _org_short(m["issuer"]),
            "regCode": m["regCode"],
            "risk": (m.get("risk") or "").upper() or meta_risk(m["regCode"]),
            "saleChannel": clean_channels(m.get("saleChannel") or "") or "建设银行",
            "inception": m["establish"],
            "raiseStart": m.get("raiseStart") or "",
            "raiseEnd": m.get("raiseEnd") or "",
            "dates": dates,
            "nav": nav,
            "per10k": per10k,
            "latestDate": dates[-1] if dates else "",
            "latestNav": nav[-1] if nav else None,
        })
        added += 1
        print("[%d] %s %s 净值 %d 条" % (added, m["regCode"], clean_short(m["name"])[:24], len(rows)), flush=True)
        save(items)
        if not a.no_nav:
            time.sleep(a.gap)
    print("补入 %d 只，产品库现有 %d 只" % (added, len(items)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
