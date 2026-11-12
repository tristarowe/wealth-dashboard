"""每日抓取跟踪清单内的理财产品净值，更新 assets/data.js，并生成推送统计。

数据源优先级：管理人官网 / 代销行官方净值 > 中国理财网兜底。
每个产品按 daily/sources_config.json 配置的源链抓取，合并时高优先级源覆盖同日期数据。
"""
import json
import sys
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import sources  # noqa: E402

DATA_JS = ROOT / "assets" / "data.js"
CONFIG = Path(__file__).resolve().parent / "sources_config.json"
STATS = Path(__file__).resolve().parent / "stats.json"
CN = timezone(timedelta(hours=8))
FALLBACK = "中国理财网"


def load_data():
    text = DATA_JS.read_text(encoding="utf-8")
    import re
    m = re.search(r"window\.REPORT_DATA\s*=\s*(\{.*\})\s*;?\s*$", text, re.S)
    if not m:
        raise SystemExit("无法解析 assets/data.js")
    return json.loads(m.group(1))


def load_config():
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def fetch_product(product, config, today):
    """按源链抓取，返回 [(adapter, rows)]，顺序即优先级。

    官方源已覆盖成立日时跳过中国理财网，降低触发人机验证的概率；
    官方源全部失败或历史不完整时才启用兜底。
    """
    chain = list(config.get(product["id"], []))
    fetched = []
    for src in chain:
        adapter = src["adapter"]
        for attempt in range(1, 3):
            try:
                rows = sources.fetch(adapter, src.get("params"), "2000-01-01", today)
                if rows:
                    fetched.append((adapter, rows))
                    print("  [源OK] %s：%d 条，最新 %s" % (
                        sources.label(adapter), len(rows), max(r["date"] for r in rows)))
                else:
                    print("  [源空] %s" % sources.label(adapter))
                break
            except Exception as exc:  # 网络、限流、页面改版等
                if attempt < 2:
                    time.sleep(3)
                    continue
                print("  [源失败] %s：%s" % (sources.label(adapter), str(exc)[:200]))

    need_fallback = True
    if fetched:
        earliest = min(r["date"] for _adapter, rows in fetched for r in rows)
        need_fallback = earliest > product["inception"]
    if not need_fallback:
        return fetched

    params = {"regCode": product["regCode"], "shareCode": product.get("shareCode") or ""}
    for attempt in range(1, 4):
        try:
            rows = sources.fetch("chinawealth", params, "2000-01-01", today)
            if rows:
                fetched.append(("chinawealth", rows))
                print("  [源OK] 中国理财网：%d 条，最新 %s" % (
                    len(rows), max(r["date"] for r in rows)))
            else:
                print("  [源空] 中国理财网")
            break
        except Exception as exc:
            if attempt < 3:
                time.sleep(5 * attempt)
                continue
            print("  [源失败] 中国理财网：%s" % str(exc)[:200])
    return fetched


def merge_rows(product, fetched):
    """低优先级先写、高优先级覆盖；返回 (dates, nav, per10k, latest, source_name)。"""
    old = dict(zip(product["dates"], product["nav"]))
    merged = dict(old)
    for _adapter, rows in reversed(fetched):  # 源链末尾优先级最低
        for row in rows:
            merged[row["date"]] = row["nav"]

    dates = sorted(merged)
    nav = [merged[d] for d in dates]
    per10k = [None]
    for i in range(1, len(nav)):
        per10k.append(round((nav[i] - nav[i - 1]) * 10000, 2))

    new_dates = [d for d in dates if d not in old]
    per_map = dict(zip(dates, per10k))
    bad = [d for d in new_dates if per_map[d] is not None and abs(per_map[d]) > 500]
    if bad:
        raise RuntimeError("新增净值异常跳变：%s" % ", ".join(bad[:3]))
    if dates[-1] < product["latestDate"]:
        raise RuntimeError("抓取结果早于现有数据（%s < %s）" % (dates[-1], product["latestDate"]))

    latest = dates[-1]
    source_name = FALLBACK
    for adapter, rows in fetched:
        if any(r["date"] == latest for r in rows):
            source_name = sources.label(adapter)
            break
    return dates, nav, per10k, latest, source_name


