"""新品成立后自动并入产品库（幂等）。

规则：
- 来源：daily/newproducts.json 的 items + established（已成立清单）
- 触发：成立日 <= 今天，且登记编码不在 daily/library.json 中
- 净值：中国理财网按登记编码补抓；当天成立的通常尚无净值，先占位入库，
        后续每日运行本脚本会自动为「净值不足 2 条」的记录补抓
- 输出：daily/library.json 与 assets/library.js（结构与 build_library 一致）
"""
import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import sources  # noqa: E402

LIB_START = "2026-08-01"


def _org_short(issuer):
    s = issuer.replace("有限责任公司", "").replace("股份有限公司", "").replace("有限公司", "")
    return s or issuer

NP_JSON = os.path.join(HERE, "newproducts.json")
LIB_JSON = os.path.join(HERE, "library.json")
LIB_JS = os.path.join(ROOT, "assets", "library.js")


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f) or default


def fetch_nav(reg, tries=3):
    """优先走「产品列表 + 净值列表」接口，详情接口在高频查询时会返回人机验证。"""
    try:
        import nav_bulk
        rows, meta = nav_bulk.fetch(reg)
        if rows or meta:
            # 主档存在但无净值记录 = 尚未披露，不再回退详情接口（该接口限频更严）
            return rows
    except Exception as exc:
        msg = str(exc)[:110]
        print("  ! 列表接口抓取失败：%s" % msg, flush=True)
        if "验证" in msg:
            return []
    for attempt in range(1, tries + 1):
        try:
            rows = sources.fetch("chinawealth", {"regCode": reg, "shareCode": ""},
                                 "2000-01-01", "2100-01-01")
            return [r for r in rows if r.get("date") and r.get("nav")]
        except Exception as exc:
            msg = str(exc)[:110]
            print("  ! 第 %d 次净值抓取失败：%s" % (attempt, msg), flush=True)
            # 未披露或触发限频时不做重试，避免加重限流（合规边界：不限频绕过）
            if "未查询到净值记录" in msg or "人机验证" in msg:
                return []
            time.sleep(6 * attempt)
    return []


def meta_risk(reg):
    """列表接口顺带返回的风险等级（仅用于补空值）。"""
    try:
        import nav_bulk
        meta = nav_bulk.LAST_META.get(reg) or {}
        return meta.get("risk") or ""
    except Exception:
        return ""


def to_item(p, rows):
    dates = [r["date"] for r in rows]
    nav = [round(float(r["nav"]), 6) for r in rows]
    per10k = [None]
    for k in range(1, len(nav)):
        per10k.append(round((nav[k] - nav[k - 1]) * 10000, 2))
    issuer = p.get("issuer") or p.get("org") or ""
    return {
        "id": "L" + p["regCode"],
        "name": p.get("name") or "",
        "short": p.get("short") or p.get("name") or "",
        "org": issuer,
        "orgShort": p.get("orgShort") or _org_short(issuer),
        "regCode": p["regCode"],
        "risk": (p.get("risk") or "").upper() or meta_risk(p["regCode"]),
        "saleChannel": p.get("saleChannel") or "",
        "inception": p.get("establish") or p.get("inception") or "",
        "raiseStart": p.get("raiseStart") or "",
        "raiseEnd": p.get("raiseEnd") or "",
        "dates": dates,
        "nav": nav,
        "per10k": per10k,
        "latestDate": dates[-1] if dates else "",
        "latestNav": nav[-1] if nav else None,
    }


