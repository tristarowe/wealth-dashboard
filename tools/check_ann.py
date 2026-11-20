# -*- coding: utf-8 -*-
"""持仓收益 / 年化口径回归校验（2026-11-21 新增）

背景：中银悦享天添24号的持仓年化曾因分母错用「确认日」而显示 14.51%（实际 7.25%）。
为防止同类口径错误静默复发，本脚本对每个持仓做三层独立核对：

  1. 页面自检：dashboard.js 里的 assertHoldMath() 是否有告警（window.__ANN_GUARD_ERRORS__）
  2. 独立复算：只用原始交易 + 净值序列重新算一遍 shares/cost/mv/持仓收益/计息天数/年化，与页面逐项比对
  3. 净值路径：用「首尾净值」算同一区间产品年化，与持仓年化比对（差异过大说明批次混合或净值异常）

用法：
  python tools/check_ann.py            # 校验，异常退出码 1
  python tools/check_ann.py --quiet    # 只打印结论

依赖：playwright（本机已装）+ 本地 index.html（file:// 打开，不联网）
"""
import json
import sys
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("SKIP: 未安装 playwright，跳过页面侧校验（pip install playwright && playwright install chromium）")
    sys.exit(0)

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
TOL_ANN = 0.01      # 年化容差（百分点）
TOL_MONEY = 0.01    # 金额容差（元）
from datetime import date


def d(s):
    return date.fromisoformat(s)


def nav_date(p, key, fallback):
    """成交净值日：<= key 的最后一根净值；尚未披露则回落到确认日（与 navDateAt 一致）"""
    hit = None
    for x in p["dates"]:
        if x <= key:
            hit = x
        else:
            break
    return hit or fallback


def recompute(p, txs):
    dates, navs = p["dates"], p["nav"]
    shares = cost = realized = 0.0
    lots = []
    for t in sorted(txs, key=lambda x: (x.get("confirmDate") or x.get("applyDate"), x["id"])):
        apply_d = t.get("applyDate") or t.get("confirmDate")
        confirm_d = t.get("confirmDate") or apply_d
        nv = t.get("confirmNav") or None
        if not nv:
            nd = nav_date(p, apply_d, apply_d)
            nv = navs[dates.index(nd)] if nd in dates else (navs[-1] if navs else 1)
        sh = t.get("shares") or 0
        if not (sh > 0):
            sh = (t.get("amount") or 0) / nv
        if t["type"] in ("赎回", "清仓"):
            sell = shares if t["type"] == "清仓" else min(shares, sh)
            if not (sell > 0):
                continue
            avg = cost / shares if shares > 0 else nv
            realized += sell * (nv - avg)
            cost -= sell * avg
            shares -= sell
            remain = sell
            for lot in lots:
                take = min(lot["shares"], remain)
                lot["shares"] -= take
                remain -= take
                if remain <= 0:
                    break
            lots = [x for x in lots if x["shares"] > 1e-9]
        else:
            lots.append({"date": confirm_d, "navDate": nav_date(p, apply_d, confirm_d), "shares": sh})
            shares += sh
            cost += (t.get("amount") or sh * nv)

    latest_nav, latest_date = navs[-1], dates[-1]
    mv = shares * latest_nav
    unreal = mv - cost
    start = lots[0]["navDate"] if lots else None
    inc = p.get("inception")
    if start and inc and start < inc:
        start = inc
    acc_days = (d(latest_date) - d(start)).days if start else 0
    ann = unreal / cost * 365 / acc_days * 100 if acc_days > 0 and cost > 0 else None
    i0 = navs.index(navs[dates.index(start)]) if start in dates else 0
    prod_ann = ((latest_nav / navs[i0] - 1) * 365 / acc_days * 100) if acc_days > 0 and navs[i0] else None
    return dict(shares=shares, cost=cost, mv=mv, unreal=unreal, realized=realized, start=start,
                acc_days=acc_days, ann=ann, prod_ann=prod_ann, latest_date=latest_date)


