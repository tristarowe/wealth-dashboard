"""建信理财：官网公开 chart 接口全量刷新产品库净值（免登录、无限流）。

用法：python daily/nav_official.py
说明：仅处理产品库中 orgShort=建信理财 且能在 daily/ccb_map.json 命中 ecd 的产品，
      一次请求即返回全量历史净值，102 只产品约 30 秒完成。
"""
import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import promote_newproducts as promo  # noqa: E402

CHART = "https://www.wealthccb.com/website/v1/api/product/chart"
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.wealthccb.com/"}


def chart_rows(ecd):
    r = requests.get(CHART, params={"id": ecd}, headers=HEADERS, timeout=30)
    r.raise_for_status()
    data = (r.json() or {}).get("data") or []
    rows = []
    for it in data:
        d = str(it.get("drivDt") or "")
        if len(d) == 8 and d.isdigit():
            d = "%s-%s-%s" % (d[:4], d[4:6], d[6:])
        nav = it.get("netVal")
        if not d or nav is None:
            continue
        rows.append({"date": d, "nav": float(nav), "per10k": it.get("tenthPft")})
    rows.sort(key=lambda x: x["date"])
    return rows


def apply(x, rows):
    dates = [r["date"] for r in rows]
    nav = [round(r["nav"], 6) for r in rows]
    has_pft = any((r.get("per10k") or 0) for r in rows[1:])
    per10k = [None]
    for k in range(1, len(nav)):
        if has_pft:
            per10k.append(round(float(rows[k].get("per10k") or 0), 2))
        else:
            per10k.append(round((nav[k] - nav[k - 1]) * 10000, 2))
    x.update({"dates": dates, "nav": nav, "per10k": per10k,
              "latestDate": dates[-1], "latestNav": nav[-1]})


def commit(files, message):
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    subprocess.run(["git", "add"] + files, check=False, timeout=120)
    diff = subprocess.run(["git", "diff", "--cached", "--quiet"], check=False)
    if diff.returncode == 0:
        return
    subprocess.run(["git", "-c", "user.name=github-actions[bot]",
                    "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                    "commit", "-m", message], check=False, timeout=120)
    for _ in range(3):
        subprocess.run(["git", "pull", "--rebase", "--autostash"], check=False, timeout=120)
        if subprocess.run(["git", "push"], check=False, timeout=180).returncode == 0:
            return
        time.sleep(5)


def main():
    ap = argparse.ArgumentParser(description="建信官网全量刷新产品库净值")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()

    lib = promo.load_json(promo.LIB_JSON, {"items": []})
    items = lib.get("items") or []
    cmap = promo.load_json(os.path.join(HERE, "ccb_map.json"), {})

    todo = [x for x in items
            if (x.get("orgShort") or "").startswith("建信")
            and cmap.get(str(x.get("regCode") or ""))]
    if a.limit:
        todo = todo[: a.limit]
    print("建信待刷新 %d 只" % len(todo), flush=True)

    ok, fail = 0, 0
    for i, x in enumerate(todo, 1):
        ecd = cmap[x["regCode"]]
        try:
            rows = chart_rows(ecd)
        except Exception as exc:
            print("[%d/%d] %s 失败：%s" % (i, len(todo), x["regCode"], str(exc)[:80]), flush=True)
            fail += 1
            continue
        if len(rows) < 2:
            print("[%d/%d] %s 官网无净值" % (i, len(todo), x["regCode"]), flush=True)
            fail += 1
            continue
        if rows[-1]["date"] < (x.get("latestDate") or "") and len(rows) <= len(x.get("nav") or []):
            print("[%d/%d] %s 官网数据更旧，跳过" % (i, len(todo), x["regCode"]), flush=True)
            continue
        old = x.get("latestDate") or ""
        apply(x, rows)
        if x["latestDate"] > old:
            print("[%d/%d] %s %s → %s" % (i, len(todo), x["regCode"], old or "-", x["latestDate"]),
                  flush=True)
        ok += 1

    promo.save(items)
    asof = max((x.get("latestDate") or "") for x in items) or ""
    print("完成：刷新 %d 只，失败 %d 只，产品库最新净值日 %s" % (ok, fail, asof), flush=True)
    commit([promo.LIB_JS, promo.LIB_JSON],
           "data: 建信官网刷新产品库净值 %s" % asof)
    return 0


if __name__ == "__main__":
    sys.exit(main())