def save(items):
    items.sort(key=lambda x: x.get("inception") or "", reverse=True)
    asof = max((x.get("latestDate") or "") for x in items) or datetime.now().strftime("%Y-%m-%d")
    payload = {
        "asOf": asof,
        "fetchedAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": "建行新品公告·销售文件要素表 + 中国理财网净值",
        "window": {"start": LIB_START, "end": asof},
        "items": items,
    }
    with open(LIB_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    with open(LIB_JS, "w", encoding="utf-8") as f:
        f.write("window.PRODUCT_LIBRARY = " + json.dumps(payload, ensure_ascii=False) + ";\n")


def commit_in_ci():
    """GitHub Actions 中自动提交产品库变更（工作流只提交净值文件，这里补齐）。"""
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    files = [LIB_JS, LIB_JSON, NP_JSON, os.path.join(ROOT, "assets", "newproducts.js")]
    try:
        subprocess.run(["git", "add"] + files, check=False, timeout=120)
        diff = subprocess.run(["git", "diff", "--cached", "--quiet"], check=False)
        if diff.returncode == 0:
            return
        subprocess.run(["git", "-c", "user.name=github-actions[bot]",
                        "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                        "commit", "-m", "data: 新品成立后并入产品库"], check=False, timeout=120)
        subprocess.run(["git", "push"], check=False, timeout=180)
        print("已在 CI 中提交产品库变更", flush=True)
    except Exception as exc:
        print("CI 提交产品库变更失败：%s" % exc, flush=True)


def main():
    ap = argparse.ArgumentParser(description="新品成立后并入产品库")
    ap.add_argument("--today", default=datetime.now().strftime("%Y-%m-%d"))
    ap.add_argument("--no-nav", action="store_true", help="只入库不抓净值")
    ap.add_argument("--gap", type=float, default=1.2)
    ap.add_argument("--max-new", type=int, default=20, help="单次最多并入条数")
    ap.add_argument("--max-pending", type=int, default=20, help="单次最多补净值的占位产品数")
    a = ap.parse_args()

    np = load_json(NP_JSON, {})
    lib = load_json(LIB_JSON, {"items": []})
    items = lib.get("items") or []

    have = {str(x.get("regCode") or "") for x in items}
    pool = list(np.get("items") or []) + list(np.get("established") or [])

    cand, seen = [], set()
    for p in pool:
        reg = str(p.get("regCode") or "").strip()
        est = p.get("establish") or ""
        if not reg or reg in have or reg in seen:
            continue
        if not est or est > a.today or est < LIB_START:
            continue
        seen.add(reg)
        cand.append(p)
    cand.sort(key=lambda p: p.get("establish") or "")
    cand = cand[: a.max_new]
    print("待并入产品库 %d 只（成立日 <= %s）" % (len(cand), a.today), flush=True)

    added = 0
    for i, p in enumerate(cand, 1):
        print("[%d/%d] %s %s" % (i, len(cand), p["regCode"], (p.get("short") or "")[:24]), flush=True)
        rows = [] if a.no_nav else fetch_nav(p["regCode"])
        items.append(to_item(p, rows))
        added += 1
        print("  %s" % ("净值 %d 条" % len(rows) if rows else "暂无净值，先占位入库"), flush=True)
        save(items)
        if not a.no_nav:
            time.sleep(a.gap)

    # 为已入库但净值不足 2 条的占位产品补抓；同时轮换刷新净值日期落后的产品
    asof = max((x.get("latestDate") or "") for x in items) if items else ""
    pending = [x for x in items if len(x.get("nav") or []) < 2]
    stale = [x for x in items if len(x.get("nav") or []) >= 2 and (x.get("latestDate") or "") < asof]
    stale.sort(key=lambda x: x.get("latestDate") or "")
    queue = []
    while (pending or stale) and len(queue) < a.max_pending:
        if pending:
            queue.append(pending.pop(0))
        if stale and len(queue) < a.max_pending:
            queue.append(stale.pop(0))
    pending = queue
    if pending and not a.no_nav:
        print("待补/待刷新净值 %d 只" % len(pending), flush=True)
        for i, x in enumerate(pending, 1):
            print("[%d/%d] 补净值 %s" % (i, len(pending), x["regCode"]), flush=True)
            rows = fetch_nav(x["regCode"])
            if len(rows) >= 2:
                fresh = to_item(x, rows)
                x.update({k: fresh[k] for k in ("dates", "nav", "per10k", "latestDate", "latestNav")})
                if not x.get("risk") and fresh.get("risk"):
                    x["risk"] = fresh["risk"]
                save(items)
                print("  OK %d 条" % len(rows), flush=True)
            else:
                print("  仍无净值，下次再试", flush=True)
            time.sleep(a.gap)

    if not added and not pending:
        print("无需并入：新品预告中没有已成立且未入库的产品", flush=True)
        return 0
    print("完成：本次新并入 %d 只，产品库共 %d 只" % (added, len(items)), flush=True)
    commit_in_ci()
    return 0


if __name__ == "__main__":
    sys.exit(main())
