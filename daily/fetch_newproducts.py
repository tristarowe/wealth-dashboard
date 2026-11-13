#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""新品预告抓取：建行官网「新品公告」全量列表 → 销售文件要素表 → 新品时间轴数据。

数据链路
--------
1) 建行 WCCMainPlatV5 / NF5011 公告列表（TG_TYPE=2776）分页抓取最近 N 天公告；
2) 标题预筛：剔除封闭式/外币，保留开放式（持有期、现金管理、日开、定开等）；
3) 逐条下载说明书 PDF，复用 wealth-newproduct-radar 的 parse_elements 解析要素表；
4) 口径：发行机构∈六大行/股份制银行理财子、开放式净值型、人民币、成立日≥今天；
5) 输出 daily/newproducts.json（原始库）与 assets/newproducts.js（前端）。

用法
----
    python daily/fetch_newproducts.py                 # 默认最近 10 天，最多 120 条
    python daily/fetch_newproducts.py --days 14 --limit 200 --gap 1.2
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta

import requests
import urllib3

urllib3.disable_warnings()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILL = os.path.expanduser(r"~\.trae-cn\skills\wealth-newproduct-radar")
sys.path.insert(0, os.path.join(SKILL, "scripts"))

from rules import Rules, norm                      # noqa: E402
import fetch_notice as FN                          # noqa: E402
from fetch_notice import process_url, UA           # noqa: E402


def _pdf_to_text(pdf_bytes, cache, nid):
    """pdftotext 不可用时的兜底：用 PyMuPDF 抽取文本并落盘缓存。"""
    os.makedirs(cache, exist_ok=True)
    p_pdf = os.path.join(cache, nid + ".pdf")
    p_txt = os.path.join(cache, nid + ".txt")
    with open(p_pdf, "wb") as f:
        f.write(pdf_bytes)
    try:
        import pymupdf
    except ImportError:                             # 兼容旧版包名
        import fitz as pymupdf
    doc = pymupdf.open(p_pdf)
    text = "\n".join(pg.get_text("text") for pg in doc)
    doc.close()
    with open(p_txt, "w", encoding="utf-8") as f:
        f.write(text)
    return text


FN.pdf_to_text = _pdf_to_text

BASE = "https://wealth.ccb.com/tran/WCCMainPlatV5"
LIST_PAGE = "https://wealth.ccb.com/chn/home/finance/zxgg.shtml"
DETAIL_HOST = "https://wealth.ccb.com"
CACHE = os.path.join(ROOT, "daily", ".np_cache")
RAW_OUT = os.path.join(ROOT, "daily", "newproducts.json")
JS_OUT = os.path.join(ROOT, "assets", "newproducts.js")

FOREIGN = re.compile(r"美元|欧元|港币|英镑|日元|澳元|外币|QDII", re.I)
CLOSED = re.compile(r"封闭式")
OPEN_KW = re.compile(r"开放|持有期|现金管理|日开|月开|季开|定开|定期开放|最短持有|天天|日日|滚续|"
                     r"\d+\s*天|周周|月月|半年|一年")


def session():
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Referer": LIST_PAGE})
    s.get(BASE, params={"CCB_IBSVersion": "V5", "SERVLET_NAME": "WCCMainPlatV5",
                        "TXCODE": "NHY000", "jsoncallback": "jsonpCallback"},
          timeout=30, verify=False)
    return s


def list_page(s, page, per_page=15):
    r = s.get(BASE, params={
        "CCB_IBSVersion": "V5", "isAjaxRequest": "true", "SERVLET_NAME": "WCCMainPlatV5",
        "TXCODE": "NF5011", "TG_TYPE": "2776", "PAGE": str(page), "PERPAGE": str(per_page),
        "KEYWORD": "", "jsoncallback": "financeListCallback",
    }, timeout=30, verify=False)
    txt = r.text.strip()
    m = re.search(r"financeListCallback\((.*)\)\s*;?\s*$", txt, re.S)
    body = m.group(1) if m else txt
    return json.loads(body)


