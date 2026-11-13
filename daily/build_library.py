"""产品库扩容：抓取 2026-08-01 后成立的产品，补齐真实净值，写入 assets/library.js。

链路：建行新品公告（回溯到 8 月初）→ 标题预筛 → 说明书 PDF 解析要素表
      → 成立日 ∈ [2026-08-01, 今天) → 中国理财网按登记编码抓净值 → 生成前端数据。
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import fetch_newproducts as NP  # noqa: E402
import sources  # noqa: E402
from fetch_newproducts import (  # noqa: E402
    CACHE, Rules, bank_short, clean_name, crawl_notices, extract_dates, extract_manager,
    extract_quota, is_candidate, norm_date, process_url,
)

OUT_JS = os.path.join(ROOT, "assets", "library.js")
OUT_JSON = os.path.join(HERE, "library.json")
CAND_JSON = os.path.join(HERE, "library_candidates.json")
LIB_START = "2026-08-01"
RISK_MAP = {"01": "R1", "02": "R2", "03": "R3", "04": "R4", "05": "R5"}


def collect(a):
    today = datetime.now().strftime("%Y-%m-%d")
    print("== 抓取建行新品公告（最近 %d 天，含 8 月至今）" % a.days, flush=True)
    notices = crawl_notices(a.days, max_pages=a.max_pages)
    notices.sort(key=lambda n: n["date"])
    cand = [n for n in notices if is_candidate(n["title"])]
    print("公告 %d 条，开放式预筛后 %d 条" % (len(notices), len(cand)), flush=True)

    # 均匀取样，覆盖 8 月至今各个时间段
    if len(cand) > a.limit:
        step = len(cand) / float(a.limit)
        cand = [cand[int(i * step)] for i in range(a.limit)]
    print("本次解析 %d 条公告" % len(cand), flush=True)

    R = Rules()
    recs = []
    for i, n in enumerate(cand, 1):
        print("[%d/%d] %s" % (i, len(cand), n["title"][:38]), flush=True)
        try:
            recs.extend(process_url(n["url"], CACHE, a.gap, R))
        except Exception as exc:
            print("  ! 失败：%s" % str(exc)[:140], flush=True)

    out, seen = [], set()
    for r in recs:
        nid = str(r.get("公告ID") or "")
        p_txt = os.path.join(CACHE, nid + ".txt")
        flat = ""
        if nid and os.path.exists(p_txt):
            flat = re.sub(r"\s+", " ", open(p_txt, encoding="utf-8", errors="ignore").read())
        if not flat:
            continue
        start, end, est = extract_dates(flat)
        start = start or norm_date(r.get("募集起始日期"))
        end = end or norm_date(r.get("募集结束日期"))
        est = est or norm_date(r.get("成立日"))
        if not (LIB_START <= est < today):
            continue
        issuer = extract_manager(flat, R) or (r.get("产品管理人") or "").strip()
        name = re.sub(r"^[（(][^）)]{2,12}[）)]", "", (r.get("产品名称") or "").strip())
        reg = (r.get("登记编码") or "").strip()
        if not issuer or not name or not reg:
            continue
        if not R.in_whitelist(issuer):
            continue
        if not R.is_cny({"产品名称": name, "募集币种": r.get("投资及收益币种") or ""}):
            continue
        mode = r.get("产品运作模式") or ""
        if mode and not R.is_open({"运作模式": mode}):
            continue
        if reg in seen:
            continue
        seen.add(reg)
        out.append({
            "name": name,
            "issuer": issuer,
            "short": clean_name(name),
            "regCode": reg,
            "raiseStart": start,
            "raiseEnd": end,
            "establish": est,
            "quotaWan": extract_quota(flat),
            "risk": (r.get("风险等级_R级") or "").upper(),
            "mode": mode,
            "saleChannel": bank_short(r.get("产品销售机构_简称") or "") or "建设银行",
        })
    out.sort(key=lambda x: x["establish"], reverse=True)
    print("成立日 ∈ [%s, %s) 且去重后 %d 条" % (LIB_START, today, len(out)), flush=True)
    with open(CAND_JSON, "w", encoding="utf-8") as f:
        json.dump({"fetchedAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
                   "items": out}, f, ensure_ascii=False, indent=2)
    return out


def fill_nav(items, limit, delay):
    """逐只走独立进程抓净值（每次重新换取访问许可，避免连续请求触发人机验证）。"""
    kept = []
    pool = sorted(items, key=lambda x: x["establish"])[:limit]
    for i, it in enumerate(pool, 1):
        print("[%d/%d] %s %s" % (i, len(pool), it["regCode"], it["short"][:24]), flush=True)
        rows = []
        for attempt in range(1, 4):
            try:
                rows = sources.fetch("chinawealth", {"regCode": it["regCode"], "shareCode": ""},
                                     "2000-01-01", "2100-01-01")
                break
            except Exception as exc:
                print("  ! 第 %d 次失败：%s" % (attempt, str(exc)[:100]), flush=True)
                time.sleep(8 * attempt)
        rows = [r for r in rows if r.get("date") and r.get("nav")]
        if len(rows) < 3:
            print("  ! 净值记录不足（%d 条）" % len(rows), flush=True)
            time.sleep(delay)
            continue
        dates = [r["date"] for r in rows]
        nav = [round(float(r["nav"]), 6) for r in rows]
        per10k = [None]
        for k in range(1, len(nav)):
            per10k.append(round((nav[k] - nav[k - 1]) * 10000, 2))
        kept.append({
            "id": "L" + it["regCode"],
            "name": it["name"],
            "short": it["short"],
            "org": it["issuer"],
            "orgShort": _org_short(it["issuer"]),
            "regCode": it["regCode"],
            "risk": it["risk"],
            "saleChannel": it["saleChannel"],
            "inception": it["establish"],
            "raiseStart": it["raiseStart"],
            "raiseEnd": it["raiseEnd"],
            "dates": dates,
            "nav": nav,
            "per10k": per10k,
            "latestDate": dates[-1],
            "latestNav": nav[-1],
        })
        print("  OK %d 条 %s ~ %s" % (len(dates), dates[0], dates[-1]), flush=True)
        _save(kept)  # 边抓边落盘，限流中断也能保留已抓到的产品
        time.sleep(delay)
    kept.sort(key=lambda x: x["inception"], reverse=True)
    return kept


def _save(kept):
    """增量落盘：新抓到的产品合并进现有产品库，不能覆盖已有产品。"""
    import promote_newproducts as promo
    old = promo.load_json(promo.LIB_JSON, {"items": []}).get("items") or []
    seen = {str(x.get("regCode")) for x in kept}
    merged = kept + [x for x in old if str(x.get("regCode")) not in seen]
    promo.save(merged)
    return merged


def _org_short(issuer):
    s = issuer.replace("有限责任公司", "").replace("股份有限公司", "").replace("有限公司", "")
    return s or issuer


def main():
    ap = argparse.ArgumentParser(description="产品库扩容（8.1 后成立）")
    ap.add_argument("--days", type=int, default=112)
    ap.add_argument("--max-pages", type=int, default=430)
    ap.add_argument("--limit", type=int, default=90, help="解析公告条数")
    ap.add_argument("--gap", type=float, default=0.6)
    ap.add_argument("--nav-limit", type=int, default=60, help="抓取净值的条数")
    ap.add_argument("--nav-delay", type=float, default=1.2)
    ap.add_argument("--from-cache", action="store_true", help="复用 library_candidates.json，跳过公告抓取")
    a = ap.parse_args()

    if a.from_cache and os.path.exists(CAND_JSON):
        items = (json.load(open(CAND_JSON, encoding="utf-8")) or {}).get("items") or []
        print("复用候选池 %d 条" % len(items), flush=True)
    else:
        items = collect(a)
    if not items:
        print("没有符合条件的产品，保留原有 library.js")
        return 1
    kept = fill_nav(items, a.nav_limit, a.nav_delay)
    if not kept:
        print("本次没有新增净值完整的产品，产品库保持不变")
        return 0

    _save(kept)
    print("完成：候选 %d → 入库 %d 款，覆盖 %d 家机构"
          % (len(items), len(kept), len({x["org"] for x in kept})))
    return 0


if __name__ == "__main__":
    sys.exit(main())
