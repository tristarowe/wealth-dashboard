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
SKILL_DIR = os.path.join(SKILL, "scripts")
if not os.path.isdir(SKILL_DIR):
    # 云端（GitHub Actions）没有本机 skill，用仓库内置副本兜底
    SKILL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "np", "skill", "scripts")
sys.path.insert(0, SKILL_DIR)

from rules import Rules, norm                      # noqa: E402
import fetch_notice as FN                          # noqa: E402
from fetch_notice import process_url, UA           # noqa: E402


def _pdf_to_text(pdf_bytes, cache, nid):
    """PDF → 文本并落盘缓存。

    2026-11-21 修复（线上长期「抓了 0 条」的根因）：
    原先只 try `import pymupdf`，而 CI 的 requirements 里没有 pymupdf、apt 也没装
    poppler-utils，于是每个候选品都在这里抛 ImportError，被 build() 的 try 吞掉，
    最终 stats 恒为 kept 0 / dropped 0（看起来像「没有新品」，其实是解析器全挂）。
    现在三级兜底：PyMuPDF → 系统 pdftotext → 明确报错（不再静默返回空）。
    """
    os.makedirs(cache, exist_ok=True)
    p_pdf = os.path.join(cache, nid + ".pdf")
    p_txt = os.path.join(cache, nid + ".txt")
    with open(p_pdf, "wb") as f:
        f.write(pdf_bytes)

    text = None
    try:                                            # 首选 PyMuPDF（纯 Python，CI 已加依赖）
        try:
            import pymupdf
        except ImportError:                         # 兼容旧版包名
            import fitz as pymupdf
        doc = pymupdf.open(p_pdf)
        text = "\n".join(pg.get_text("text") for pg in doc)
        doc.close()
    except Exception:
        text = None

    if not text:                                    # 兜底：系统 pdftotext（poppler-utils）
        try:
            import subprocess
            r = subprocess.run(["pdftotext", "-layout", p_pdf, "-"],
                               capture_output=True, timeout=120)
            if r.returncode == 0 and r.stdout:
                text = r.stdout.decode("utf-8", errors="ignore")
        except Exception:
            text = None

    if not text:
        raise RuntimeError("PDF 解析失败：请安装 pymupdf（pip install pymupdf）或 poppler-utils")

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


def enable_date_of(flat):
    """说明书/风险揭示书「启用日期」——再版说明书的有效日期锚点。

    2026-11-24 修复「中邮鸿运14天16号漏抓」：该品是 2025-06 已成立的老产品，
    2026-11-23 建行发的是**再版说明书**（启用日期 2026-11-25），正文认购期/成立日
    仍是 2025-06 的旧值。旧逻辑只认正文成立日 → plausible() 判过期 → 整条 drop。
    再版说明书当新品上架时，应以「启用日期」为本轮募集/成立锚点，才不会漏抓，
    也不会把一年前的历史日期画到新品时间轴上。
    """
    m = re.search(r"(?:说明书|风险揭示书)启用日期为?\s*" + DATE, flat or "")
    return _d(m) if m else ""


