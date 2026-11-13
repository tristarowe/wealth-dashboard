#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""代销行官网产品公告采集器 —— 详情页 → 销售文件 PDF → 产品要素表结构化。

为什么需要它
------------
官方结构化接口没有「代销机构」字段；但代销行官网会在募集前 3~5 天发布
产品说明书/风险揭示书公告，其 PDF 要素表直接写明「产品销售机构」「风险等级」
「认购期」「成立日」。这是 A/B/F 级权威证据，也是补齐待售新品代销机构的主路径。

能力
----
- 详情页解析：标题 / 发布日期 / 公告ID / PDF 附件直链（含无 href 的文本路径）
- PDF 下载 + pdftotext -layout 转文本，全部落本地缓存
- 要素表解析：兼容「值排在标签上方」的跨行版式、机构间字段别名、
  风险等级语义句优先（避免误命中释义表里的 R1）
- 离线重解析：--reparse 不联网，只重跑缓存里的 txt（规则升级后零成本回补）
- 批量：--urls-file 一个 URL 一行；--demo 跑内置建行样本

依赖
----
Python 标准库（urllib）即可完成网络与解析；PDF 转文本需系统命令 `pdftotext`
（poppler-utils，Ubuntu: apt install poppler-utils；macOS: brew install poppler）。
缺失时脚本会明确提示，并保留 PDF 供后续手工处理。

用法
----
    python fetch_notice.py --url "https://wealth.ccb.com/.../20261105_1793871256.html"
    python fetch_notice.py --urls-file urls.txt --out 官网公告要素库.csv --gap 1
    python fetch_notice.py --demo
    python fetch_notice.py --reparse                 # 离线重解析缓存
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from rules import Rules, norm  # noqa: E402

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")

DEMO_URLS = [
    "https://wealth.ccb.com/chn/finance/productnews/newsdetail/20261105_1793871256.html",
    "https://wealth.ccb.com/chn/finance/productnews/newsdetail/20261102_1793612213.html",
    "https://wealth.ccb.com/chn/finance/productnews/newsdetail/20260928_1790578998.html",
]
# 部分 ccb 子站有 SSL legacy renegotiation 限制，统一回退到可访问域名
HOST_MAP = {
    "ccb.com": "wealth.ccb.com", "www.ccb.com": "wealth.ccb.com",
    "www2.ccb.com": "wealth.ccb.com", "finance3.ccb.com": "wealth.ccb.com",
    "privatebank.ccb.com": "wealth.ccb.com", "privatebank3.ccb.com": "wealth.ccb.com",
}

BANK_PAT = r"([\u4e00-\u9fa5]{2,20}(?:银行|信用社)(?:股份有限公司|有限责任公司)?)"

COLS = ["公告ID", "公告来源站点", "公告标题", "公告发布日期", "公告URL", "PDF链接",
        "产品名称", "登记编码", "产品代码", "销售代码", "产品管理人",
        "产品销售机构_全称", "产品销售机构_简称", "销售机构证据类型", "产品托管人",
        "风险等级原文", "风险等级_R级", "募集方式", "投资性质", "产品运作模式",
        "投资及收益币种", "认购期", "募集起始日期", "募集结束日期", "成立日",
        "最短持有期限", "产品存续期限", "说明书启用日期", "证据等级", "采集时间"]


# ---------------- 基础设施 ----------------
def short_bank(full):
    """全称 → 简称，多渠道用「；」分隔。"""
    if not full:
        return ""
    out = []
    for part in [x.strip() for x in re.split(r"[；;]", full) if x.strip()]:
        hit = None
        for k, v in _FULL2SHORT.items():
            if part == k or part in k or k in part:
                hit = v
                break
        out.append(hit or part)
    return "；".join(dict.fromkeys(out))


def _load_short_map(R):
    global _FULL2SHORT
    _FULL2SHORT = dict(R.full2short)


_FULL2SHORT = {}


def normalize_url(u):
    p = urllib.parse.urlparse(u)
    host = HOST_MAP.get(p.netloc.lower(), p.netloc)
    return p._replace(netloc=host, scheme="https").geturl()