def crawl_notices(days, max_pages=40):
    s = session()
    today = datetime.now()
    floor = (today - timedelta(days=days)).strftime("%Y-%m-%d")
    out, seen = [], set()
    for page in range(1, max_pages + 1):
        try:
            d = list_page(s, page)
        except Exception as exc:
            print("  列表第 %d 页失败：%s" % (page, exc))
            break
        items = d.get("LIST1") or []
        if not items:
            break
        stop = False
        for it in items:
            link = it.get("TITLE_LINK") or ""
            title = it.get("TITLE") or ""
            date = (it.get("STARTTIME") or "")[:10]
            if date and date < floor:
                stop = True
                continue
            if not link or link in seen:
                continue
            seen.add(link)
            out.append({"date": date, "title": title, "url": DETAIL_HOST + link})
        print("  列表 p%d：%d 条（累计 %d）" % (page, len(items), len(out)))
        if stop:
            break
    return out


def is_candidate(title):
    if FOREIGN.search(title) or CLOSED.search(title):
        return False
    return bool(OPEN_KW.search(title))


def norm_date(s):
    s = (s or "").strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        return s
    m = re.match(r"^(\d{4})/(\d{1,2})/(\d{1,2})$", s)
    if m:
        return "%s-%02d-%02d" % (m.group(1), int(m.group(2)), int(m.group(3)))
    return ""


def quota_wan(raw):
    """发行额度文本 → 万元数值。"""
    s = (raw or "").replace(",", "").replace("，", "")
    m = re.search(r"([\d.]+)\s*(亿|万)?", s)
    if not m:
        return None
    v = float(m.group(1))
    unit = m.group(2)
    if unit == "亿":
        v *= 10000
    elif not unit:
        v /= 10000.0
    return round(v, 2)


DATE = (r"[\[【]?(20\d{2})[\]】]?\s*年\s*[\[【]?(\d{1,2})[\]】]?\s*月\s*"
        r"[\[【]?(\d{1,2})[\]】]?\s*日")


def _d(m, i=0):
    return "%s-%02d-%02d" % (m.group(1 + i), int(m.group(2 + i)), int(m.group(3 + i)))


def extract_dates(flat):
    """从说明书正文抽取募集起止与成立日；多套要素表样式兜底。"""
    start = end = est = ""
    m = re.search(r"募集起始日期\s*[:：]?\s*" + DATE, flat)
    if m:
        start = _d(m)
    m = re.search(r"募集结束日期\s*[:：]?\s*" + DATE, flat)
    if m:
        end = _d(m)
    if not start:
        m = re.search(r"(?:募集期|认购期)\s*[:：]?\s*" + DATE +
                      r"(?:\s*\d{1,2}:\d{2})?\s*(?:（[^）]{0,10}）)?\s*(?:至|-|~|—)\s*" + DATE, flat)
        if m:
            start, end = _d(m), _d(m, 3)
        else:
            m = re.search(r"(?:募集期|认购期)\s*[:：]?\s*" + DATE, flat)
            if m:
                start = end = _d(m)
    if not end:
        end = start
    m = re.search(r"(?:理财产品成立日|产品成立日|成立日[期]?)\s*[:：]?\s*" + DATE, flat)
    if m:
        est = _d(m)
    if not est:
        m = re.search(r"产品成立日期\s*[:：]?\s*" + DATE, flat)
        if m:
            est = _d(m)
    return start, end, est


def plausible(ds, ref, lo=-60, hi=60):
    if not ds:
        return False
    d = datetime.strptime(ds, "%Y-%m-%d")
    return (d - ref).days >= lo and (d - ref).days <= hi


STAR = {"一": "1", "二": "2", "三": "3", "四": "4", "五": "5"}
CN_R = [("中低风险", "R2"), ("中高风险", "R4"), ("中等风险", "R3"),
        ("低风险", "R1"), ("中风险", "R3"), ("高风险", "R5")]


def extract_risk(flat):
    """风险等级：PR3 / 2级 / 二星级 / 要素表「产品风险等级 R2 中低风险」多种写法。"""
    m = re.search(r"风险(?:等级|级别|评级)\s*[:：]?\s*(?:PR|R)?\s*([1-5])", flat)
    if m:
        return "R" + m.group(1)
    m = re.search(r"风险(?:等级|级别|评级)\s*[:：]?\s*(中低风险|中高风险|中等风险|低风险|中风险|高风险)", flat)
    if m:
        return dict(CN_R)[m.group(1)]
    m = re.search(r"([一二三四五])\s*星级", flat)          # 光大：二星级（中低风险）
    if m:
        return "R" + STAR[m.group(1)]
    return ""


ANNOT = re.compile(r"[（(][^）)]*(?:最低持有|持有期|轮动|定开)[^）)]*[）)]")