def extract_dates(flat):
    """从说明书正文抽取募集起止与成立日。

    2026-11-21 增强：建行代销的中银/建信系说明书是「标签一行、取值在下一行」的版式
    （如「认购期↵【2026】年【11】月【23】日，开放认购的时间为…」），旧规则要求标签与
    日期紧贴在同一行、且区间必须「日期 至 日期」连写，于是取不到日期 → 成立日为空 →
    plausible() 判假 → 全部被判 dropped，线上长期 0 条。改为：
    ① 标签命中后在固定窗口内取日期（允许换行）；② 两个日期之间只要出现「至/到/-」
       且间隔不长即视为区间，避免把「首日09:00 至末日15:30」这类描述误当第二日。
    """
    def dates_in(seg):
        return [(m, _d(m)) for m in re.finditer(DATE, seg)]

    def label_dates(label_re, span=160):
        """遍历标签的所有出现位置，返回第一个「标签后 span 字内既有日期」的结果。

        2026-11-23：旧版只检查第一个标签位置，若为释义句（如「认购登记日：指…」）无日期
        就直接返回空，不再看后面真正带日期的要素表行。改为继续遍历到第一个带日期的标签。
        """
        for m in re.finditer(label_re + r"\s*[:：]?\s*", flat):
            seg = flat[m.end():m.end() + span]
            dd = dates_in(seg)
            if dd:
                return seg, dd
        return "", []

    start = end = est = ""

    # ① 明确的起止字段
    seg, dd = label_dates(r"募集起始日(?:期)?")
    if dd:
        start = dd[0][1]
    seg, dd = label_dates(r"募集结束日(?:期)?")
    if dd:
        end = dd[0][1]

    # ② 募集期 / 认购期（建行代销版式的主路径）
    if not start:
        seg, dd = label_dates(r"(?:募集期|认购期|募集期限|认购期限|认购时间|募集时间)", span=160)
        if dd:
            start = dd[0][1]
            if len(dd) > 1:
                between = seg[dd[0][0].end():dd[1][0].start()]
                if len(between) <= 40 and re.search(r"至|到|—|–|-|~|～", between):
                    end = dd[1][1]
    if not end:
        end = start

    # ③ 成立日（2026-11-23 修复：优先精确标签 + 紧邻日期）
    # 旧逻辑用泛化标签「成立日」+ span=80，会先命中正文「成立日后的2个工作日…2026-12-02」
    # 这类说明文字里的日期，抢在要素表「产品成立日期 2026-12-01」之前 → 成立日多算一天。
    # 改为先取精确标签且日期紧跟（span=26），只认要素表直读；再回退宽泛标签，最后认购登记日。
    for lbl in (r"产品成立日期", r"理财产品成立日", r"产品成立日"):
        for m in re.finditer(lbl + r"\s*[:：]?\s*", flat):
            seg = flat[m.end():m.end() + 26]
            dd = dates_in(seg)
            if dd:
                est = dd[0][1]
                break
        if est:
            break
    if not est:
        seg, dd = label_dates(r"(?:理财产品成立日|产品成立日|产品成立日期|预计成立日|成立日期|成立日)", span=80)
        if dd:
            est = dd[0][1]
    # ③b 兜底：部分说明书（如招银）要素表标签被 PDF 断字成「产品成↵立日」而匹配不到，
    #     改取「认购登记日 / 产品登记日」的具体日期（等同成立/登记日）。label_dates 会
    #     跳过无日期的释义句，定位到真正带日期的行。
    if not est:
        seg, dd = label_dates(r"(?:认购登记日|产品登记日|认申购登记日)", span=60)
        if dd:
            est = dd[0][1]
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
    # 2026-11-24 兜底：①信银要素表写「风险评级为【PR2】」，标签与等级间夹「为【」；
    # ②交银写「产品风险评级↵较低风险产品（R2）」，等级在括号里。两者前两个正则都取不到。
    # 括号内必须显式带 R/PR 前缀（不能只写数字），否则会误命中页码「（3）」。
    m = re.search(r"风险(?:等级|级别|评级)\s*为?\s*[【\[]\s*(?:PR|R)\s*([1-5])\s*[】\]]", flat)
    if m:
        return "R" + m.group(1)
    m = re.search(r"风险(?:等级|级别|评级)[^\n]{0,40}?[（(]\s*(?:PR|R)\s*([1-5])\s*[）)]", flat)
    if m:
        return "R" + m.group(1)
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


BANK_ALIAS = {
    "建行": "建设银行", "工行": "工商银行", "农行": "农业银行", "中行": "中国银行",
    "交行": "交通银行", "邮储": "邮储银行", "招行": "招商银行", "浦发": "浦发银行",
    "中信": "中信银行", "光大": "光大银行", "民生": "民生银行", "兴业": "兴业银行",
    "广发": "广发银行", "平安": "平安银行", "华夏": "华夏银行", "浙商": "浙商银行",
    "渤海": "渤海银行", "恒丰": "恒丰银行",
}


def bank_short(name):
    s = (name or "").strip()
    # 去掉括号注释（如「汇丰银行（中国）」「中国建设银行（以下简称建行）」）
    s = re.sub(r"[（(][^）)]*[）)]", "", s).strip()
    # 分支行/营业部按总行归并：先按「银行」截断，兼容「××银行北京市分行」这类写法
    i = s.find("银行")
    if i >= 0:
        s = s[: i + 2]
    else:
        s = re.split(r"(?:分行|支行|营业部|分部)", s)[0].strip()
        s = re.sub(r"(股份有限公司|有限责任公司|有限公司).*$", "", s).strip()
    if s in BANK_SHORT:
        return BANK_SHORT[s]
    if s in BANK_ALIAS:
        return BANK_ALIAS[s]
    if s.startswith("中国") and s.endswith("银行") and len(s) > 5:
        return s[2:]
    return s


