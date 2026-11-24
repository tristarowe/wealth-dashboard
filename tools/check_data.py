# -*- coding: utf-8 -*-
"""净值数据「真实性 / 合理性 / 准确性」口径核验（2026-11-24 新增）

背景：check_ann.py 依赖本地真实交易明细，公开仓库出于隐私只保留 id+pid，
      每日 06:00 排查里它实际是「0 持仓空跑」。本脚本补齐**不依赖持仓明细**
      也能对 assets/data.js 净值数据本身做的独立核验。

三层核验：
  A. 结构真实性：dates/nav/per10k 等长、dates 严格递增、nav>0 且为有限数、
     latestDate==末日、asOf/fetchedAt 合法、无未来日期。
  B. 内部一致性（准确性）：per10k[i] ≈ (nav[i]-nav[i-1])*10000 恒等式——
     * 仅对「nav 有波动」的产品做硬校验（固收类净值差推算万收）；
     * 对现金管理类（全序列 nav 恒定）豁免：其 per10k 来自官网披露万分收益，
       与 nav 差本就不等（见 daily/nav_official.py:89 / nav_sites.py:21）；
     * 容差 0.02 元（万收保留 2 位小数）。
  C. 合理性：单日「万收当量」跳变阈值、区间年化 |ann|>50 视为异常
     （与 dashboard.js xirrRangeAnn 稳健阈值一致）、数据新鲜度告警（非致命）。
     跳变默认只扫最近 5 个净值点（每日排查关注新抓数据），--all 扫全历史。

另有 0. 与 check_ann.py 对齐的口径不变量自检：确认关键公式常量仍存在
     （防止口径被静默改写）。
另有 A2. 产品身份真实性：登记编码 regCode 符合 Z+13位数字、sourceName 非空。

用法：
  python tools/check_data.py            # 核验，致命异常退出码 1
  python tools/check_data.py --quiet    # 只打印结论行
  python tools/check_data.py --all      # 跳变检查扫全历史（体检历史数据）
依赖：仅标准库（纯数据文件校验，无 playwright、不联网）。
"""
import json
import math
import re
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_JS = ROOT / "assets" / "data.js"

TOL_PER = 0.02          # 万收恒等式容差（元）
JUMP_PER = 20.0         # 单日万收当量跳变告警阈值（元/万份，约年化 73%）
MAX_ANN = 50.0          # 区间年化合理性上限（%）
STALE_DAYS = 2          # asOf 落后最近工作日超过该天数 -> 新鲜度告警
RECENT_POINTS = 5       # 跳变检查默认只扫最近 N 个净值点
REG_CODE_RE = re.compile(r"^Z\d{13}$")   # 理财登记编码规范


def load_data():
    t = DATA_JS.read_text(encoding="utf-8")
    m = re.search(r"REPORT_DATA\s*=\s*(\{.*\})\s*;", t, re.S)
    if not m:
        raise RuntimeError("无法从 data.js 解析 REPORT_DATA")
    return json.loads(m.group(1))


def is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def parse_d(s):
    return date.fromisoformat(s)


def last_workday(d):
    """d 当天或之前最近的工作日（周一=0…周五=4）"""
    x = d
    while x.weekday() >= 5:
        x = date.fromordinal(x.toordinal() - 1)
    return x


def check_structure(d, problems, warns):
    n = 0
    asof = d.get("asOf")
    try:
        asof_d = parse_d(asof)
    except Exception:
        problems.append(f"asOf 非法或缺失：{asof!r}")
        asof_d = None
    for p in d.get("products", []):
        n += 1
        name = p.get("short") or p.get("name") or p.get("id", "?")
        dates, nav, per = p.get("dates") or [], p.get("nav") or [], p.get("per10k")
        tag = f"[{name}]"
        # 产品身份真实性：登记编码 + 数据源标注（告警，部分老产品登记码可能非标）
        reg = (p.get("regCode") or "").strip()
        if reg and not REG_CODE_RE.match(reg):
            warns.append(f"{tag} 登记编码格式非标准：{reg!r}（期望 Z+13位数字）")
        if not (p.get("sourceName") or "").strip():
            warns.append(f"{tag} 缺少数据源标注 sourceName")
        if not (len(dates) == len(nav)):
            problems.append(f"{tag} dates/nav 长度不等 {len(dates)} vs {len(nav)}")
            continue
        if per is not None and len(per) != len(nav):
            problems.append(f"{tag} per10k 长度不等 {len(per)} vs {len(nav)}")
        if len(dates) < 2:
            problems.append(f"{tag} 净值点数不足 2（{len(dates)}）")
            continue
        # 日期严格递增
        try:
            dd = [parse_d(x) for x in dates]
        except Exception as e:
            problems.append(f"{tag} 日期格式非法：{e}")
            continue
        if any(dd[i] >= dd[i + 1] for i in range(len(dd) - 1)):
            problems.append(f"{tag} dates 非严格递增")
        # nav 有效
        bad = [i for i, v in enumerate(nav) if not is_num(v) or v <= 0]
        if bad:
            problems.append(f"{tag} nav 存在非正/非有限值，索引 {bad[:5]}")
        # latestDate 一致
        if p.get("latestDate") and p["latestDate"] != dates[-1]:
            problems.append(f"{tag} latestDate={p['latestDate']} != 末净值日 {dates[-1]}")
        # 无未来日期（相对 asOf）
        if asof_d:
            fut = [x for x in dd if x > asof_d]
            if fut:
                problems.append(f"{tag} 存在晚于 asOf 的未来净值日 {fut[:3]}")
        # 起点 <= 成立日之后（首净值日不应早于成立日太多：允许先于成立日取发行净值，仅告警）
        inc = p.get("inception")
        if inc:
            try:
                if dd[0] < parse_d(inc):
                    warns.append(f"{tag} 首净值日 {dates[0]} 早于成立日 {inc}（需确认是否发行前净值）")
            except Exception:
                pass
    # 新鲜度（告警，非致命）
    if asof_d:
        lw = last_workday(date.today())
        gap = (lw - asof_d).days
        if gap > STALE_DAYS:
            warns.append(f"数据基准日 asOf={asOf} 落后最近工作日 {lw} 共 {gap} 天（> {STALE_DAYS}，请核查源端披露）")
    return n


