"""中银理财：官网公开接口抓取产品净值（免登录、无需签名）。

一、份额代码映射（实测 2026-11-13）
    产品库只有登记编码（Z7001026...），中银净值接口却按「份额代码」查询。
    官网「产品净值表现」列表页一次性服务端渲染全部产品链接，标题格式为
    「产品名称-份额代码」，例如：
        /html/1//netWorth/10264.html  title="中银理财-乐享天天51号-LXTT51A"
    因此按产品名称匹配标题即可得到份额代码；再用净值接口返回的
    registrationCode 字段反查校验，避免同名不同期产品串号。
    GET https://www.bocwm.cn/html/1//198/201/index.html   （约 2.4MB，需 utf-8 解码）

二、历史净值（实测）
    GET https://www.bocwm.cn/webApi/cms/productNetWorth/getNetWorthByCode
        ?productCode=LXTT51A&pageNo=1&pageSize=1000
    返回 JSON：{code:200, result:true, total:23, productType:"03", data:[...]}
    data[] 关键字段：
        releaseDate          净值日期 YYYY-MM-DD
        shareNetWorth        份额净值（普通产品）
        cumulativeNetWorth   累计净值
        eachTenThousandProfit 每万份收益（现金管理类 productType=03 只有这个）
        registrationCode     登记编码，可用于校验份额代码归属
    示例：LXTT51A → 23 条（2026-10-20~2026-11-11）；
          CYQWFQQPZ7D06A → 17 条（2026-10-20~2026-11-11）。

三、现金管理类处理
    productType=03 的产品 shareNetWorth/cumulativeNetWorth 全为空，只有每万份
    收益。为与产品库其它产品的「单位净值」字段保持一致，从 1.0 起按
    每万份收益/10000 逐日累加，折算成净值曲线（仅用于走势，非官方单位净值）。

用法：python daily/nav_boc.py --limit 30 --delay 1.0
"""
import argparse
import html
import os
import re
import subprocess
import sys
import time
from datetime import datetime

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import promote_newproducts as promo  # noqa: E402