def clean_channels(raw):
    """代销机构：去重 + 统一银行简称；理财公司（发行机构）不算代销机构，直接剔除。"""
    parts = [p.strip() for p in re.split(r"[；;/,，、|\s]+", raw or "") if p.strip()]
    out = []
    for p in parts:
        short = bank_short(p)
        if not short.endswith("银行") or "理财" in short:
            continue
        if short and short not in out:
            out.append(short)
    return "；".join(out)


# 销售机构兜底（2026-11-23）：部分说明书无标准「产品销售机构」字段，但代销语境里明确写出。
# 只认销售/代销语境，绝不取「托管人：指XX银行」（会误把托管行当销售行）。
_SALE_PATTERNS = [
    re.compile(r"合作销售机构信息[^。；]{0,50}?企业名称\s*[:：]?\s*[【\[]?\s*"
               r"([\u4e00-\u9fa5]{2,12}银行(?:股份有限公司)?)"),
    re.compile(r"代销机构(?:/销售机构)?基本信息\s*[:：]?\s*[【\[]?\s*"
               r"([\u4e00-\u9fa5]{2,12}银行(?:股份有限公司)?)"),
    re.compile(r"代销机构/销售机构\s*[:：]?指\s*([\u4e00-\u9fa5]{2,12}银行(?:股份有限公司)?)"),
]


def sale_channel_fallback(flat):
    """标准字段缺失时，从代销语境兜底取销售机构全称；无明确证据返回空。"""
    c = re.sub(r"\s+", " ", flat or "")
    found = []
    for pat in _SALE_PATTERNS:
        for v in pat.findall(c):
            if v not in found:
                found.append(v)
    return "；".join(found)


# 募集规模上限的合理区间（单位：万元），即 100 万 ~ 500 亿。
# 2026-11-22 核实：中银理财同批三只说明书写「人民币【3000】亿元」（另两只写成「【3000 亿】元」），
# 单只新品募集上限不可能到 3000 亿（中银理财整体管理规模也远小于此），判为源文件单位笔误。
# 若照搬会直接在新品卡片上显示「3000亿」，故超出区间一律按「未披露」处理并留痕。
QUOTA_MIN_WAN, QUOTA_MAX_WAN = 100.0, 5000000.0
QUOTA_REJECT = []   # [(原文片段, 折算万)]，用于输出异常留痕


def extract_quota(flat):
    """说明书「募集规模上限」→ 万元。先抹平空白与【】，再按合理区间校验。

    抹平空白是必须的：同一批 PDF 里「【3000】亿元」与「【3000 亿】元」两种排版都有，
    不归一会导致同批产品有的解析出额度、有的解析不出（随机性本身就是不可信信号）。
    """
    s = re.sub(r"[\s\u3000]+", "", flat or "").replace("【", "").replace("】", "")
    m = re.search(r"(?:发行额度|计划募集规模|募集规模上限|发行规模|产品规模上限)"
                  r"[^。；]{0,24}?([\d,\.]+)(亿元|万元)", s)
    if not m:
        return None
    v = float(m.group(1).replace(",", ""))
    wan = round(v * 10000 if m.group(2) == "亿元" else v, 2)
    if not (QUOTA_MIN_WAN <= wan <= QUOTA_MAX_WAN):
        QUOTA_REJECT.append((m.group(0)[-24:], wan))
        print("  ! 募集规模异常：%s → %s万，按未披露处理" % (m.group(0)[-24:], wan))
        return None
    return wan


def sane_quota(from_pdf, raw_text):
    """PDF 额度优先，回退规则表「发行额度」，两条路径都要过合理区间。"""
    for v in (from_pdf, quota_wan(raw_text)):
        if v is None:
            continue
        if QUOTA_MIN_WAN <= v <= QUOTA_MAX_WAN:
            return v
        QUOTA_REJECT.append((str(raw_text or "")[:24], v))
    return None


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


def _nid_of(url):
    m = re.search(r"/(\d{8}_\d+)\.html", url or "")
    return m.group(1) if m else ""


def read_cached_text(nid):
    p = os.path.join(CACHE, nid + ".txt") if nid else ""
    if p and os.path.exists(p):
        return open(p, encoding="utf-8", errors="ignore").read()
    return ""


