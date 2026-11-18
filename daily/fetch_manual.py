"""手工添加产品：每日自动补抓最新净值（含近期历史），写回 Supabase。

- 只处理 newproducts 表中 kind=manual 的记录；
- 必须填写登记编码（regCode）才能抓取，未填写则跳过；
- 净值来源：中国理财网（与主数据同一适配器，按份额自动匹配）；
- 单只产品失败只跳过，不影响整条流水线。
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import sources  # noqa: E402
from pull_cloud import supabase_config  # noqa: E402

MAX_HISTORY = 320  # 保留最近约 15 个月的净值点
REG_RE = re.compile(r"^[A-Za-z0-9]{6,}$")


def sb_headers(key):
    return {"apikey": key, "Authorization": "Bearer " + key}


def load_manual():
    url, key, _, np_table = supabase_config()
    if not (url and key):
        return "", "", "", []
    try:
        resp = requests.get(
            f"{url}/rest/v1/{np_table}",
            params={"select": "key,data", "key": "like.manual:*"},
            headers=sb_headers(key),
            timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
    except Exception as exc:  # noqa: BLE001
        print("读取云端手工产品失败，跳过：", exc)
        return "", "", "", []
    out = []
    for row in rows:
        data = row.get("data") or {}
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except ValueError:
                continue
        if isinstance(data, dict) and data.get("kind") == "manual":
            out.append((row.get("key"), data))
    return url, key, np_table, out


def fetch_series(reg, today):
    rows = sources.fetch("chinawealth", {"regCode": reg}, "2000-01-01", today) or []
    dedup = {}
    for r in rows:
        if r.get("date") and r.get("nav") is not None:
            dedup[r["date"]] = float(r["nav"])
    return [{"date": d, "nav": dedup[d]} for d in sorted(dedup)][-MAX_HISTORY:]


def update_one(url, key, np_table, row_key, data, today):
    reg = str(data.get("regCode") or "").strip()
    name = data.get("name") or reg
    if not REG_RE.match(reg):
        print("  跳过（未填登记编码）：%s" % name)
        return False

    try:
        series = fetch_series(reg, today)
    except Exception as exc:  # noqa: BLE001
        print("  跳过（抓取失败）：%s %s" % (name, str(exc)[:160]))
        return False
    if not series:
        print("  跳过（暂无净值）：%s" % name)
        return False

    latest = series[-1]
    changed = data.get("navDate") != latest["date"] or float(data.get("nav") or 0) != latest["nav"]
    data["nav"] = latest["nav"]
    data["navDate"] = latest["date"]
    data["history"] = series
    data["autoFetchedAt"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    try:
        resp = requests.patch(
            f"{url}/rest/v1/{np_table}",
            params={"key": "eq." + row_key},
            json={"data": data},
            headers=dict(sb_headers(key), Prefer="return=minimal"),
            timeout=30,
        )
        resp.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        print("  写回云端失败：%s %s" % (name, exc))
        return False

    print("  %s：%s %s%s" % (
        name, latest["date"], latest["nav"],
        "" if changed else "（无变化）",
    ))
    return True


def update_manual_products():
    url, key, np_table, items = load_manual()
    if not items:
        print("云端暂无手工产品，跳过自动抓取")
        return 0
    today = datetime.now().strftime("%Y-%m-%d")
    print("手工产品自动抓取：共 %d 只" % len(items))
    ok = 0
    for row_key, data in items:
        try:
            if update_one(url, key, np_table, row_key, data, today):
                ok += 1
        except Exception as exc:  # noqa: BLE001
            print("  处理失败（跳过）：%s %s" % (data.get("name") or row_key, exc))
    print("手工产品抓取完成：%d/%d" % (ok, len(items)))
    return ok


def main():
    update_manual_products()
    return 0


if __name__ == "__main__":
    sys.exit(main())