def clean_name(name):
    """时间轴内的产品简称：去掉机构前缀/修饰词，机构已由左侧泳道展示。"""
    n = re.sub(r"^[（(][^）)]{2,12}[）)]", "", (name or "")).strip()
    n = re.sub(r"^[\u4e00-\u9fa5]{2,8}理财[·\-－—]?", "", n)
    n = ANNOT.sub("", n).strip()
    n = re.sub(r"^[\-－—·\s]+", "", n)
    # 品类/业务修饰词不是产品名的一部分（同「全站产品名称统一简称规则」）
    n = re.sub(r"(固定收益类|混合类|权益类|商品及金融衍生品类|理财产品)", "", n)
    n = re.sub(r"\s{2,}", " ", n).strip()
    return n or (name or "")


BANK_SHORT = {
    "中国建设银行": "建设银行", "中国工商银行": "工商银行", "中国农业银行": "农业银行",
    "中国邮政储蓄银行": "邮储银行", "中国民生银行": "民生银行", "中国光大银行": "光大银行",
    "中国华夏银行": "华夏银行", "上海浦东发展银行": "浦发银行", "浦东发展银行": "浦发银行",
    "中国平安银行": "平安银行", "中国兴业银行": "兴业银行", "中国中信银行": "中信银行",
    "中国招商银行": "招商银行", "中国广发银行": "广发银行", "中国渤海银行": "渤海银行",
    "中国浙商银行": "浙商银行", "中国恒丰银行": "恒丰银行",
}


def bank_short(name):
    s = re.sub(r"(股份有限公司|有限责任公司|有限公司)$", "", (name or "").strip()).strip()
    if s in BANK_SHORT:
        return BANK_SHORT[s]
    if s.startswith("中国") and s.endswith("银行") and len(s) > 5:
        return s[2:]
    return s


def clean_channels(raw):
    """代销机构：去重 + 统一银行简称；理财公司（发行机构）不算代销机构，直接剔除。"""
    parts = [p.strip() for p in re.split(r"[；;/,，]", raw or "") if p.strip()]
    out = []
    for p in parts:
        short = bank_short(p)
        if not short.endswith("银行") or "理财" in short:
            continue
        if short and short not in out:
            out.append(short)
    return "；".join(out)


def extract_quota(flat):
    m = re.search(r"(?:发行额度|计划募集规模|募集规模上限|发行规模|产品规模上限)[^。；]{0,24}?"
                  r"[\[【]?\s*([\d,\.]+)\s*[\]】]?\s*(亿元|万元)", flat)
    if not m:
        return None
    v = float(m.group(1).replace(",", ""))
    return round(v * 10000 if m.group(2) == "亿元" else v, 2)


def extract_manager(flat, R=None):
    """抽取理财产品管理人；PDF 里常带「指/以上评定结果为」等前缀，需回退白名单后缀匹配。"""
    cands = []
    m = re.search(r"理财产品管理人\s*[:：]?\s*([\u4e00-\u9fa5]{2,24}公司)", flat)
    if m:
        cands.append(m.group(1))
    cands += re.findall(r"([\u4e00-\u9fa5]{2,24}理财有限责任公司)", flat)
    cands += re.findall(r"([\u4e00-\u9fa5]{2,24}银行股份有限公司)", flat)
    if not R:
        return cands[0] if cands else ""
    known = {norm(k) for k in R.subs} | {norm(x) for x in R.national}
    for c in cands:
        for k in range(len(c), 3, -1):        # 由长到短，先命中即最贴切
            if norm(c[-k:]) in known:
                return c[-k:]
    return ""