def build_stats(data, failed, today):
    products = data["products"]
    latest = max((p["latestDate"] for p in products if p.get("latestDate")), default="")
    items = []
    lagging = []
    for p in products:
        if p["per10k"] and p["per10k"][-1] is not None:
            items.append({
                "short": p["short"],
                "value": p["per10k"][-1],
                "date": p.get("latestDate", ""),
                "source": p.get("sourceName", FALLBACK),
            })
        if p.get("latestDate") and p["latestDate"] != latest:
            lagging.append("%s（%s）" % (p["short"], p["latestDate"]))
    items.sort(key=lambda x: x["value"], reverse=True)

    total = round(sum(x["value"] for x in items), 2)
    pos = sum(1 for x in items if x["value"] > 0.005)
    neg = sum(1 for x in items if x["value"] < -0.005)
    flat = len(items) - pos - neg

    # 近 30 个自然日：逐日汇总已覆盖产品的万收，再取日均
    end = datetime.strptime(latest, "%Y-%m-%d").date() if latest else None
    daily = {}
    if end:
        start = end - timedelta(days=29)
        for p in products:
            for d, v in zip(p["dates"], p["per10k"]):
                if v is None:
                    continue
                dd = datetime.strptime(d, "%Y-%m-%d").date()
                if start <= dd <= end:
                    daily[d] = round(daily.get(d, 0) + v, 2)
    avg30 = round(sum(daily.values()) / len(daily), 2) if daily else None

    counter = Counter(p.get("sourceName", FALLBACK) for p in products)
    return {
        "asOf": today,
        "dataDate": latest,
        "total": total,
        "covered": len(items),
        "products": len(products),
        "pos": pos,
        "neg": neg,
        "flat": flat,
        "avg30": avg30,
        "items": items,
        "lagging": lagging,
        "failed": failed,
        "sources": [{"name": k, "count": v} for k, v in counter.most_common()],
    }


def main():
    data = load_data()
    config = load_config()
    today = datetime.now(CN).strftime("%Y-%m-%d")

    if "--stats-only" in sys.argv:
        stats = build_stats(data, [], today)
        STATS.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
        print("统计已重建：", stats["dataDate"], stats["total"])
        return 0

    failed = []
    for p in data["products"]:
        print("[抓取] %s" % p["short"], flush=True)
        fetched = fetch_product(p, config, today)
        if not fetched:
            failed.append({"short": p["short"], "error": "所有数据源均失败"})
            print("  保留旧数据", flush=True)
            continue
        try:
            dates, nav, per10k, latest, source_name = merge_rows(p, fetched)
        except Exception as exc:
            failed.append({"short": p["short"], "error": str(exc)})
            print("  [校验失败] %s，保留旧数据" % exc, flush=True)
            continue
        p["dates"] = dates
        p["nav"] = nav
        p["per10k"] = per10k
        p["inception"] = dates[0]
        p["latestDate"] = latest
        p["sourceName"] = source_name
        print("  -> %s（%s）共 %d 条" % (latest, source_name, len(dates)), flush=True)

    ok = len(data["products"]) - len(failed)
    print("完成：成功 %d/%d，失败 %d" % (ok, len(data["products"]), len(failed)))
    for f in failed:
        print("失败：%s - %s" % (f["short"], f["error"]))

    if ok == 0:
        print("全部产品抓取失败，不写入 data.js", file=sys.stderr)
        return 2

    data["asOf"] = today
    data["fetchedAt"] = datetime.now(CN).strftime("%Y-%m-%d %H:%M")
    DATA_JS.write_text(
        "window.REPORT_DATA = " + json.dumps(data, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )

    stats = build_stats(data, failed, today)
    stats["fetchedAt"] = data["fetchedAt"]
    STATS.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print("数据日期：", stats["dataDate"], "| 当日万收总计：", stats["total"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