def own_detail_text(url, nid):
    """兜底取数：直接抓详情页 → PDF 直链 → 文本（不依赖 skill 解析器）。

    2026-11-21 新增。process_url 走 skill 的字段映射，遇到版式变化或依赖缺失会整条抛错；
    这里只做「拿到说明书写真文本」这一件事，字段解析统一交给本文件的规则，链路更短。
    """
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Referer": LIST_PAGE})
    html = s.get(url, timeout=40, verify=False).text
    links = re.findall(r'(?:href|src)="([^"]+\.pdf[^"]*)"', html, re.I)
    if not links:
        links = re.findall(r'([\w/\.\-]*attachDir[\w/\.\-]+\.pdf)', html, re.I)
    if not links:
        raise RuntimeError("详情页未找到 PDF 附件")
    pdf_url = links[0]
    if pdf_url.startswith("//"):
        pdf_url = "https:" + pdf_url
    elif pdf_url.startswith("/"):
        pdf_url = DETAIL_HOST + pdf_url
    data = s.get(pdf_url, timeout=90, verify=False).content
    if not data:
        raise RuntimeError("PDF 下载为空")
    return _pdf_to_text(data, CACHE, nid or ("tmp_" + str(int(datetime.now().timestamp()))))


# 要素表字段名（用于「标签 → 取值」切片，遇到下一个字段名即截断）
FIELD_LABELS = ["理财产品名称", "理财产品简称", "理财产品销售名称", "产品简称",
                "理财产品代码", "理财产品份额代码",
                "登记编码", "理财币种", "理财产品管理人", "理财产品托管人", "理财产品销售机构",
                "产品类型", "产品运作模式", "募集方式", "投资目标", "投资策略", "募集规模上限",
                "认购起点金额", "份额面值", "认购期", "募集期", "理财产品成立日", "产品成立日",
                "存续期限", "开放日", "份额净值", "确认日"]


def tidy_name(s):
    """清洗 PDF 抽取带来的空格：数字与汉字之间、连续空白（「稳富7 天持有期8 号」→「稳富7天持有期8号」）。"""
    s = re.sub(r"(?<=[0-9])\s+(?=[\u4e00-\u9fa5])", "", s or "")
    s = re.sub(r"(?<=[\u4e00-\u9fa5])\s+(?=[0-9])", "", s)
    return re.sub(r"\s{2,}", " ", s).strip()


def flat_field(flat, label, maxlen=90):
    """「标签 + 取值」切片：允许取值在标签下一行（建行代销说明书版式），遇下一字段名截断。"""
    for m in re.finditer(label + r"\s*[:：]?\s*", flat):
        seg = flat[m.end():m.end() + maxlen]
        cut = len(seg)
        for lb in FIELD_LABELS:
            i = seg.find(lb)
            if 0 < i < cut:
                cut = i
        val = seg[:cut].strip(" 　，,。；;:：")
        if val:
            return val
    return ""


def flat_reg_code(flat):
    m = re.search(r"登记编码\s*[:：]?\s*[\[【]?\s*([A-Za-z0-9]{6,})", flat)
    return m.group(1).upper() if m else ""


# 产品全称抽取（2026-11-23 修复）：
# 旧逻辑用 flat_field(flat, "理财产品名称") 取标签后取值，但两类版式会取错：
#   ① 招银/交银等说明书正文先出现「在同一理财产品名称下设置…」释义句 → 被当成取值；
#   ② 要素表真实标签是「产品名称」（无「理财」二字），「理财产品名称」匹配不到。
# 新逻辑：去空白愈合被 PDF 拆断的标签（「理财产 品名称」），收集所有「(理财)产品名称」候选，
# 遇下一字段名截断 + 取值形态校验（排除释义句），取第一个像产品名的。
_NAME_BAD = re.compile(r"下设置|指本|区分不同|销售名称|资产净值|产品销售代码|本说明书|"
                       r"以下简称|投资者|风险揭示|第\d+页|查询产品信息|登记编码项下")
_NAME_STOP = ["理财信息登记系统", "产品登记编码", "登记编码", "产品代码", "份额代码", "销售代码",
              "产品销售名称", "产品简称", "产品类型", "发行机构名称", "产品概况", "理财币种",
              "产品运作模式", "募集方式", "产品成立日", "理财产品成立日", "成立日", "存续期限",
              "开放日", "份额净值", "确认日", "认购起点", "投资目标", "投资策略"]
