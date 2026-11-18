"""按登记编码(regCode)把产品库(library)的较新净值回填到持仓底稿(data.js)。

背景：同一产品在两个数据源用不同 id（data.js 的 p2218 与 library.js 的
LZ7002626002218）。抓取链路一旦只在 library 更新到 T-1、data.js 仍停在 T-2，
前端身份归一化后按 data.js 优先去重就会显示旧净值。本模块提供纯内存回填：
对 data.js 每个有 regCode 的产品，在 library 里找同 regCode 的产品，
若 library 的 latestDate 更新，则把 library 中晚于 data 最新日的净值点
逐点追加到 data 的 dates/nav/per10k 序列，并返回是否发生变更。

规则：
- 只追加 library 比 data 新的点，不回退、不覆盖历史；
- 两源历史必须一致（共有日期净值相同）才回填，异常则跳过该产品，避免污染；
- 不主动抓取，只用已在 library 中的净值 —— 遵守「官网优先、理财网兜底」，
  本模块只是让两条链路的结果保持一致。
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA_JS = os.path.join(ROOT, "assets", "data.js")
LIB_JS = os.path.join(ROOT, "assets", "library.js")


def _load_js_var(path, var):
    txt = open(path, encoding="utf-8", errors="ignore").read()
    m = re.search(r"window\.%s\s*=\s*(\{.*\})\s*;?\s*$" % re.escape(var), txt, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:
        return None


def _append_point(product, date, nav, per10k):
    """把一个净值点追加到产品序列；per10k 优先用 library 现成值。"""
    dates = list(product.get("dates") or [])
    navs = list(product.get("nav") or [])
    pers = list(product.get("per10k") or [])
    if dates and date <= dates[-1]:
        return False
    dates.append(date)
    navs.append(round(nav, 6))
    if not pers:
        pers.append(None)
    while len(pers) < len(navs) - 1:
        pers.append(None)
    pers.append(round(per10k, 2) if per10k is not None else None)
    product["dates"] = dates
    product["nav"] = navs
    product["per10k"] = pers
    product["latestDate"] = date
    return True


def sync(data, lib):
    """把 lib 中较新的净值按 regCode 回填到 data。返回 (变更只数, 明细列表)。"""
    items = (lib or {}).get("items", [])
    products = (data or {}).get("products", [])
    by_reg = {}
    for it in items:
        reg = it.get("regCode")
        if reg:
            by_reg.setdefault(str(reg), []).append(it)

    changed = 0
    details = []
    for p in products:
        reg = p.get("regCode")
        if not reg:
            continue
        candidates = by_reg.get(str(reg)) or []
        if not candidates:
            continue
        # 取该 regCode 下 latestDate 最新的 library 条目
        src = max(candidates, key=lambda x: x.get("latestDate") or "")
        sdate = src.get("latestDate") or ""
        ddate = p.get("latestDate") or ""
        if not sdate or sdate <= ddate:
            continue
        sdates = src.get("dates") or []
        snavs = src.get("nav") or []
        spers = src.get("per10k") or []
        if not sdates or len(sdates) != len(snavs):
            continue
        # 安全校验：两源共有日期的净值必须一致（浮点容差 1e-6）
        dmap = dict(zip(p.get("dates") or [], p.get("nav") or []))
        smap = dict(zip(sdates, snavs))
        common = set(dmap) & set(smap)
        for d in common:
            if abs(float(dmap[d]) - float(smap[d])) > 1e-6:
                details.append((p.get("id"), reg, "跳过：共有日 %s 净值不一致" % d))
                break
        else:
            before = p.get("latestDate") or ""
            n = 0
            for i, d in enumerate(sdates):
                if d <= ddate:
                    continue
                pk = spers[i] if i < len(spers) else None
                if _append_point(p, d, snavs[i], pk):
                    n += 1
            if n:
                changed += 1
                details.append((p.get("id"), reg, "%s -> %s (+%d 点)" % (before, p["latestDate"], n)))
    return changed, details


def sync_files(write=True):
    """读取两个 js 文件，回填；write=True 时写回 data.js。返回 (changed, details)。"""
    data = _load_js_var(DATA_JS, "REPORT_DATA")
    lib = _load_js_var(LIB_JS, "PRODUCT_LIBRARY")
    if data is None or lib is None:
        return 0, [("ERROR", "", "无法解析 data.js 或 library.js")]
    changed, details = sync(data, lib)
    if changed and write:
        with open(DATA_JS, "w", encoding="utf-8") as f:
            f.write("window.REPORT_DATA = " + json.dumps(data, ensure_ascii=False, indent=2) + ";\n")
    return changed, details


if __name__ == "__main__":
    import sys
    do_write = "--dry-run" not in sys.argv
    changed, details = sync_files(write=do_write)
    for d in details:
        print("  %-12s %-18s %s" % (d[0], d[1], d[2]))
    print("同步完成：更新 %d 只%s" % (changed, "" if do_write else "（DRY-RUN 未写文件）"))