def http_get(url, timeout=60, retries=2):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                data = r.read()
                if data:
                    return data
                last = "空响应"
        except Exception as e:
            last = str(e)[:140]
        if i < retries:
            time.sleep(2 + 2 * i)
    raise RuntimeError(f"GET 失败 {url} : {last}")


def parse_detail(html_bytes, url):
    html = html_bytes.decode("utf-8", "ignore")
    m = re.search(r"(\d{8}_\d+)\.html", url)
    nid = m.group(1) if m else re.sub(r"\W+", "_", url)[-40:]

    title = ""
    mt = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    if mt:
        title = re.sub(r"<[^>]+>", "", mt.group(1)).strip()
    title = re.sub(r"[\s|_\-]+中国建设银行.*$", "", title).strip()
    title = re.sub(r"\s+", " ", title)

    pub = ""
    mp = re.search(r"发布时间\s*[:：]?\s*(\d{4}-\d{2}-\d{2})", html)
    if mp:
        pub = mp.group(1)
    elif m:
        d = m.group(1)[:8]
        pub = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
    if not pub:
        mp = re.search(r"(20\d{2}-\d{2}-\d{2})", html)
        pub = mp.group(1) if mp else ""

    pdfs = []
    for href in re.findall(r'href\s*=\s*["\']([^"\']+\.pdf)["\']', html, re.I):
        pdfs.append(urllib.parse.urljoin(url, href))
    for href in re.findall(r'(/chn/attachDir/[^"\'\s<>]+\.pdf)', html):
        pdfs.append(urllib.parse.urljoin(url, href))
    pdfs = list(dict.fromkeys(pdfs))
    return {"公告ID": nid, "公告标题": title, "公告发布日期": pub,
            "公告URL": url, "PDF链接": pdfs,
            "公告来源站点": urllib.parse.urlparse(url).netloc}


def pdf_to_text(pdf_bytes, cache, nid):
    os.makedirs(cache, exist_ok=True)
    p_pdf = os.path.join(cache, nid + ".pdf")
    p_txt = os.path.join(cache, nid + ".txt")
    with open(p_pdf, "wb") as f:
        f.write(pdf_bytes)
    try:
        r = subprocess.run(["pdftotext", "-layout", p_pdf, p_txt],
                           capture_output=True, text=True)
    except FileNotFoundError:
        raise RuntimeError("缺少 pdftotext（poppler-utils）；PDF 已缓存到 " + p_pdf)
    if r.returncode != 0 or not os.path.exists(p_txt):
        raise RuntimeError("pdftotext 失败: " + r.stderr[:150])
    with open(p_txt, encoding="utf-8", errors="ignore") as f:
        return f.read()


# ---------------- 要素表解析 ----------------
def _anchor(txt, label, width=160):
    m = re.search(label + r"\s*[:：]?\s*", txt)
    return txt[m.end():m.end() + width] if m else ""


def _first_line(win):
    for ln in win.splitlines():
        s = ln.strip()
        if s:
            return s
    return ""


def _date_cn(s):
    m = re.search(r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", s)
    return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}" if m else ""


def _norm_name(s):
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"(?<=[\u4e00-\u9fa5·])\s+(?=[\dA-Za-z])", "", s)
    s = re.sub(r"(?<=[\dA-Za-z])\s+(?=[\u4e00-\u9fa5·])", "", s)
    return s.strip()


def to_r_level(raw):
    if not raw:
        return ""
    m = re.search(r"(?:PR|R)([1-5])", raw, re.I)
    if m:
        return "R" + m.group(1)
    for k, v in {"一级": "R1", "二级": "R2", "三级": "R3",
                 "四级": "R4", "五级": "R5"}.items():
        if k in raw:
            return v
    return ""


