"""生成 assets/数据说明.pdf：各模块取数口径与数据源说明（数据取自 assets/data.js 的时点）。"""
import json
import re
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "assets" / "data.js"
OUT = ROOT / "assets" / "数据说明.pdf"
FONT_FILE = r"C:\Windows\Fonts\simhei.ttf"

FONT = pymupdf.Font(fontfile=FONT_FILE)
PAGE_W, PAGE_H = 595, 842
MARGIN = 40
COL_W = [76, 292, 147]
PAD = 5
FS = 8.4            # 正文
LH = 12.4           # 行高
HEAD_FS = 9
TITLE_FS = 15


def as_of():
    raw = DATA.read_text(encoding="utf-8")
    m = re.search(r'"asOf"\s*:\s*"([^"]+)"', raw)
    f = re.search(r'"fetchedAt"\s*:\s*"([^"]+)"', raw)
    return (m.group(1) if m else ""), (f.group(1) if f else "")


ROWS = [
    ("sec", "全局口径"),
    ("全局", "数据时点",
     "数据截至 {asOf}（默认展示 T-1 最新净值），抓取时间 {fetchedAt}；页面金额单位均为人民币元，收益率为年化口径时单独标注「%」。",
     "每日两次自动抓取：北京 07:50 补齐前一日，21:30 入库当晚已披露净值"),
    ("全局", "净值来源与时效",
     "以 T-1 日最新净值为目标；T-1 未披露时沿用上一有效净值并标注滞后天数，不改写净值日期；同一产品取最新净值日。",
     "代销机构 App / 官网、理财公司官网优先；中国理财网披露有 1~2 个交易日延迟，仅作兜底"),
    ("全局", "收益归属与回填",
     "收益按净值所属日 T 归属，不按披露日/抓取日入账；万收型 = 当日万份收益 × 份额 ÷ 10000；净值型 = 份额 ×（当日净值 减去 上一日净值）；晚到净值只回填对应净值日的一格，不改写历史；以「登记编码 + 净值日期」为主键幂等入库，重复抓取只覆盖不累加。",
     "本地收益引擎 + 净值库；每次抓取后自动补算晚到净值"),
    ("全局", "披露节奏（+N）",
     "产品名右上角红色 +N 表示净值披露节奏：净值日 T 的净值于 T+N 个工作日内披露。以说明书「产品估值/净值信息披露」条款为准；未取得条款或周频披露的产品不标注。",
     "产品说明书（凭登记编码可查），逐只记录条款原文"),
    ("全局", "份额确认（T+N）",
     "申购 / 赎回确认周期（T+1 / T+2）取自说明书「申购与赎回」条款，只影响在途份额与持仓天数起算，与产品名后的 +N 标记不是同一口径。",
     "产品说明书 + 银行成交"),
    ("全局", "交易状态判定",
     "确认日 > 今日，或确认日 ≤ 今日但该确认日净值尚未披露，均判为「在途」，成交净值显示「待确认」，不计入持仓、持仓汇总与盈亏汇总；净值补齐后自动转为已确认。确认日顺延跳过周末与法定节假日。",
     "本地交易引擎 + 净值库"),

    ("sec", "盈亏"),
    ("盈亏", "盈亏汇总",
     "与「持仓汇总」同源（含在途申购、当日清仓）；今日收益 = 当日万份收益 × 份额 ÷ 10000；持仓收益 = 市值 减去 成本；持仓天数 = 今日 减去 起息日（自然日，起息日当天 0 天；起息日取首次申购确认日，清仓后重新申购取最近确认日）；持仓年化 = 持仓收益率 × 365 ÷ 持仓天数；今日收益列正红负绿，其余收益数值用黑/灰区分。",
     "净值（T-1）+ 本地交易记录"),
    ("盈亏", "评分与评价",
     "评分 = 7 / 14 / 30 日万收与年化加权后映射到 0~10 分（≥6.5 良好、4~6.5 一般、<4 偏弱），仅用于横向比较，不构成投资建议；清仓产品显示「已清仓」。",
     "本地评分模型"),
    ("盈亏", "盈亏日历",
     "每日收益 = Σ（当日各持仓产品万份收益 × 份额 ÷ 10000）；月度 / 年度收益为区间累计，色阶越深金额越大；空格表示当日无持仓或无披露净值；月视图最新月在上，点击月份切换；月度 / 年度合计按未取整数值累加后展示，保证分毫闭合。",
     "净值（T-1）+ 本地交易记录"),
    ("盈亏", "盈亏趋势",
     "折线为组合当日收益（元），数据点上下标注「当日收益 + 持仓年化（%）」；区间可选 7 / 14 / 30 / 90 日与成立至今，按所选区间重算组合年化。",
     "净值（T-1）+ 本地交易记录"),

    ("sec", "交易"),
    ("交易", "持仓汇总",
     "按产品汇总持仓市值、收益、年化与持仓天数（口径同盈亏汇总）；包含在途申购（黄色「在途」标签）与清仓确认当日产品，清仓次日起从列表移除；默认按持仓市值降序，点击表头切换排序；无已确认份额时赎回 / 清仓按钮置灰。",
     "本地交易记录 + 净值（T-1）"),
    ("交易", "交易规则",
     "申购不限（任意产品可录入）；赎回需有已确认持仓份额且不得超额；清仓需有份额且无在途清仓单，固定全量卖出；清仓按确认日生效，无需等待当日净值披露。",
     "本地交易引擎"),
    ("交易", "交易流水",
     "记录每笔申购、加购、赎回、清仓与分红；确认日为份额确认日（T+1 / T+2，遇节假日顺延）；在途份额确认后才计入持仓与市值；按月折叠，默认定位最近一笔交易日所在年月。",
     "银行成交回单 / 手工录入，支持导出"),

    ("sec", "新品预告"),
    ("新品", "数据来源",
     "六大行及股份制银行的新品公告与销售文件（产品说明书 / 风险揭示书）要素表；以建设银行代销公告为主通道，覆盖中银理财、中邮理财、光大理财、交银理财、信银理财、建信理财等发行机构。",
     "各银行官网公告页 + 说明书 PDF"),
    ("新品", "抓取链路",
     "公告列表（回溯 N 天）→ 标题预筛（剔除封闭式、外币、QDII）→ 逐条下载说明书 PDF → 抽取募集起始日期、募集结束日期、成立日期、发行额度、风险等级、理财产品管理人。",
     "每日自动抓取，原始文件本地留档"),
    ("新品", "收录口径",
     "发行机构属于六大行 / 股份制银行理财子；开放式净值型；人民币；时间轴仅收录成立日不早于抓取日的新品；产品库扩容收录成立日不早于 2026-08-01 的产品。",
     "机构白名单"),
    ("新品", "展示口径",
     "时间轴纵向为代销机构、横向为日期；左侧为募集起止日期，中间为产品简称 + 发行额度 + 风险等级，右侧为成立日；无新品的日期以等宽灰底占位，所有日期列等宽铺满。",
     "看板渲染"),
    ("新品", "复核与留痕",
     "风险等级与中国理财网披露的 prodRiskLevel 交叉复核，冲突时以中国理财网为准；原始公告、PDF 与解析文本全部本地留档，可逐条回溯。",
     "中国理财网 + 原始公告"),

    ("sec", "产品库"),
    ("产品库", "收录范围",
     "收录成立日不早于 2026-08-01 的产品，支持人工补充收录；持仓与清仓状态按交易记录联动标注。",
     "新品入库 + 人工补充"),
    ("产品库", "产品名称",
     "全站统一简称：发行机构简称 + 产品系列 + 持有期 + 期数 / 号数，移除「理财、固收类、最低持有、产品」等冗余修饰词；盈亏汇总与持仓汇总不展示发行机构与代销机构小字。",
     "本地名称清洗规则"),
    ("产品库", "持有期",
     "由产品名称解析：优先取「N 天」「中文数字天（七 / 十四 / 三十等）」「N 个月（按 30 天折算）」；名称含 日开 / 日日开 / 天天利 / 天天盈 / 天天购 / 天添 / 每日开放 / 现金管理类 判为「日开」；无法解析时显示「—」。",
     "产品说明书 / 公告要素表"),
    ("产品库", "风险等级",
     "优先取公告说明书「本产品风险评级为【PRx】」声明，其次中国理财网 prodRiskLevel，两者冲突以中国理财网为准；缺失时由每日任务自动补全并写入风险等级库，前端优先读取该库。",
     "说明书 PDF + 中国理财网 + assets/risk_levels.js"),
    ("产品库", "收益与净值字段",
     "今日万收为 T-1 万份收益；7 / 14 / 30 日与成立年化为区间年化，默认万收在上、年化在下，选年化时隐藏万收列；净值日期为最新披露日，成立日期下方展示成立天数；区间年化副数值 12px，色阶百分比 13px/700。",
     "净值（T-1）+ 成立日期"),
    ("产品库", "筛选与排序",
     "筛选条顺序：代销机构（下拉多选，选项由全量产品动态生成）→ 数据 → 当月新品 → 收藏 → 搜索框；持仓状态单选互斥（持仓 / 清仓 / 全部）；每页固定 20 条。",
     "看板交互"),

    ("sec", "数据体检"),
    ("体检", "校验口径",
     "今日平均万收分母只统计在持产品；清仓行评分显示「已清仓」；新品预告剔除成立日已过的产品；月度 / 年度收益合计用未取整数值累加后再展示，保证分毫闭合。",
     "本地校验脚本"),
]


