#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""理财新品抓取 —— 口径规则引擎（纯标准库，无第三方依赖，可独立 import / 自检）。

把本项目一路踩坑沉淀下来的口径全部固化为纯函数：
  机构白名单 / 状态与口径2 / 开放式 / 人民币 / 地方性银行 /
  R级风险等级 / 代销机构简称 / 登记编码去重 / 分页完整性断言 / 证据分级。

设计原则
--------
- 零外部依赖：只用 Python 标准库，TRAE 里开箱即用。
- 配置外置：白名单、简称表、映射表都在 assets/config.json，改配置不改代码。
- 可自检：`python rules.py --selftest` 用内置样例验证全部规则，无需联网。
- 纯函数：输入 dict/str，输出 dict/list/str/bool，无副作用、无硬编码绝对路径。

用法
----
    from rules import Rules
    R = Rules()                          # 自动加载同包 assets/config.json
    rows = R.filter_all(rows, today="2026-11-10")
    R.assert_coverage(pages, total=582)  # 抓不全直接抛错，绝不静默
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from collections import OrderedDict

_HERE = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_CONFIG = os.path.join(_HERE, "..", "assets", "config.json")

FOREIGN = re.compile(r"美元|USD|欧元|港币|英镑|日元|澳元|外币|QDII", re.I)
BANK_WORDS = re.compile(r"银行|信用社|农商|城商|农信|村镇|农合")


def norm(s):
    """归一化机构名：去公司后缀与空格，便于简写兼容匹配。"""
    return re.sub(r"(股份)?有限(责任)?公司", "", (s or "")).replace(" ", "").strip()