def main():
    quiet = "--quiet" in sys.argv
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1440, "height": 1000})
        pg.goto(INDEX.as_uri(), wait_until="load")
        pg.wait_for_timeout(2500)
        guard = pg.evaluate("() => window.__ANN_GUARD_ERRORS__ || []")
        holds = pg.evaluate("""() => (window.DASHBOARD_HOLDINGS || []).map(h => ({
            pid: h.product.id, name: h.product.name,
            p: {inception: h.product.inception, dates: h.product.dates, nav: h.product.nav},
            shares: h.shares, cost: h.cost, mv: h.mv, unreal: h.unrealized,
            acc_days: h.accrualDays, ann: h.ann, start: h.accrualStart, latest: h.latestDate,
            annShort: h.annShort
        }))""")
        txs = pg.evaluate("() => (window.TRANSACTIONS && window.TRANSACTIONS.items) || []")
        b.close()

    by_pid = {}
    for t in txs:
        key = (t.get("_p") or {}).get("id") or t["pid"]
        by_pid.setdefault(key, []).append(t)

    problems = []
    rows = []
    for h in holds:
        ts = by_pid.get(h["pid"]) or []
        if not ts:
            problems.append(f"{h['name']}：找不到交易记录")
            continue
        r = recompute(h["p"], ts)
        checks = [
            ("持仓成本", h["cost"], r["cost"], TOL_MONEY),
            ("持仓市值", h["mv"], r["mv"], TOL_MONEY),
            ("持仓收益", h["unreal"], r["unreal"], TOL_MONEY),
        ]
        for label, a, b_, tol in checks:
            if a is None or b_ is None or abs(a - b_) > tol:
                problems.append(f"{h['name']}：{label} 页面 {a} vs 复算 {b_}")
        if h["acc_days"] != r["acc_days"]:
            problems.append(f"{h['name']}：计息天数 页面 {h['acc_days']} vs 复算 {r['acc_days']}"
                            f"（起点 {h['start']} vs {r['start']}）")
        if (h["ann"] is None) != (r["ann"] is None):
            problems.append(f"{h['name']}：年化有无不一致 页面 {h['ann']} vs 复算 {r['ann']}")
        elif h["ann"] is not None and abs(h["ann"] - r["ann"]) > TOL_ANN:
            problems.append(f"{h['name']}：年化 页面 {h['ann']:.2f}% vs 复算 {r['ann']:.2f}%")
        # 净值路径交叉校验：仅在样本够长时比较（短样本本身波动大）
        if r["acc_days"] >= SHORT_DAYS and r["prod_ann"] is not None and r["ann"] is not None:
            if abs(r["ann"] - r["prod_ann"]) > 0.8:
                problems.append(f"{h['name']}：持仓年化 {r['ann']:.2f}% 与净值路径 {r['prod_ann']:.2f}% 相差 "
                                f"{r['ann'] - r['prod_ann']:.2f}pp，请复核批次/净值")
        if bool(h["annShort"]) != (0 < (r["acc_days"] or 0) < SHORT_DAYS):
            problems.append(f"{h['name']}：短样本标记 annShort={h['annShort']} 与计息 {r['acc_days']} 天不符")
        rows.append((h["name"], h, r))

    if not quiet:
        print(f"{'产品':<26}{'计息天':>6}{'页面年化':>9}{'复算年化':>9}{'净值路径':>9}{'短样本':>7}")
        for name, h, r in rows:
            print(f"{name[:24]:<26}{r['acc_days']:>6}{(h['ann'] or 0):>9.2f}{(r['ann'] or 0):>9.2f}"
                  f"{(r['prod_ann'] or 0):>9.2f}{'*' if 0 < r['acc_days'] < SHORT_DAYS else '':>7}")
        print()

    for g in guard:
        problems.append(f"页面自检告警：{g.get('name')} {g.get('msg')}")

    if problems:
        print(f"FAIL：{len(problems)} 项不一致")
        for x in problems:
            print("  -", x)
        return 1
    print(f"OK：{len(rows)} 只持仓，成本/市值/持仓收益/计息天数/年化 全部与独立复算一致，页面自检 0 告警")
    return 0


SHORT_DAYS = 7

if __name__ == "__main__":
    sys.exit(main())