INDEX_URL = "https://www.bocwm.cn/html/1//198/201/index.html"
NAV_URL = "https://www.bocwm.cn/webApi/cms/productNetWorth/getNetWorthByCode"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Referer": INDEX_URL, "Accept": "*/*"}


def norm_name(s):
    """去掉「（南极星）」等前缀、统一括号与空白，便于名称匹配。"""
    s = re.sub(r"^（[^）]*）", "", s or "")
    s = s.replace("（", "(").replace("）", ")")
    return re.sub(r"[\s\u00a0]", "", s)


def fetch_index():
    """返回 {规范化产品名: [(份额代码, 详情页id, 原始标题), ...]}。"""
    r = requests.get(INDEX_URL, headers=HEADERS, timeout=90)
    r.raise_for_status()
    r.encoding = "utf-8"
    index = {}
    for _href, pid, title in re.findall(
            r'href="(/html/1//netWorth/(\d+)\.html)"[^>]*title="([^"]*)"', r.text):
        title = html.unescape(title)
        parts = title.rsplit("-", 1)
        if len(parts) != 2 or not parts[1].strip():
            continue
        index.setdefault(norm_name(parts[0]), []).append((parts[1].strip(), pid, title))
    return index


def fetch_nav(share):
    """按份额代码取全量净值原始行（分页兼容，单页 1000 条足够）。"""
    rows, page = [], 1
    while page <= 10:
        r = requests.get(NAV_URL, params={"productCode": share, "pageNo": page,
                                          "pageSize": 1000},
                         headers=HEADERS, timeout=30)
        r.raise_for_status()
        data = r.json() or {}
        items = data.get("data") or []
        rows.extend(items)
        total = int(data.get("total") or 0)
        if not items or len(rows) >= total:
            break
        page += 1
    return rows


def to_rows(raw):
    """原始行 → [{'date','nav'}]（升序）。现金管理类按每万份收益累计折算。"""
    clean = {}
    for it in raw:
        dt = str(it.get("releaseDate") or "")[:10]
        if not dt:
            continue
        nav = it.get("shareNetWorth") or it.get("cumulativeNetWorth")
        clean[dt] = (nav, it.get("eachTenThousandProfit"))
    dates = sorted(clean)
    if not dates:
        return []
    if any(clean[d][0] for d in dates):
        return [{"date": d, "nav": float(clean[d][0])} for d in dates if clean[d][0]]
    # 现金管理类：无单位净值，只有每万份收益
    rows, acc = [], 1.0
    for d in dates:
        try:
            acc += float(clean[d][1]) / 10000.0
        except (TypeError, ValueError):
            pass
        rows.append({"date": d, "nav": round(acc, 6)})
    return rows


def resolve(x, index, delay):
    """登记编码 → 份额代码 → 净值行；校验不上则返回 (None, [])。"""
    reg = x["regCode"]
    key = norm_name(x.get("name"))
    cand = list(index.get(key) or [])
    if not cand:
        # 兜底：标题包含产品名（如官网多了后缀），仍以登记编码校验
        cand = [(s, p, t) for k, v in index.items() if key and (key in k or k in key)
                for (s, p, t) in v]
    unverified = []
    for share, _pid, _title in cand:
        raw = fetch_nav(share)
        if delay:
            time.sleep(delay)
        if not raw:
            unverified.append(share)
            continue
        regs = {str(it.get("registrationCode") or "") for it in raw}
        if reg not in regs:
            continue
        return share, raw
    if len(unverified) == 1:
        # 官网主档已收录但尚无净值，份额代码可信
        return unverified[0], []
    return None, []


def run(limit=30, delay=1.0, commit=False):
    """补抓中银产品净值，返回成功更新只数。供 nav_rotate 复用。"""
    lib = promo.load_json(promo.LIB_JSON, {"items": []})
    items = lib.get("items") or []
    boc = [x for x in items if (x.get("orgShort") or "").startswith("中银")]
    asof = max((x.get("latestDate") or "") for x in items) or ""
    today = datetime.now().strftime("%Y-%m-%d")
    empty = [x for x in boc if len(x.get("nav") or []) < 2]
    empty.sort(key=lambda x: x.get("inception") or "", reverse=True)
    # 当天已抓过且官网确实没有更新的，不再重复占用请求
    lag = [x for x in boc if len(x.get("nav") or []) >= 2
           and (x.get("latestDate") or "") < asof
           and x.get("bocTried") != today]
    lag.sort(key=lambda x: x["latestDate"])
    todo = (empty + lag)[:limit]
    print("中银官网待补 %d 只（无净值 %d，落后 %d，产品库基准 %s）"
          % (len(todo), len(empty), len(lag), asof), flush=True)
    if not todo:
        return 0

    index = fetch_index()
    print("官网产品索引 %d 条" % sum(len(v) for v in index.values()), flush=True)

    ok = 0
    for i, x in enumerate(todo, 1):
        label = "%s %s" % (x["regCode"], (x.get("short") or "")[:20])
        try:
            share, raw = resolve(x, index, delay)
            if not share:
                print("[%d/%d] %s 跳过：官网未找到份额代码" % (i, len(todo), label), flush=True)
                continue
            rows = to_rows(raw)
            if len(rows) < 2:
                print("[%d/%d] %s 跳过：官网暂无净值（份额 %s）"
                      % (i, len(todo), label, share), flush=True)
                continue
            old = x.get("latestDate") or ""
            if rows[-1]["date"] < old and len(rows) <= len(x.get("nav") or []):
                print("[%d/%d] %s 官网数据更旧，跳过" % (i, len(todo), label), flush=True)
                continue
            fresh = promo.to_item(x, rows)
            x.update({k: fresh[k] for k in ("dates", "nav", "per10k",
                                            "latestDate", "latestNav")})
            ok += 1
            print("[%d/%d] %s OK %d 条 %s~%s 最新 %s（份额 %s）"
                  % (i, len(todo), label, len(rows), rows[0]["date"], rows[-1]["date"],
                     x["latestNav"], share), flush=True)
        except Exception as exc:
            print("[%d/%d] %s 失败：%s" % (i, len(todo), label, str(exc)[:100]), flush=True)

    if ok:
        promo.save(items)
        print("中银完成：更新 %d 只" % ok, flush=True)
        if commit:
            _commit("data: 中银官网补抓净值 %s" % (max(
                (x.get("latestDate") or "") for x in items) or ""))
    else:
        print("中银完成：无更新", flush=True)
    return ok


def _commit(message):
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    subprocess.run(["git", "add", promo.LIB_JS, promo.LIB_JSON], check=False, timeout=120)
    if subprocess.run(["git", "diff", "--cached", "--quiet"], check=False).returncode == 0:
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
    ap = argparse.ArgumentParser(description="中银理财官网净值补抓")
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--delay", type=float, default=1.0, help="每只产品请求间隔（秒）")
    a = ap.parse_args()
    ok = run(limit=a.limit, delay=a.delay, commit=True)
    return 0 if ok >= 0 else 1


if __name__ == "__main__":
    sys.exit(main())