def build():
    ap = argparse.ArgumentParser(description="新品预告抓取")
    ap.add_argument("--days", type=int, default=10)
    ap.add_argument("--limit", type=int, default=120)
    ap.add_argument("--gap", type=float, default=1.0)
    a = ap.parse_args()

    R = Rules()
    today = datetime.now().strftime("%Y-%m-%d")
    print("== 抓取建行新品公告列表（最近 %d 天）" % a.days)
    notices = crawl_notices(a.days)
    cand = [n for n in notices if is_candidate(n["title"])][: a.limit]
    print("公告 %d 条，开放式预筛后 %d 条进入 PDF 解析" % (len(notices), len(cand)))

    recs = []
    for i, n in enumerate(cand, 1):
        print("[%d/%d] %s" % (i, len(cand), n["title"][:40]))
        try:
            recs.extend(process_url(n["url"], CACHE, a.gap, R))
        except Exception as exc:
            print("  ! 失败：%s" % str(exc)[:160])

    items, established, dropped = [], [], 0
    seen = set()
    ref = datetime.now()
    for r in recs:
        nid = str(r.get("公告ID") or r.get("id") or "")
        flat = ""
        p_txt = os.path.join(CACHE, nid + ".txt")
        if nid and os.path.exists(p_txt):
            flat = re.sub(r"\s+", " ", open(p_txt, encoding="utf-8", errors="ignore").read())

        start, end, est = extract_dates(flat) if flat else ("", "", "")
        start = start or norm_date(r.get("募集起始日期"))
        end = end or norm_date(r.get("募集结束日期"))
        est = est or norm_date(r.get("成立日"))
        if not plausible(est, ref):
            dropped += 1
            continue
        if not plausible(start, ref, -60, 30):
            start = ""
        if not plausible(end, ref, -60, 30):
            end = ""

        issuer = extract_manager(flat, R) or (r.get("产品管理人") or "").strip()
        name = re.sub(r"^[（(][^）)]{2,12}[）)]", "", (r.get("产品名称") or "").strip())
        # 说明书写法「产品名称为【…】」会把前缀和书名号带进名称
        name = name.lstrip("为").lstrip("【[").rstrip("】]").strip()
        if name.endswith("理财产"):
            name += "品"
        reg = (r.get("登记编码") or "").strip()
        if not issuer or not name:
            dropped += 1
            continue
        if not R.in_whitelist(issuer):
            dropped += 1
            continue
        if not R.is_cny({"产品名称": name, "募集币种": r.get("投资及收益币种") or ""}):
            dropped += 1
            continue
        mode = (r.get("产品运作模式") or "")
        if mode and not R.is_open({"运作模式": mode}):
            dropped += 1
            continue
        if est < today:
            dropped += 1
            continue
        key = reg or name
        if key in seen:
            continue
        seen.add(key)
        item = {
            "name": name,
            "issuer": issuer,
            "short": clean_name(name),
            "regCode": reg,
            "raiseStart": start,
            "raiseEnd": end,
            "establish": est,
            "quotaWan": extract_quota(flat) if flat else quota_wan(r.get("发行额度")),
            "risk": extract_risk(flat) or (r.get("风险等级_R级") or "").upper(),
            "riskRaw": r.get("风险等级原文") or "",
            "mode": mode,
            "saleChannel": clean_channels(r.get("产品销售机构_简称") or ""),
            "source": "建行官网新品公告·销售文件要素表",
        }
        # 成立当天起不再作为「新品预告」展示，转入已在库清单，由 promote_newproducts.py 并入产品库
        if est <= today:
            established.append(item)
        else:
            items.append(item)

    items.sort(key=lambda x: (x["raiseStart"] or x["establish"], x["issuer"]))
    lanes = []
    for it in items:
        # 按代销机构分组（公告里的产品销售机构），不能用发行机构（理财公司）
        chans = [c for c in (it.get("saleChannel") or "").split("；") if c.strip()]
        short = chans[0].strip() if chans else "待核实"
        lane = next((l for l in lanes if l["channel"] == short), None)
        if not lane:
            lane = {"channel": short, "products": []}
            lanes.append(lane)
        lane["products"].append(it)
    lanes.sort(key=lambda l: (-len(l["products"]), l["channel"]))

    window_start = today
    window_end = (datetime.now() + timedelta(days=6)).strftime("%Y-%m-%d")
    payload = {
        "asOf": today,
        "fetchedAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": "六大行及股份制银行新品公告 · 销售文件要素表",
        "window": {"start": window_start, "end": window_end},
        "institutions": [l["channel"] for l in lanes],
        "items": items,
        "lanes": lanes,
        "stats": {"notices": len(notices), "candidates": len(cand), "kept": len(items), "dropped": dropped},
        "established": established,
    }
    with open(RAW_OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    ui_payload = {k: v for k, v in payload.items() if k != "established"}
    with open(JS_OUT, "w", encoding="utf-8") as f:
        f.write("window.NEW_PRODUCTS = " + json.dumps(ui_payload, ensure_ascii=False, indent=2) + ";\n")
    print("完成：公告 %d → 预筛 %d → 入库 %d 条，机构 %d 家"
          % (len(notices), len(cand), len(items), len(lanes)))
    print("机构：" + "、".join(l["channel"] for l in lanes))
    return 0


if __name__ == "__main__":
    sys.exit(build())