PUNCT = "，。、；：）】」』%"
TOKEN_RE = re.compile(r"[A-Za-z0-9:.,%+\-—/]+|.")


def wrap(text, width, fs):
    """按 token 换行：数字、时间、英文串整体不拆开，标点尽量不落行首。"""
    lines, cur = [], ""
    for tk in TOKEN_RE.findall(text):
        if tk == "\n":
            lines.append(cur)
            cur = ""
            continue
        if cur and FONT.text_length(cur + tk, fontsize=fs) > width:
            if tk in PUNCT and FONT.text_length(cur + tk, fontsize=fs) <= width + fs:
                cur += tk
                continue
            lines.append(cur)
            cur = tk
        else:
            cur += tk
    if cur:
        lines.append(cur)
    return lines or [""]


def draw_page(doc, page_no):
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    page.insert_font(fontname="SimHei", fontfile=FONT_FILE)
    if page_no > 1:
        page.insert_text((MARGIN, 32), "理财产品每日收益看板 · 数据说明与口径（续）", fontname="SimHei", fontsize=10, color=(0.16, 0.38, 0.46))
    return page


def footer(page, page_no):
    txt = "第 %d 页" % page_no
    w = FONT.text_length(txt, fontsize=8)
    page.insert_text((PAGE_W / 2 - w / 2, PAGE_H - 22), txt, fontname="SimHei", fontsize=8, color=(0.45, 0.5, 0.53))


