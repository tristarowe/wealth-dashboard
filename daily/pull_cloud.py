"""从 Supabase 拉取云端登记的交易与新品，覆盖页面底稿。

主通道：Supabase（FREE 长期有效）。任何异常只跳过、不中断流水线，
页面随后使用仓库内底稿渲染，推送不失败。
"""
import json
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
SB_JS = ROOT / "assets" / "supabase-config.js"
TRADE_JS = ROOT / "assets" / "transactions.js"
NP_JS = ROOT / "assets" / "newproducts.js"
DROP = {"_id", "_openid", "updatedAt", "created_at"}

SB_MAP = {
    "apply_date": "applyDate",
    "confirm_date": "confirmDate",
    "confirm_nav": "confirmNav",
    "sale_channel": "saleChannel",
}


def read_js(path):
    text = path.read_text(encoding="utf-8")
    start = text.index("=", text.index("window.")) + 1
    body = text[start:].strip()
    if body.endswith(";"):
        body = body[:-1]
    return text[: text.index("window.")], json.loads(body)


def write_js(path, prefix, var, data):
    path.write_text(
        prefix + f"window.{var} = " + json.dumps(data, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    print("已更新", path.name)


def supabase_config():
    if not SB_JS.exists():
        return "", "", "trades", "newproducts"
    _, cfg = read_js(SB_JS)
    return (
        (cfg.get("url") or "").rstrip("/"),
        cfg.get("key") or "",
        cfg.get("table") or "trades",
        cfg.get("npTable") or "newproducts",
    )


def sb_get(table, params):
    url, key, tx_table, np_table = supabase_config()
    if not (url and key):
        print("未配置 Supabase，跳过云端拉取")
        return []
    name = tx_table if table == "trades" else np_table
    try:
        resp = requests.get(
            f"{url}/rest/v1/{name}",
            params=params,
            headers={"apikey": key, "Authorization": "Bearer " + key},
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:  # noqa: BLE001
        print(f"Supabase 读取 {name} 失败，跳过：", exc)
        return []


def supabase_trades():
    rows = sb_get("trades", {"select": "*", "order": "confirm_date.asc,id.asc"})
    out = []
    for row in rows:
        item = {}
        for k, v in row.items():
            if k in DROP:
                continue
            item[SB_MAP.get(k, k)] = v
        if isinstance(item.get("amount"), float):
            item["amount"] = round(item["amount"], 2)
        out.append(item)
    return out


def supabase_newproducts():
    rows = sb_get("newproducts", {"select": "data"})
    out = []
    for row in rows:
        data = row.get("data") or {}
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except ValueError:
                continue
        out.append(data)
    return out


def merge_newproducts(rows, current):
    """云端条目按登记编码覆盖页面底稿，其余保留；再按机构重建泳道。"""
    merged = {}
    order = []

    def put(item):
        k = item.get("regCode") or item.get("name") or ""
        if not k:
            return
        if k not in merged:
            order.append(k)
        merged[k] = item

    for item in current.get("items") or []:
        put(dict(item))
    for item in rows:
        put(dict(item))

    items = [merged[k] for k in order]
    lanes = []
    index = {}
    for p in items:
        ch = p.get("channel") or p.get("issuer") or "未登记机构"
        if ch not in index:
            index[ch] = {"channel": ch, "products": []}
            lanes.append(index[ch])
        index[ch]["products"].append(p)
    for lane in lanes:
        lane["products"].sort(key=lambda x: (x.get("raiseStart") or "", x.get("name") or ""))
    lanes.sort(key=lambda l: (l["products"][0].get("raiseStart") or "", l["channel"]))

    starters = [p.get("raiseStart") for p in items if p.get("raiseStart")]
    enders = [(p.get("raiseEnd") or p.get("establish")) for p in items if (p.get("raiseEnd") or p.get("establish"))]
    window = dict(current.get("window") or {})
    if starters:
        window["start"] = min(starters)
    if enders:
        window["end"] = max(enders)

    out = dict(current)
    out["items"] = items
    out["lanes"] = lanes
    out["window"] = window
    out["institutions"] = [l["channel"] for l in lanes]
    out["source"] = "云端登记 + 官网公告"
    return out


def pull():
    tx = supabase_trades()
    if tx:
        prefix, current = read_js(TRADE_JS)
        current["items"] = sorted(tx, key=lambda t: (t.get("confirmDate") or "", t.get("id") or ""))
        write_js(TRADE_JS, prefix, "TRANSACTIONS", current)
        print("Supabase 交易 %d 笔" % len(tx))
    else:
        print("云端暂无交易，保留页面底稿")

    np = supabase_newproducts()
    if np:
        prefix, current = read_js(NP_JS)
        write_js(NP_JS, prefix, "NEW_PRODUCTS", merge_newproducts(np, current))
        print("Supabase 新品 %d 款" % len(np))
    else:
        print("云端暂无新品，保留页面底稿")


def main():
    pull()
    return 0


if __name__ == "__main__":
    sys.exit(main())
