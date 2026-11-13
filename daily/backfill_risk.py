"""补齐产品库缺失的风险等级。

先离线解析建行公告缓存的说明书文本（无需联网、无风控），
仍缺失的按发行机构批量拉取中国理财网产品列表，最后按登记编码单条兜底；
结果写入 daily/risk_levels.json 与 assets/risk_levels.js。
"""
import argparse
import glob
import json
import os
import re
import time
from pathlib import Path

import nav_bulk

ROOT = Path(__file__).resolve().parent.parent
LIB = ROOT / "assets" / "library.js"
RISK_JSON = ROOT / "daily" / "risk_levels.json"
RISK_JS = ROOT / "assets" / "risk_levels.js"

RISK_DECL = re.compile(r"(?:风险评级|风险等级|风险级别)\s*(?:为|[:：])?\s*[【\[（(]?\s*(?:PR|R)?\s*([1-5])")
RISK_CN = re.compile(r"(?:风险评级|风险等级|风险级别)\s*(?:为|[:：])?\s*[【\[（(]?\s*(低风险|中低风险|中风险|中高风险|高风险)")
CN_MAP = {"低风险": "R1", "中低风险": "R2", "中风险": "R3", "中高风险": "R4", "高风险": "R5"}


def load_lib():
    raw = LIB.read_text(encoding="utf-8")
    return json.loads(raw[raw.index("{"): raw.rindex("}") + 1])


def missing(items, levels):
    out = []
    for it in items:
        reg = it.get("regCode") or ""
        if reg and not (levels.get(reg) or (it.get("risk") or "").strip()):
            out.append(reg)
    return out


def risk_in_text(text):
    m = RISK_DECL.search(text)
    if m:
        return "R" + m.group(1)
    m = RISK_CN.search(text)
    return CN_MAP.get(m.group(1), "") if m else ""


def offline_from_cache(levels, want):
    """说明书 PDF 文本里「风险评级为【PR2】」这类明确声明，按登记编码回填。"""
    try:
        import fetch_newproducts as NP
    except Exception:
        return 0
    cache = getattr(NP, "CACHE", "")
    if not cache or not os.path.isdir(cache):
        return 0
    got = 0
    for path in glob.glob(os.path.join(cache, "*.txt")):
        try:
            text = open(path, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        regs = set(re.findall(r"Z\d{13}", text))
        if len(regs) != 1:          # 多产品合订本无法确定归属，跳过
            continue
        reg = next(iter(regs))
        if reg not in want or reg in levels:
            continue
        risk = risk_in_text(text)
        if risk:
            levels[reg] = risk
            got += 1
    print("离线缓存补齐 %d 条" % got, flush=True)
    return got


def bulk_by_org(orgs, want, levels):
    """按机构分页拉列表，命中 want 里的编码即记下风险等级。"""
    got = 0
    for org in orgs:
        page = 1
        while page <= 8 and (want - set(levels)):
            try:
                data = nav_bulk._call(
                    lambda: nav_bulk.client().search_products(org=org, page=page, size=50)
                ) or {}
            except Exception as exc:
                print("  ! %s 第%d页失败：%s" % (org, page, str(exc)[:80]), flush=True)
                break
            rows = data.get("list") or []
            if not rows:
                break
            for it in rows:
                reg = it.get("prodRegCode") or ""
                risk = nav_bulk.RISK_MAP.get(str(it.get("prodRiskLevel") or ""), "")
                if reg in want and risk and reg not in levels:
                    levels[reg] = risk
                    got += 1
            total = data.get("total") or 0
            if page * 50 >= total:
                break
            page += 1
            time.sleep(1.5)
    print("批量补齐 %d 条" % got, flush=True)


def one_by_one(regs, levels):
    got = 0
    for i, reg in enumerate(regs, 1):
        for attempt in range(3):
            try:
                meta = nav_bulk.product_meta(reg) or {}
                risk = (meta.get("risk") or "").strip()
                if risk:
                    levels[reg] = risk
                    got += 1
                    print("  [%d/%d] %s -> %s" % (i, len(regs), reg, risk), flush=True)
                    break
            except Exception as exc:
                print("  [%d/%d] %s 第%d次失败：%s" % (i, len(regs), reg, attempt + 1, str(exc)[:60]), flush=True)
                nav_bulk.reset_client()
                time.sleep(25 * (attempt + 1))
        time.sleep(2)
    print("单条补齐 %d 条" % got, flush=True)


def save(levels):
    RISK_JSON.write_text(json.dumps(levels, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    RISK_JS.write_text(
        "window.RISK_LEVELS = " + json.dumps(levels, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wait", type=int, default=0, help="开始前的冷却秒数")
    ap.add_argument("--skip-bulk", action="store_true")
    ap.add_argument("--offline-only", action="store_true", help="只用公告缓存补，不联网")
    a = ap.parse_args()

    lib = load_lib()
    levels = json.loads(RISK_JSON.read_text(encoding="utf-8")) if RISK_JSON.exists() else {}
    todo = missing(lib["items"], levels)
    print("待补 %d 条" % len(todo), flush=True)
    if not todo:
        return

    if a.wait:
        print("冷却 %ds 后开始" % a.wait, flush=True)
        time.sleep(a.wait)

    want = set(todo)
    offline_from_cache(levels, want)
    save(levels)
    if a.offline_only:
        print("仅离线模式，剩余 %d 条交由每日任务补齐" % len(want - set(levels)), flush=True)
        return

    if not a.skip_bulk:
        orgs = sorted({it.get("org") or "" for it in lib["items"] if it.get("org")})
        print("按 %d 家发行机构批量拉取" % len(orgs), flush=True)
        bulk_by_org(orgs, want, levels)
        save(levels)

    left = sorted(want - set(levels))
    print("仍需单条补 %d 条" % len(left), flush=True)
    if left:
        one_by_one(left, levels)
        save(levels)

    left = sorted(want - set(levels))
    print("完成，累计 %d 条，仍缺 %d 条" % (len(levels), len(left)), flush=True)
    if left:
        print("仍缺：" + ",".join(left), flush=True)


if __name__ == "__main__":
    main()