class Rules:
    """口径规则集合。所有阈值/名单来自 config.json。"""

    def __init__(self, config_path=None):
        p = config_path or _DEFAULT_CONFIG
        with open(p, encoding="utf-8") as f:
            self.cfg = json.load(f)
        c = self.cfg
        self.subs = c["理财公司白名单"]["映射"]
        self.national = c["全国性银行白名单"]["列表"]
        self.full2short = c["代销机构简称"]
        self.short2full = c["简称还原全称"]
        self.cn2r = c["R级风险等级"]["中文等级映射"]
        self.out_cols = c["输出列"]
        self.field_map = c["接口字段映射"]
        self._sub_norm = {norm(k) for k in self.subs}
        self._nat_norm = [norm(x) for x in self.national]

    # ---------------- 机构白名单 ----------------
    def in_whitelist(self, org):
        """发行机构是否在白名单内。

        理财公司必须【精确相等】，避免「施罗德交银理财」被「交银理财」误纳、
        「贝莱德建信理财」与「建信理财」混淆；银行允许简写兼容。
        """
        o = norm(org)
        if o in self._sub_norm:
            return True
        return any(b and (b == o or b in o or o in b) for b in self._nat_norm)

    def issuer_category(self, org):
        return "理财公司" if norm(org) in self._sub_norm else "母行/银行"

    # ---------------- 地方性银行 ----------------
    def is_local_bank(self, name):
        """该代销渠道是否为地方性银行。

        不属于全国性银行白名单的银行类机构（城商行/农商行/农信社/村镇银行）。
        空值、管理人直销（含『理财/直销』且无银行字样）、全国性银行 → False。
        """
        n = norm(name)
        if not n:
            return False
        if n in self.short2full:            # 简称先还原，判为全国性
            return False
        if any(b and (b == n or b in n or n in b) for b in self._nat_norm):
            return False
        if ("理财" in n or "直销" in n) and not BANK_WORDS.search(n):
            return False                     # 管理人直销，非银行渠道
        return bool(BANK_WORDS.search(n))

    @staticmethod
    def split_agents(s):
        return [x.strip() for x in (s or "").split("；") if x.strip()]

    def short_bank(self, full):
        """全称 → 简称；多渠道用「；」分隔。"""
        if not full:
            return ""
        out = []
        for part in self.split_agents(full):
            hit = self.full2short.get(part)
            if not hit:
                for k, v in self.full2short.items():
                    if part in k or k in part:
                        hit = v
                        break
            out.append(hit or part)
        return "；".join(dict.fromkeys(out))

    def list_hits(self, full):
        """按全称匹配全国性银行名单，输出简称交集（指定名单内代销行）。"""
        out = []
        for part in self.split_agents(full):
            n = norm(part)
            for k, v in self.short2full.items():
                vn = norm(v)
                if vn == n or vn in n or n in vn:
                    out.append(k)
                    break
            else:
                if any(norm(b) == n for b in self.national):
                    out.append(part)
        return "；".join(dict.fromkeys(out))

    def collapse_agents(self, short_s, full_s):
        """剔掉地方性渠道，返回 (新简称, 新全称, 被剔除渠道)。

        简称与全称按位置一一对应；长度不等时各自独立判定，保证不误删。
        """
        shorts, fulls = self.split_agents(short_s), self.split_agents(full_s)
        paired = len(shorts) == len(fulls)
        keep_s, keep_f, removed = [], [], []
        for i, s in enumerate(shorts):
            f = fulls[i] if paired and i < len(fulls) else s
            if self.is_local_bank(f) or self.is_local_bank(s):
                removed.append(s)
            else:
                keep_s.append(s)
                keep_f.append(f)
        if not paired:
            for f in fulls:
                if not self.is_local_bank(f) and f not in keep_f:
                    keep_f.append(f)
        return ("；".join(dict.fromkeys(keep_s)),
                "；".join(dict.fromkeys(keep_f)), removed)

    def filter_local_banks(self, rows, verbose=False):
        """地方性银行口径（默认『仅剔除纯地方性』）：返回 (保留行, 统计)。

        纯地方性 → 整条剔除；混合渠道 → 保留并收敛代销机构、留痕来源；
        空值/管理人直销 → 保留。幂等，可重复调用。
        """
        kept, dropped, collapsed = [], [], []
        for r in rows:
            short = r.get("代销机构", "") or ""
            full = r.get("代销机构_全称", "") or short
            parts = self.split_agents(full) or self.split_agents(short)
            if not parts:
                kept.append(r)
                continue
            local = [p for p in parts if self.is_local_bank(p)]
            if not local:
                kept.append(r)
                continue
            if len(local) == len(parts):
                dropped.append((r.get("登记编码", ""), r.get("产品名称", ""), full))
                continue
            new_s, new_f, removed = self.collapse_agents(short, full)
            r["代销机构"] = new_s
            if "代销机构_全称" in r:
                r["代销机构_全称"] = new_f
            if "指定名单内代销行" in r:
                r["指定名单内代销行"] = self.list_hits(new_f)
            if "代销机构来源" in r and "口径过滤" not in (r.get("代销机构来源") or ""):
                r["代销机构来源"] = (r.get("代销机构来源") or "") + \
                    "；口径过滤：已剔除地方性银行渠道【" + "、".join(removed) + "】"
            if "代销机构可信等级" in r and "多渠道" in (r.get("代销机构可信等级") or ""):
                if "已收敛" not in r["代销机构可信等级"]:
                    r["代销机构可信等级"] += "(已收敛掉地方性渠道)"
            collapsed.append((r.get("登记编码", ""), r.get("产品名称", ""), full, new_s))
            kept.append(r)
        stat = dict(before=len(rows), after=len(kept), dropped=dropped, collapsed=collapsed)
        if verbose:
            print(f"地方性银行过滤：{stat['before']} → {stat['after']} 条"
                  f"（整条剔除 {len(dropped)}，收敛 {len(collapsed)}）")
            for c, name, full in dropped:
                print(f"  [剔除] {c} | {name[:26]} | {full}")
            for c, name, old, new in collapsed:
                print(f"  [收敛] {c} | {name[:26]} | {old} → {new}")
        return kept, stat

    # ---------------- 业务口径 ----------------
    @staticmethod
    def is_open(r):
        """是否开放式净值型。"""
        m = r.get("运作模式", "") or ""
        if "开放式" in m:
            return True
        if "封闭式" in m:
            return False
        e = r.get("产品结束日期", "") or ""
        return e.startswith(("9999", "2099"))   # 无固定期限

    @staticmethod
    def is_cny(r):
        """是否人民币。产品名含外币关键词一律排除；币种为空视为人民币。"""
        if FOREIGN.search(r.get("产品名称", "") or ""):
            return False
        c = (r.get("募集币种", "") or "").upper()
        return ("人民币" in c or "CNY" in c) if c else True

    @staticmethod
    def scope2(r, today):
        """口径2：今日起仍可申购 = 募集结束日 >= 今天 且 状态∈{待售,募集}。"""
        return (r.get("募集结束日期", "") or "") >= today and \
               r.get("产品状态", "") in ("待售", "募集")

    @staticmethod
    def scope1(r, today):
        """口径1：今日及未来开募 = 募集起始日 >= 今天。"""
        return (r.get("募集起始日期", "") or "") >= today

    def filter_all(self, rows, today, mode="open", ccy="CNY", scope="2",
                   whitelist=True, dedup=True, verbose=False):
        """完整过滤链，返回最终清单的行列表（不写文件）。

        顺序：白名单 → 状态/口径 → 运作模式 → 币种 → 登记编码去重 → 地方性银行。
        """
        sel = []
        for r in rows:
            if whitelist and not self.in_whitelist(r.get("发行机构", "")):
                continue
            if not (self.scope2(r, today) if scope == "2" else self.scope1(r, today)):
                continue
            if mode == "open" and not self.is_open(r):
                continue
            if ccy == "CNY" and not self.is_cny(r):
                continue
            sel.append(dict(r))
        if dedup:
            seen = OrderedDict()
            for r in sel:
                seen.setdefault(r.get("登记编码", ""), r)
            sel = list(seen.values())
        sel.sort(key=lambda x: (x.get("募集起始日期", ""), x.get("登记编码", "")))
        sel, stat = self.filter_local_banks(sel, verbose=verbose)
        if verbose:
            print(f"过滤链完成：today={today} scope={scope} mode={mode} ccy={ccy} → {len(sel)} 条")
        return sel

    # ---------------- 风险等级 ----------------
    def cn_to_r(self, cn):
        for k, v in self.cn2r.items():
            if k in (cn or ""):
                return v
        return ""

    @staticmethod
    def to_r_level(raw):
        """销售文件原文 PR3 / R3 / 三级(中) → R3。"""
        m = re.search(r"\b(?:PR|R)([1-5])\b", raw or "", re.I)
        if m:
            return "R" + m.group(1)
        m = re.search(r"([一二三四五])级", raw or "")
        return {"一": "R1", "二": "R2", "三": "R3", "四": "R4", "五": "R5"}.get(
            m.group(1), "") if m else ""

    # ---------------- 完整性断言 ----------------
    @staticmethod
    def assert_coverage(pages, total, code_field="登记编码"):
        """分页完整性断言：抓到页去重后条数必须等于 total，否则抛错。

        pages: 每页的响应 dict，需含 data.currentPage / data.data（列表）。
        返回 (去重条数, 缺失页码列表)。这是防止『静默漏抓』的关键闸门。
        """
        got, seen, page_nos = 0, set(), []
        for pg in pages:
            d = (pg.get("data") or {})
            page_nos.append(d.get("currentPage"))
            for item in (d.get("data") or []):
                c = item.get(code_field) or item.get("prodRegCode")
                if c and c not in seen:
                    seen.add(c)
                    got += 1
        if got != total:
            raise RuntimeError(
                f"快照不完整：total={total} 实际去重={got}，缺 {total - got} 条。"
                f"已抓页 {sorted({p for p in page_nos if p is not None})}；"
                f"请错峰续跑补齐，切勿把不完整快照当全量。")
        return got, []

    # ---------------- 字段映射 ----------------
    def from_api(self, item):
        """平台明文 JSON 单条 → 中文列 dict。"""
        out = {}
        for src, dst in self.field_map.items():
            v = item.get(src, "")
            if v is None or v == 0 or v == 0.0:
                v = ""
            out[dst] = str(v)
        for c in self.out_cols:
            out.setdefault(c, "")
        return out


