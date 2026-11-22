"""建信理财：官网 chart + 建行官网 NLC165 双源合并刷新产品库净值（免登录、无限流）。

用法：python daily/nav_official.py [--no-nlc] [--dry-run]

为什么是双源（2026-11-19 修订）
--------------------------------
建信理财官网 chart 接口自带约一个交易日的披露时滞：T 日上午去取，最新只到 T-2；
而建行官网代销净值列表（NLC165）通常已披露 T-1。若只认 chart，产品库会永远比
建行 App 里看到的净值慢一天（例：嘉鑫稳利最低持有7天第63期 11-19 上午 chart 只到
11-17，建行官网已有 11-18）。

取数口径（固定规则，后续改动须遵守）
------------------------------------
1) 历史序列以 chart 为主（起点=成立日、连续、完整）；
2) 最新披露点以「两源中日期更晚者」为准，建行官网 NLC165 用于补齐尾部 T-1；
3) NLC165 匹配优先级：渠道代码 ECD（ccb_map，精确）> 产品名归一（兜底）；
   名称兜底额外做同日期净值一致性校验（偏差 >2% 视为不同份额，拒绝该点，
   防止 A/B 份额串净值）；
4) 合并按日期取并集，latestDate 只前进不回退，任一源更旧都不会截断已有历史。
"""
import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import promote_newproducts as promo  # noqa: E402
import nav_holdings_t1 as nlc  # noqa: E402  复用 NLC165 全量拉取与名称归一

CHART = "https://www.wealthccb.com/website/v1/api/product/chart"
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.wealthccb.com/"}
# 名称兜底命中时，同日期两源净值允许的最大相对偏差（防 A/B 份额串净值）
NAME_TOLERANCE = 0.02


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


def nlc_point(x, by_name, by_ecd, cmap):
    """建行官网最新披露点 (date, nav, 来源)；ECD 精确优先，名称归一兜底。"""
    ecd = cmap.get(str(x.get("regCode") or ""))
    if ecd and ecd in by_ecd:
        d, v = by_ecd[ecd]
        return d, v, "建行官网ECD"
    hit = by_name.get(nlc.name_key(x.get("name")))
    if not hit:
        return None
    return hit[0], hit[1], "建行官网名称"


def same_share(rows, d, v):
    """名称兜底一致性校验：同日 chart 净值与 NLC 净值偏差过大视为不同份额。"""
    for r in rows:
        if r["date"] == d and r["nav"]:
            return abs(v - r["nav"]) / r["nav"] <= NAME_TOLERANCE
    # 同日无对照点时，用 chart 最新点做量级校验（净值水平不应跳变）
    if rows and rows[-1]["nav"]:
        return abs(v - rows[-1]["nav"]) / rows[-1]["nav"] <= NAME_TOLERANCE
    return True


def apply(x, rows, point=None):
    """按日期合并 chart 序列与建行官网单点，返回 (是否变化, 追加来源标记)。

    - 以原序列为底座 → 并入 chart 全量 → 并入 NLC 最新点，取并集；
    - latestDate 只前进不回退（任一源更旧都不会截断历史）；
    - per10k：chart 官方万分收益优先，缺失按前后净值差重算，未变动的历史点保留原值。
    """
    old_dates = list(x.get("dates") or [])
    old_nav = list(x.get("nav") or [])
    old_per = list(x.get("per10k") or [])
    old_nav_by_date = {d: v for d, v in zip(old_dates, old_nav)}

    merged = dict(old_nav_by_date)
    pft = {}
    has_pft = any((r.get("per10k") or 0) for r in rows[1:])
    for r in rows:
        merged[r["date"]] = round(r["nav"], 6)
        if has_pft and r.get("per10k") is not None:
            pft[r["date"]] = round(float(r["per10k"] or 0), 2)

    src = ""
    if point:
        d, v, tag = point
        merged[d] = round(v, 6)
        src = tag

    dates = sorted(merged)
    nav = [round(merged[d], 6) for d in dates]

    per = [None]
    for k in range(1, len(nav)):
        d = dates[k]
        if d in pft:
            per.append(pft[d])
            continue
        prev_d = dates[k - 1]
        unchanged = (d in old_nav_by_date and prev_d in old_nav_by_date
                     and abs(old_nav_by_date[d] - nav[k]) < 1e-9
                     and abs(old_nav_by_date[prev_d] - nav[k - 1]) < 1e-9)
        idx = old_dates.index(d) if d in old_dates else -1
        if unchanged and 0 < idx < len(old_per):
            per.append(old_per[idx])
        elif nav[k - 1]:
            per.append(round((nav[k] - nav[k - 1]) * 10000, 2))
        else:
            per.append(None)

    changed = merged != old_nav_by_date
    x.update({"dates": dates, "nav": nav, "per10k": per,
              "latestDate": dates[-1], "latestNav": nav[-1]})
    return changed, src


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
    ident = ["git", "-c", "user.name=github-actions[bot]",
             "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com"]
    for _ in range(3):
        subprocess.run(ident + ["pull", "--rebase", "--autostash", "origin", "main"],
                       check=False, timeout=120)
        if subprocess.run(ident + ["push", "origin", "HEAD:main"],
                          check=False, timeout=180).returncode == 0:
            return
        time.sleep(5)