_NAME_LABEL = re.compile(r"(?:理财)?产品名称\s*[:：]?\s*")


def extract_product_name(flat, fallback=""):
    """从说明书抽取产品全称：要素表标签优先 + 形态校验，跳过释义句。"""
    c = re.sub(r"\s+", "", flat or "")  # 去空白，愈合「理财产 品名称」「147 号」等
    for m in _NAME_LABEL.finditer(c):
        seg = c[m.end():m.end() + 90]
        cut = len(seg)
        for lb in _NAME_STOP:
            i = seg.find(lb)
            if 0 < i < cut:
                cut = i
        val = seg[:cut].strip("【[:：]】")
        val = re.sub(r"^为", "", val).strip()
        if not val or len(val) < 6 or len(val) > 46 or _NAME_BAD.search(val):
            continue
        if not re.search(r"理财|号|日开|天天|持有期|现金管理|鸿运|安盈象|添利宝|悦享|稳富|稳享|"
                         r"阳光金|固收|增鑫|招睿", val):
            continue
        # 去尾部括号内容（产品代码等），如 158号（26GS0764）→ 158号；残留的孤立「（」也去掉
        val = re.sub(r"[（(][^）)]*[）)]?\s*$", "", val).strip()
        return val
    return fallback


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

    rows = []
    failed = []
    for i, n in enumerate(cand, 1):
        nid = _nid_of(n["url"])
        print("[%d/%d] %s" % (i, len(cand), n["title"][:40]))
        recs = []
        try:
            recs = process_url(n["url"], CACHE, a.gap, R)
        except Exception as exc:
            print("  ! 解析器失败：%s" % str(exc)[:160])
        flat = read_cached_text(nid)
        if not flat:
            try:
                flat = own_detail_text(n["url"], nid)
                print("  · 已用兜底链路取到说明书文本")
            except Exception as exc:
                print("  ! 兜底取数失败：%s" % str(exc)[:120])
                failed.append({"title": n["title"], "url": n["url"], "reason": str(exc)[:160]})
        if not recs and flat:
            recs = [{"公告ID": nid, "产品名称": ""}]
        if not recs:
            failed.append({"title": n["title"], "url": n["url"], "reason": "无可用说明书文本"})
        for r in recs:
            rows.append((n, r, flat))

    items, established, dropped = [], [], 0
    seen = set()
    ref = datetime.now()
    for n, r, raw_flat in rows:
        nid = str(r.get("公告ID") or _nid_of(n["url"]))
        flat = raw_flat or read_cached_text(nid)
        flat = re.sub(r"\s+", " ", flat) if flat else ""

        start, end, est = extract_dates(flat) if flat else ("", "", "")
        start = start or norm_date(r.get("募集起始日期"))
        end = end or norm_date(r.get("募集结束日期"))
        est = est or norm_date(r.get("成立日"))
        # 2026-11-24 再版说明书兜底：正文认购/成立日是老产品首次发行的旧日期（如中邮
        # 鸿运14天16号=2025-06），但启用日期在本期窗口内，说明这是再版上架的新品。
        # 用启用日期作为本轮募集/成立锚点，既避免 plausible() 误判过期漏抓，也不会
        # 把一年前的历史日期画到时间轴上；无启用日期的普通新品不受影响。
        enable = enable_date_of(flat)
        if enable and plausible(enable, ref) and (not plausible(est, ref) or est < enable):
            start = end = est = enable
        if not plausible(est, ref):
            dropped += 1
            continue
        if not plausible(start, ref, -60, 30):
            start = ""
        if not plausible(end, ref, -60, 30):
            end = ""

        issuer = extract_manager(flat, R) or (r.get("产品管理人") or "").strip()
        # 名称优先取要素表原文（说明书「(理财)产品名称」），其次解析器字段，最后退回公告标题
        name = (extract_product_name(flat) if flat else "") or (r.get("产品名称") or "")
        name = re.sub(r"^[（(][^）)]{2,12}[）)]", "", name.strip())
        # 说明书写法「产品名称为【…】」会把前缀和书名号带进名称
        name = name.lstrip("为").lstrip("【[").rstrip("】]").strip()
        if name.endswith("理财产"):
            name += "品"
        if not name:
            name = re.sub(r"-\s*[A-Z0-9]{6,}.*$", "", re.sub(r"^[（(][^）)]{2,12}[）)]", "", n["title"]))
        name = tidy_name(name)
        reg = (r.get("登记编码") or "").strip() or flat_reg_code(flat)
        if not issuer or not name:
            dropped += 1
            continue
        if not R.in_whitelist(issuer):
            dropped += 1
            continue
        cur = flat_field(flat, r"理财币种", 20) or r.get("投资及收益币种") or ""
        if not R.is_cny({"产品名称": name, "募集币种": cur}):
            dropped += 1
            continue
        mode = flat_field(flat, r"产品运作模式", 40) or (r.get("产品运作模式") or "")
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
        # 代销机构：三个来源按可信度取——解析器字段 > 说明书标准标签 > 代销语境兜底。
        # flat_field 单独用会命中正文噪音（如「销售服务费支付给理财产品销售机构」），
        # 故先各自 clean_channels，取第一个非空结果，避免噪音顶掉后面的有效来源。
        channel_raw = ""
        for cand in (r.get("产品销售机构_简称") or "",
                     flat_field(flat, r"理财产品销售机构", 120),
                     sale_channel_fallback(flat)):
            if clean_channels(cand):
                channel_raw = cand
                break
        # 2026-11-24 修复「未匹配代销机构」：本脚本全部数据来自建行官网「新品公告」，
        # 说明书里产品即通过建设银行代销。招银/工银等部分销售文件要素表未写明确的
        # 代销语境标签，导致 saleChannel 为空、卡片显示「待核实」。既然来源确定是
        # 建行公告渠道，三来源都取不到时统一回填「建设银行」，与交银147/信银258
        # 之前的补法一致；不臆造其它渠道，只认本脚本的建行来源事实。
        if not clean_channels(channel_raw):
            channel_raw = "建设银行"
        item = {
            "name": name,
            "issuer": issuer,
            "short": clean_name(name),
            "regCode": reg,
            "raiseStart": start,
            "raiseEnd": end,
            "establish": est,
            # 2026-11-22 用户定案：首发额度（≠募集规模）公开渠道无字段，一律不输出数值，
            # 页面额度位固定显示「—」。说明书里的「发行额度」并非首发额度，且出现过
            # 「【3000】亿元」这类单位笔误，故不再作为额度对外披露。
            "quotaWan": None,
            "risk": extract_risk(flat) or (r.get("风险等级_R级") or "").upper(),
            "riskRaw": r.get("风险等级原文") or "",
            "mode": mode,
            "saleChannel": clean_channels(channel_raw),
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
    # 2026-11-21：窗口由 7 天放宽到 8 天（今天起含今天共 8 列）。周六跑时正好覆盖
    # 「下周一募集、下周日成立」，原 7 天窗口会把周日成立/周日截止募集的新品裁掉；
    # 再放宽到 10 天则横屏每列只剩 78px，产品名会被挤成省略号，故取 8 天折中。
    window_end = (datetime.now() + timedelta(days=7)).strftime("%Y-%m-%d")
    payload = {
        "asOf": today,
        "fetchedAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": "六大行及股份制银行新品公告 · 销售文件要素表",
        "window": {"start": window_start, "end": window_end},
        "institutions": [l["channel"] for l in lanes],
        "items": items,
        "lanes": lanes,
        "stats": {"notices": len(notices), "candidates": len(cand), "kept": len(items),
                  "dropped": dropped, "failed": len(failed),
                  "quotaRejected": len(QUOTA_REJECT)},
        "failed": failed[:20],
        "established": established,
    }
    with open(RAW_OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    ui_payload = {k: v for k, v in payload.items() if k not in ("established", "failed")}
    with open(JS_OUT, "w", encoding="utf-8") as f:
        f.write("window.NEW_PRODUCTS = " + json.dumps(ui_payload, ensure_ascii=False, indent=2) + ";\n")
    print("完成：公告 %d → 预筛 %d → 入库 %d 条，机构 %d 家，解析失败 %d 条"
          % (len(notices), len(cand), len(items), len(lanes), len(failed)))
    print("机构：" + "、".join(l["channel"] for l in lanes))
    for f in failed[:10]:
        print("  × %s ｜ %s" % (f["title"][:40], f["reason"][:100]))
    return 0


if __name__ == "__main__":
    sys.exit(build())