# ---------------- 自检（无需联网 / 无需数据文件）----------------
def selftest(R):
    cases, failed = 0, []

    def ck(label, got, want):
        nonlocal cases
        cases += 1
        if got != want:
            failed.append(f"{label}: 期望 {want!r} 实际 {got!r}")

    # 机构白名单
    ck("白名单-理财公司", R.in_whitelist("中邮理财有限责任公司"), True)
    ck("白名单-股份行简写", R.in_whitelist("中信银行股份有限公司"), True)
    ck("白名单-误纳施罗德", R.in_whitelist("施罗德交银理财有限公司"), False)
    ck("白名单-城商行", R.in_whitelist("宁波银行股份有限公司"), False)

    # 地方性银行判定
    ck("地方性-宁波银行", R.is_local_bank("宁波银行股份有限公司"), True)
    ck("地方性-嘉兴银行", R.is_local_bank("嘉兴银行"), True)
    ck("地方性-东莞银行", R.is_local_bank("东莞银行"), True)
    ck("地方性-全国性全称", R.is_local_bank("中信银行股份有限公司"), False)
    ck("地方性-全国性简称", R.is_local_bank("中信"), False)
    ck("地方性-管理人直销", R.is_local_bank("平安理财有限责任公司（管理人直销）"), False)
    ck("地方性-空值", R.is_local_bank(""), False)

    # 收敛
    s, f, rm = R.collapse_agents("东莞银行；中信", "东莞银行；中信银行股份有限公司")
    ck("收敛-简称", s, "中信")
    ck("收敛-全称", f, "中信银行股份有限公司")
    ck("收敛-剔除", rm, ["东莞银行"])

    rows = [
        {"登记编码": "A1", "产品名称": "纯地方性", "代销机构": "宁波银行",
         "代销机构_全称": "宁波银行股份有限公司", "代销机构来源": "A-标题", "指定名单内代销行": ""},
        {"登记编码": "A2", "产品名称": "混合", "代销机构": "东莞银行；中信",
         "代销机构_全称": "东莞银行；中信银行股份有限公司",
         "代销机构可信等级": "A-多渠道", "代销机构来源": "A-标题", "指定名单内代销行": "中信"},
        {"登记编码": "A3", "产品名称": "全国性", "代销机构": "建行",
         "代销机构_全称": "中国建设银行股份有限公司", "代销机构来源": "B-说明书", "指定名单内代销行": "建行"},
        {"登记编码": "A4", "产品名称": "待实测", "代销机构": "",
         "代销机构_全称": "", "代销机构来源": "已检测", "指定名单内代销行": ""},
    ]
    kept, st = R.filter_local_banks(rows)
    by_code = {r["登记编码"]: r for r in kept}
    ck("过滤-保留数", len(kept), 3)
    ck("过滤-剔除数", len(st["dropped"]), 1)
    ck("过滤-收敛数", len(st["collapsed"]), 1)
    ck("过滤-收敛结果", by_code["A2"]["代销机构"], "中信")
    ck("过滤-收敛全称", by_code["A2"]["代销机构_全称"], "中信银行股份有限公司")
    ck("过滤-留痕", "口径过滤" in by_code["A2"]["代销机构来源"], True)
    ck("过滤-空值保留", by_code["A4"]["代销机构"], "")
    # 幂等
    kept2, st2 = R.filter_local_banks(kept)
    by2 = {r["登记编码"]: r for r in kept2}
    ck("过滤-幂等", len(kept2), 3)
    ck("过滤-幂等无重复留痕", by2["A2"]["代销机构来源"].count("口径过滤"), 1)

    # 业务口径
    base = {"发行机构": "中邮理财有限责任公司", "产品状态": "待售",
            "募集起始日期": "2026-11-16", "募集结束日期": "2026-11-16",
            "募集币种": "人民币(CNY)", "运作模式": "开放式净值型"}
    ck("口径2-未来待售", R.scope2(base, "2026-11-10"), True)
    ck("口径1-未来开募", R.scope1(base, "2026-11-10"), True)
    ck("开放式", R.is_open(base), True)
    ck("人民币", R.is_cny(base), True)
    ck("开放式-9999", R.is_open({"运作模式": "", "产品结束日期": "9999-12-31"}), True)
    ck("封闭式-排除", R.is_open({"运作模式": "封闭式净值型", "产品结束日期": "2027-01-01"}), False)
    ck("美元-排除", R.is_cny({"产品名称": "美元理财1号", "募集币种": ""}), False)

    # R 级
    ck("R级-PR3", R.to_r_level("PR3 中等风险"), "R3")
    ck("R级-R2", R.to_r_level("产品内部风险评级 R2"), "R2")
    ck("R级-中文", R.to_r_level("三级(中)"), "R3")
    ck("R级-中文映射", R.cn_to_r("二级(中低)"), "R2")

    # 简称与名单内交集
    ck("简称", R.short_bank("中国建设银行股份有限公司"), "建行")
    ck("名单内交集", R.list_hits("东莞银行；中信银行股份有限公司"), "中信")

    # 完整性断言
    pages = [{"data": {"currentPage": 1, "data": [{"prodRegCode": "A"}, {"prodRegCode": "B"}]}}]
    ck("覆盖-完整", R.assert_coverage(pages, 2)[0], 2)
    try:
        R.assert_coverage(pages, 5)
        failed.append("覆盖-不完整应抛错，实际未抛")
        cases += 1
    except RuntimeError:
        cases += 1

    # 完整过滤链 + 去重
    allrows = [dict(base, 登记编码="X1"), dict(base, 登记编码="X1"),
               dict(base, 登记编码="X2", 募集币种="美元", 产品名称="美元款")]
    out = R.filter_all(allrows, "2026-11-10", verbose=False)
    ck("链路-去重与外币排除", len(out), 1)

    print(f"自检 {cases} 项，通过 {cases - len(failed)}，失败 {len(failed)}")
    for x in failed:
        print("  ✗", x)
    return 0 if not failed else 1


def main():
    ap = argparse.ArgumentParser(description="理财新品口径规则引擎")
    ap.add_argument("--config", help="配置 JSON 路径（默认 assets/config.json）")
    ap.add_argument("--selftest", action="store_true", help="运行内置自检")
    ap.add_argument("--filter", help="对输入的明细 CSV 应用完整过滤链")
    ap.add_argument("--out", help="过滤结果输出 CSV 路径")
    ap.add_argument("--today", default="2026-11-10", help="业务基准日 YYYY-MM-DD（GMT+8）")
    ap.add_argument("--scope", choices=["1", "2"], default="2")
    ap.add_argument("--mode", choices=["open", "all"], default="open")
    ap.add_argument("--ccy", choices=["CNY", "all"], default="CNY")
    a = ap.parse_args()
    R = Rules(a.config)

    if a.selftest or not a.filter:
        return selftest(R)

    with open(a.filter, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    out = R.filter_all(rows, a.today, mode=a.mode, ccy=a.ccy, scope=a.scope, verbose=True)
    if a.out:
        cols = list(rows[0].keys())
        with open(a.out, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(out)
        print("已写出:", a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