def main():
    ap = argparse.ArgumentParser(description="建信官网 chart + 建行官网 NLC165 双源刷新产品库净值")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--no-nlc", action="store_true", help="只用建信官网 chart，不补建行官网 T-1")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写文件")
    ap.add_argument("--gap", type=float, default=0.15, help="NLC165 分页间隔秒")
    # 小时轮转用：建信官网 chart 免登录、不限频，可按「净值最落后优先」少量多轮补齐，
    # 避免周末/节假日净值下午才发布时，整库一直停在 T-2 直到次日 08:00
    ap.add_argument("--lag", action="store_true",
                    help="配合 --limit：按 latestDate 升序取最落后的若干只（小时轮转用）")
    a = ap.parse_args()

    lib = promo.load_json(promo.LIB_JSON, {"items": []})
    items = lib.get("items") or []
    cmap = promo.load_json(os.path.join(HERE, "ccb_map.json"), {})

    by_name, by_ecd = {}, {}
    if not a.no_nlc:
        print("抓取建行官网 NLC165 全量（补 T-1）...", flush=True)
        by_name, by_ecd = nlc.pull_nlc165(a.gap)
        print("  NLC165 有效净值 名称 %d / ECD %d" % (len(by_name), len(by_ecd)), flush=True)

    todo = [x for x in items
            if (x.get("orgShort") or "").startswith("建信")
            and cmap.get(str(x.get("regCode") or ""))]
    if a.lag:
        todo.sort(key=lambda x: (x.get("latestDate") or "", str(x.get("regCode") or "")))
    if a.limit:
        todo = todo[: a.limit]
    print("建信待刷新 %d 只%s" % (len(todo), "（最落后优先）" if a.lag else ""), flush=True)

    ok, fail, adv_nlc, tail_mismatch, lagging = 0, 0, 0, [], []
    t1 = (datetime.now(nlc.CN) - timedelta(days=1)).strftime("%Y-%m-%d")
    for i, x in enumerate(todo, 1):
        reg = str(x.get("regCode") or "")
        ecd = cmap[reg]
        try:
            rows = chart_rows(ecd)
        except Exception as exc:
            rows = []
            if not (by_ecd or by_name):
                print("[%d/%d] %s chart 失败：%s" % (i, len(todo), reg, str(exc)[:80]), flush=True)
        point = nlc_point(x, by_name, by_ecd, cmap)
        if point and point[2] == "建行官网名称" and not same_share(rows, point[0], point[1]):
            tail_mismatch.append((reg, x.get("short") or x.get("name"), point[0], point[1]))
            point = None
        if len(rows) < 2 and not point:
            if not rows:
                print("[%d/%d] %s 两源均无净值" % (i, len(todo), reg), flush=True)
                fail += 1
            continue
        old = x.get("latestDate") or ""
        changed, src = apply(x, rows, point)
        if x.get("latestDate") and old and x["latestDate"] < old:
            # 兜底保护：任何情况下 latestDate 不得回退
            raise SystemExit("严重异常：%s latestDate 回退 %s -> %s" % (reg, old, x["latestDate"]))
        ok += 1
        if x["latestDate"] > old:
            if src.startswith("建行官网"):
                adv_nlc += 1
            print("[%d/%d] %s %s → %s  [%s]%s" % (
                i, len(todo), reg, old or "-", x["latestDate"], src or "建信官网",
                "" if changed else "（同值）"), flush=True)
        if x["latestDate"] < t1:
            lagging.append((reg, x.get("short") or x.get("name"), x["latestDate"], src or "建信官网"))

    print("\n=== 刷新 %d 只，失败 %d 只，T-1(%s) 达标 %d/%d（其中建行官网补点 %d 只）===" % (
        ok, fail, t1, ok - len(lagging), ok, adv_nlc), flush=True)
    for reg, short, d, s in sorted(lagging, key=lambda r: r[2])[:20]:
        print("  [滞后] %-16s %-30s %s  %s" % (reg, short, d, s), flush=True)
    if tail_mismatch:
        print("  名称匹配被一致性校验拦下 %d 只（疑不同份额，已放弃该点）：" % len(tail_mismatch),
              flush=True)
        for reg, short, d, v in tail_mismatch[:10]:
            print("    %-16s %-30s %s nav=%s" % (reg, short, d, v), flush=True)

    asof = max((x.get("latestDate") or "") for x in items) or ""
    if a.dry_run:
        print("DRY-RUN：未写文件，产品库最新净值日 %s" % asof, flush=True)
        return 0
    promo.save(items)
    print("完成：产品库最新净值日 %s" % asof, flush=True)
    commit([promo.LIB_JS, promo.LIB_JSON],
           "data: 建信官网刷新产品库净值 %s" % asof)
    return 0


if __name__ == "__main__":
    sys.exit(main())