def parse_elements(txt):
    """从销售文件文本抽取产品要素表，字段名遵循监管统一规范，兼容机构别名。

    版式要点：pdftotext -layout 会把跨行单元格的「值」排在标签行【上方】，
    因此募集期用全文「日期A 至 日期B」主判，成立日/评级用标签前后双向窗口。
    风险等级必须优先取语义句「内部风险评级级别为 PR3/R2」，
    否则会误命中风险等级释义表里的 R1（释义表 5 个等级全列）。
    """
    d = {}
    m = re.search(r"Z\d{13}", txt)
    d["登记编码"] = m.group(0) if m else ""

    for mm in re.finditer(r"产品名称\s*[:：]?\s*", txt):
        w = txt[mm.end():mm.end() + 160]
        cand = re.sub(r"^\s*[（(]?A?\s*类份额[:：]?\s*", "", _first_line(w))
        if cand and len(cand) > 6 and "产品名称" not in cand:
            d["产品名称"] = _norm_name(cand)
            break
    d.setdefault("产品名称", "")

    d["产品代码"] = ""
    for lab in (r"产品代码", r"产品编号", r"产品编码"):
        w = _anchor(txt, lab)
        if w:
            mc = re.search(r"\b([A-Z0-9]{6,20})\b", _first_line(w))
            if mc:
                d["产品代码"] = mc.group(1)
                break
    d["销售代码"] = ""
    w = _anchor(txt, r"销售代码", 120)
    if w:
        mc = re.search(r"([A-Z0-9]{10,25})", w)
        d["销售代码"] = mc.group(1) if mc else ""

    d["产品销售机构_全称"] = ""
    d["销售机构证据类型"] = ""
    for mm in re.finditer(r"(?:产品销售机构|销售机构名称|代理销售机构名称)\s*[:：]?\s*", txt):
        w = txt[mm.end():mm.end() + 220]
        cand = _first_line(w)
        if "银行" not in cand and "信用社" not in cand:
            continue
        cand = re.sub(r"(及其他产品销售机构|等其他?销售机构|（如有）|\(如有\)|及其他机构).*$", "", cand)
        cand = cand.strip(" ：:；;，,。")
        banks = re.findall(BANK_PAT, cand)
        if banks:
            d["产品销售机构_全称"] = "；".join(dict.fromkeys(banks))
            d["销售机构证据类型"] = "A-说明书要素表直读"
            break
    if not d["产品销售机构_全称"]:
        mb = re.search(r"为([\u4e00-\u9fa5]{2,20}银行)（本产品的?代销机构）", txt)
        if mb:
            d["产品销售机构_全称"] = mb.group(1)
            d["销售机构证据类型"] = "B-正文明确点名代销机构"
    d["产品销售机构_简称"] = short_bank(d["产品销售机构_全称"])

    for key, lab in [("产品管理人", r"产品管理人"), ("产品托管人", r"产品托管人")]:
        cand = _first_line(_anchor(txt, lab, 120))
        d[key] = re.sub(r"(风险揭示|说明书|若|本产品|客户|份额).*$", "", cand).strip()

    raw = ""
    mr = re.search(r"(?:内部)?风险(?:评级)?级别为?\s*(PR[1-5]|R[1-5])\s*级?\s*"
                   r"([\u4e00-\u9fa5]{0,8}(?:风险)?)", txt)
    if mr:
        raw = (mr.group(1) + " " + mr.group(2)).strip()
    if not raw:
        mr = re.search(r"\b(PR[1-5])\b\s*([\u4e00-\u9fa5]{0,8}(?:风险)?)", txt)
        if mr:
            raw = (mr.group(1) + " " + mr.group(2)).strip()
    if not raw:
        for mm in re.finditer(r"产品内部风险评级", txt):
            win = txt[max(0, mm.start() - 160):mm.start()]
            mr = re.search(r"\b(PR[1-5]|R[1-5])\b\s*([\u4e00-\u9fa5]{0,8}(?:风险)?)", win)
            if mr:
                raw = (mr.group(1) + " " + mr.group(2)).strip()
                break
    if not raw:
        mr = re.search(r"([一二三四五]级\s*[（(][^)）]+[)）])", txt)
        raw = mr.group(1) if mr else ""
    if raw and not re.search(r"[\u4e00-\u9fa5]", raw):
        code = re.search(r"(?:PR|R)[1-5]", raw).group(0)
        m2 = re.search(re.escape(code) + r"\s*([\u4e00-\u9fa5]{2,6}风险)", txt)
        if m2:
            raw = code + " " + m2.group(1)
    d["风险等级原文"] = raw
    d["风险等级_R级"] = to_r_level(raw)

    def grab(labels, pattern, width=160):
        for lab in labels:
            mm = re.search(lab + r"\s*[:：]?\s*", txt)
            if not mm:
                continue
            for w in (txt[mm.end():mm.end() + width],
                      txt[max(0, mm.start() - 140):mm.start()]):
                hit = re.search(pattern, w)
                if hit:
                    return hit.group(1).strip()
        return ""

    d["募集方式"] = grab([r"产品募集方式", r"募集方式"], r"(公募|私募)")
    d["投资性质"] = grab([r"投资性质", r"产品类型"],
                        r"(固定收益类|权益类|商品及金融衍生品类|混合类)", 500)
    d["产品运作模式"] = grab([r"产品运作模式", r"运作方式", r"运作模式"],
                           r"(开放式净值型|封闭式净值型|开放式|封闭式)", 200)
    d["投资及收益币种"] = grab(
        [r"投资及收益币种", r"本金和收益币种", r"产品币种", r"募集币种"],
        r"(人民币|美元|欧元|港币|英镑|日元|澳元|外币)")
    d["产品存续期限"] = grab([r"产品存续期限", r"产品期限"],
                           r"(无固定期限|\d+\s*年|\d+\s*天)", 200)

    d["认购期"] = ""
    mrange = re.search(
        r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^。\n]{0,60}?至\s*"
        r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", txt)
    if mrange:
        g = mrange.groups()
        d["募集起始日期"] = f"{g[0]}-{int(g[1]):02d}-{int(g[2]):02d}"
        d["募集结束日期"] = f"{g[3]}-{int(g[4]):02d}-{int(g[5]):02d}"
        d["认购期"] = re.sub(r"\s+", " ", mrange.group(0)).strip()
    else:
        d["募集起始日期"] = ""
        d["募集结束日期"] = ""
        for lab in (r"认购期", r"募集期"):
            w = _anchor(txt, lab, 320)
            ds = re.findall(r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", w)
            if ds:
                iso = [f"{a}-{int(b):02d}-{int(c):02d}" for a, b, c in ds]
                d["募集起始日期"] = iso[0]
                d["募集结束日期"] = iso[1] if len(iso) > 1 else iso[0]
                break

    d["成立日"] = ""
    for lab in (r"(?m)^\s*产品成立日\s+", r"(?m)^\s*成立日\s+"):
        mm = re.search(lab, txt)
        if not mm:
            continue
        dd = _date_cn(txt[mm.end():mm.end() + 200])
        if dd:
            d["成立日"] = dd
            break
        ds = re.findall(r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日",
                        txt[max(0, mm.start() - 220):mm.start()])
        if ds:
            a, b, c = ds[-1]
            d["成立日"] = f"{a}-{int(b):02d}-{int(c):02d}"
            break

    d["最短持有期限"] = ""
    mh = re.search(r"最短持有\s*期限为?\s*(\d+)\s*个?(?:自然日|天|日)", txt)
    if mh:
        d["最短持有期限"] = mh.group(1) + "天"
    if not d["最短持有期限"]:
        mh = re.search(r"最短持有期限[^\n]{0,80}?(\d+)\s*个?自然日", txt)
        if mh:
            d["最短持有期限"] = mh.group(1) + "天"

    d["说明书启用日期"] = ""
    me = re.search(r"(?:说明书|风险揭示书)启用日期为?\s*"
                   r"(20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)", txt)
    if me:
        d["说明书启用日期"] = _date_cn(me.group(1))
    return d


# ---------------- 主流程 ----------------
def process_url(url, cache, gap, R):
    url = normalize_url(url)
    detail = parse_detail(http_get(url), url)
    nid, pdfs = detail["公告ID"], detail["PDF链接"]
    if not pdfs:
        print(f"  ! {nid} 详情页未发现 PDF 附件，仅记录公告元数据")
        rec = {c: "" for c in COLS}
        rec.update({k: detail.get(k, "") for k in
                    ("公告ID", "公告来源站点", "公告标题", "公告发布日期", "公告URL")})
        rec["证据等级"] = "无附件"
        rec["采集时间"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        return [rec]

    out = []
    for idx, pdf_url in enumerate(pdfs, 1):
        tag = nid if len(pdfs) == 1 else f"{nid}_{idx}"
        txt_path = os.path.join(cache, tag + ".txt")
        if os.path.exists(txt_path):
            with open(txt_path, encoding="utf-8", errors="ignore") as f:
                txt = f.read()
        else:
            print(f"  ↓ 下载 PDF {pdf_url}")
            txt = pdf_to_text(http_get(pdf_url, timeout=90, retries=3), cache, tag)
            time.sleep(gap)
        elems = parse_elements(txt)
        rec = {c: "" for c in COLS}
        rec.update({k: detail.get(k, "") for k in
                    ("公告ID", "公告来源站点", "公告标题", "公告发布日期", "公告URL")})
        rec["PDF链接"] = pdf_url
        for k, v in elems.items():
            if k in rec:
                rec[k] = v
        rec["证据等级"] = ("B/F-官网公告销售文件要素表" if rec["产品销售机构_全称"]
                          else "F-官网公告(销售机构字段未取到)")
        rec["采集时间"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        out.append(rec)
        print(f"  → {tag} | {rec['产品名称'][:26]} | 销售机构={rec['产品销售机构_全称'] or '(未取到)'}"
              f" | {rec['风险等级_R级']} | 募集 {rec['募集起始日期']}~{rec['募集结束日期']}")
    return out


def reparse(cache, out_csv):
    """离线重解析缓存 txt，不联网。"""
    txts = sorted(f for f in os.listdir(cache) if f.endswith(".txt")) if os.path.isdir(cache) else []
    if not txts:
        print("缓存中无 txt，无法离线重解析")
        return []
    rows = []
    for fn in txts:
        with open(os.path.join(cache, fn), encoding="utf-8", errors="ignore") as f:
            elems = parse_elements(f.read())
        rec = {c: "" for c in COLS}
        rec.update({k: v for k, v in elems.items() if k in rec})
        rec["公告ID"] = fn[:-4]
        rec["证据等级"] = "B/F-离线重解析"
        rec["采集时间"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        rows.append(rec)
        print(f"  {fn} → {rec['产品销售机构_简称'] or '(未取到)'} | {rec['风险等级_R级']}")
    write_csv(rows, out_csv)
    return rows


def write_csv(rows, path):
    if not rows:
        return
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows)
    print("已写出:", path, f"({len(rows)} 条)")


def main():
    ap = argparse.ArgumentParser(description="代销行官网产品公告采集器")
    ap.add_argument("--url", action="append", default=[], help="公告详情页 URL，可重复")
    ap.add_argument("--urls-file", help="URL 清单文件，一行一个")
    ap.add_argument("--demo", action="store_true", help="跑内置 3 条建行样本")
    ap.add_argument("--reparse", action="store_true", help="离线重解析缓存 txt（不联网）")
    ap.add_argument("--out", default="官网公告要素库.csv")
    ap.add_argument("--cache", default="notice_cache", help="PDF/txt 缓存目录")
    ap.add_argument("--gap", type=float, default=1.0, help="请求间隔秒（低频合规）")
    ap.add_argument("--config", help="规则配置 JSON 路径")
    a = ap.parse_args()

    R = Rules(a.config)
    _load_short_map(R)
    cache = os.path.abspath(a.cache)
    os.makedirs(cache, exist_ok=True)

    if a.reparse:
        reparse(cache, a.out)
        return 0

    urls = list(a.url)
    if a.urls_file:
        with open(a.urls_file, encoding="utf-8") as f:
            urls += [x.strip() for x in f if x.strip() and not x.startswith("#")]
    if a.demo or not urls:
        urls = DEMO_URLS
        print("未指定 URL，使用内置建行样本（--demo）")

    rows = []
    for i, u in enumerate(urls, 1):
        print(f"[{i}/{len(urls)}] {u}")
        try:
            rows += process_url(u, cache, a.gap, R)
        except Exception as e:
            print(f"  ! 采集失败（已跳过，可稍后错峰重试）: {e}")
        if i < len(urls):
            time.sleep(a.gap)
    write_csv(rows, a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