def main():
    aof, fetched = as_of()
    doc = pymupdf.open()
    page = draw_page(doc, 1)
    y = 46

    page.insert_text((MARGIN, y), "理财产品每日收益看板 · 数据说明与口径", fontname="SimHei", fontsize=TITLE_FS, color=(0.1, 0.2, 0.24))
    y += 20
    sub = "数据截至 %s（T-1） · 生成日期 2026-11-13 · 金额单位：人民币元" % aof
    page.insert_text((MARGIN, y), sub, fontname="SimHei", fontsize=8.6, color=(0.42, 0.48, 0.51))
    y += 16

    widths = COL_W
    heads = ["模块", "数据说明 / 口径", "来源与更新"]

    def draw_head(y0):
        page.draw_rect(pymupdf.Rect(MARGIN, y0, MARGIN + sum(widths), y0 + 20), color=None, fill=(0.18, 0.44, 0.53))
        x = MARGIN
        for w, h in zip(widths, heads):
            page.insert_text((x + PAD, y0 + 13.5), h, fontname="SimHei", fontsize=HEAD_FS, color=(1, 1, 1))
            x += w
        return y0 + 20

    y = draw_head(y)

    for row in ROWS:
        if row[0] == "sec":
            h = 19
            if y + h > PAGE_H - 40:
                footer(page, doc.page_count)
                page = draw_page(doc, doc.page_count + 1)
                y = 54
                y = draw_head(y)
            page.draw_rect(pymupdf.Rect(MARGIN, y, MARGIN + sum(widths), y + h), color=None, fill=(0.9, 0.94, 0.96))
            page.insert_text((MARGIN + PAD, y + 13), row[1], fontname="SimHei", fontsize=9.2, color=(0.16, 0.38, 0.46))
            y += h
            continue

        _, mod, desc, src = row
        desc = desc.replace("{asOf}", aof).replace("{fetchedAt}", fetched)
        cells = [mod, desc, src]
        wrapped = [wrap(c, widths[i] - PAD * 2, FS) for i, c in enumerate(cells)]
        h = max(len(w) for w in wrapped) * LH + PAD * 2
        if y + h > PAGE_H - 40:
            footer(page, doc.page_count)
            page = draw_page(doc, doc.page_count + 1)
            y = 54
            y = draw_head(y)

        page.draw_rect(pymupdf.Rect(MARGIN, y, MARGIN + sum(widths), y + h), color=(0.83, 0.88, 0.9), width=0.4)
        x = MARGIN
        for i, w in enumerate(widths):
            if i:
                page.draw_line((x, y), (x, y + h), color=(0.83, 0.88, 0.9), width=0.4)
            color = (0.12, 0.25, 0.31) if i == 0 else (0.16, 0.2, 0.22)
            for j, line in enumerate(wrapped[i]):
                page.insert_text((x + PAD, y + PAD + LH * (j + 0.8)), line, fontname="SimHei", fontsize=FS, color=color)
            x += w
        y += h

    footer(page, doc.page_count)
    try:
        doc.subset_fonts()
    except Exception:
        pass
    doc.save(str(OUT), garbage=3, deflate=True)
    doc.close()
    print("已生成 %s，共 %d 页，数据截至 %s" % (OUT, pymupdf.open(str(OUT)).page_count, aof))


if __name__ == "__main__":
    main()
