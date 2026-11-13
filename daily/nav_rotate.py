"""非建信产品：按最旧净值优先轮换补抓（中国理财网限频，单次少量）。

用法：python daily/nav_rotate.py --limit 5
说明：每轮只挑净值落后于产品库整体最新日（空净值排最后），抓完即停；
      连续 2 次触发人机验证则提前结束，把额度留给下一轮。
      配合 hourly 工作流，约 24 轮可覆盖产品库全部非建信产品。
"""
import argparse
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import nav_boc  # noqa: E402
import nav_bulk  # noqa: E402
import promote_newproducts as promo  # noqa: E402


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
    ap = argparse.ArgumentParser(description="非建信产品净值轮换补抓")
    ap.add_argument("--limit", type=int, default=5)
    ap.add_argument("--gap", type=float, default=2.0)
    ap.add_argument("--prefer", choices=["auto", "empty", "lag"], default="auto",
                    help="优先补无净值的新品(empty)还是落后产品(lag)")
    ap.add_argument("--retry-days", type=int, default=3,
                    help="无净值产品抓空后多少天内不再重试，避免浪费限频额度")
    a = ap.parse_args()

    # 中银官网接口免登录、不限频，先补中银，省下中国理财网的限频额度
    boc_ok = 0
    try:
        boc_ok = nav_boc.run(limit=20, delay=0.8)
    except Exception as exc:
        print("中银官网补抓跳过：%s" % str(exc)[:120], flush=True)

    lib = promo.load_json(promo.LIB_JSON, {"items": []})
    items = lib.get("items") or []
    pool = [x for x in items if not (x.get("orgShort") or "").startswith("建信")]
    # 以产品库整体最新净值日为基准：只补落后的，尚无净值的排最后，避免浪费限频额度
    asof = max((x.get("latestDate") or "") for x in items) or ""
    lag = [x for x in pool if (x.get("latestDate") or "") and x["latestDate"] < asof]
    lag.sort(key=lambda x: x["latestDate"])
    today = datetime.now().strftime("%Y-%m-%d")
    cutoff = (datetime.now() - timedelta(days=a.retry_days)).strftime("%Y-%m-%d")
    # 无净值的按成立日倒序（新品优先），排除近期抓空过的
    empty = [x for x in pool if not (x.get("latestDate") or "")
             and (x.get("navTried") or "") < cutoff]
    empty.sort(key=lambda x: x.get("inception") or "", reverse=True)
    if a.prefer == "empty":
        todo = (empty + lag)[: a.limit]
    elif a.prefer == "lag":
        todo = (lag + empty)[: a.limit]
    else:
        todo = (lag + empty)[: a.limit]
    print("非建信待补 %d 只（落后 %d 只，无净值 %d 只，基准 %s，优先 %s）"
          % (len(todo), len(lag), len(empty), asof, a.prefer), flush=True)

    ok, blocked = 0, 0
    for i, x in enumerate(todo, 1):
        print("[%d/%d] %s %s" % (i, len(todo), x["regCode"], (x.get("short") or "")[:20]), flush=True)
        try:
            rows, meta = nav_bulk.fetch(x["regCode"])
        except Exception as exc:
            msg = str(exc)
            print("  失败：%s" % msg[:80], flush=True)
            blocked = blocked + 1 if "验证" in msg else blocked
            if blocked >= 2:
                print("  连续触发人机验证，提前结束", flush=True)
                break
            continue
        blocked = 0
        if meta.get("risk") and not x.get("risk"):
            x["risk"] = meta["risk"]
        old = x.get("latestDate") or ""
        if len(rows) >= 2 and (rows[-1]["date"] > old or len(rows) > len(x.get("nav") or [])):
            fresh = promo.to_item(x, rows)
            x.update({k: fresh[k] for k in ("dates", "nav", "per10k", "latestDate", "latestNav")})
            ok += 1
            print("  OK %d 条，最新 %s" % (len(rows), x["latestDate"]), flush=True)
        else:
            if not old:
                # 抓空过（中国理财网暂无该产品净值）：记录日期，近期不再占用额度
                x["navTried"] = today
            print("  仍无新净值", flush=True)
        if a.gap:
            time.sleep(a.gap)

    promo.save(items)
    asof = max((x.get("latestDate") or "") for x in items) or ""
    left = sum(1 for x in items if not (x.get("orgShort") or "").startswith("建信")
               and (x.get("latestDate") or "") < asof)
    print("完成：更新 %d 只，整体最新 %s，仍落后 %d 只" % (ok, asof, left), flush=True)
    if ok or boc_ok:
        commit([promo.LIB_JS, promo.LIB_JSON], "data: 轮换补抓非建信净值 %s" % asof)
    return 0


if __name__ == "__main__":
    sys.exit(main())