def check_consistency(d, problems):
    """per10k 恒等式：仅对 nav 有波动的产品硬校验；现金类豁免。"""
    checked = skipped_cash = 0
    for p in d.get("products", []):
        name = p.get("short") or p.get("name") or p.get("id", "?")
        nav, per = p.get("nav") or [], p.get("per10k")
        if not per or len(per) != len(nav):
            continue
        # 现金管理类：全序列净值恒定 -> per10k 来自官网万分收益，豁免恒等式
        if len(nav) >= 2 and all(abs(v - nav[0]) < 1e-9 for v in nav):
            skipped_cash += 1
            continue
        for i in range(1, len(nav)):
            if per[i] is None or not is_num(nav[i]) or not is_num(nav[i - 1]):
                continue
            exp = (nav[i] - nav[i - 1]) * 10000
            checked += 1
            if abs(exp - per[i]) > TOL_PER:
                problems.append(
                    f"[{name}] {p['dates'][i]} 万收与净值差不自洽："
                    f"per10k={per[i]} vs (nav差)*10000={exp:.2f}（偏差 {abs(exp-per[i]):.2f}>{TOL_PER}）"
                )
                if len([x for x in problems if name in x]) > 3:
                    break
    return checked, skipped_cash


def check_reasonableness(d, problems, warns, scan_all=False):
    """单日万收跳变、区间年化异常。跳变默认只扫最近 N 个点。"""
    for p in d.get("products", []):
        name = p.get("short") or p.get("name") or p.get("id", "?")
        dates, nav = p.get("dates") or [], p.get("nav") or []
        if len(nav) < 2:
            continue
        tag = f"[{name}]"
        # 单日万收当量（用 nav 差，现金类 nav 恒为 0 跳过）
        start = 1 if scan_all else max(1, len(nav) - RECENT_POINTS)
        for i in range(start, len(nav)):
            if not (is_num(nav[i]) and is_num(nav[i - 1])) or nav[i - 1] <= 0:
                continue
            jump = abs((nav[i] - nav[i - 1]) / nav[i - 1] * 10000)
            if jump > JUMP_PER:
                warns.append(f"{tag} {dates[i]} 单日净值跳变 {jump:.1f} 万收当量 > {JUMP_PER}（请复核净值录入）")
        # 区间年化（首末净值）：|ann|>50 视为异常，样本 <7 天跳过
        if is_num(nav[0]) and nav[0] > 0 and is_num(nav[-1]):
            days = (parse_d(dates[-1]) - parse_d(dates[0])).days
            if days >= 7:
                ann = (nav[-1] / nav[0] - 1) * 365 / days * 100
                if abs(ann) > MAX_ANN:
                    problems.append(f"{tag} 区间年化 {ann:.1f}% 超合理上限 ±{MAX_ANN}%（净值 {nav[0]}→{nav[-1]} / {days}天）")


def check_formula_marks(problems):
    """口径不变量：确认关键公式常量仍存在于 dashboard.js（防止口径被静默改写）。"""
    js = (ROOT / "assets" / "dashboard.js").read_text(encoding="utf-8")
    must = [
        ("日均万收×3.65=年化", "avg * 3.65"),
        ("区间年化公式", "ret * 365 / span * 100"),
        ("今日万收=per10k/昨日净值", "/ prevNav0"),
        ("XIRR 稳健阈值的上界", "hi = 10"),
    ]
    for label, token in must:
        if token not in js:
            problems.append(f"口径公式标记缺失：{label}（期望找到 {token!r}）——年化/万收口径可能被改写")


def main():
    quiet = "--quiet" in sys.argv
    scan_all = "--all" in sys.argv
    try:
        d = load_data()
    except Exception as e:
        print(f"FAIL：无法读取数据文件：{e}")
        return 1
    problems, warns = [], []
    check_formula_marks(problems)
    n = check_structure(d, problems, warns)
    checked, skipped_cash = check_consistency(d, problems)
    check_reasonableness(d, problems, warns, scan_all=scan_all)

    if not quiet:
        print(f"产品 {n} 只 | 万收恒等式校验 {checked} 点 | 现金类豁免 {skipped_cash} 只")
    for w in warns:
        print("WARN:", w)
    if problems:
        print(f"FAIL：{len(problems)} 项口径异常")
        for x in problems:
            print("  -", x)
        return 1
    print(f"OK：{n} 只产品，结构真实性/万收-净值一致性/年化合理性 全部通过；告警 {len(warns)} 项（非致命）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
