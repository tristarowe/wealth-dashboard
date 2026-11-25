# 历史 Bug 回归清单（每日 06:00 全站排查必读）

本文件汇总 2026-11-17 以来聊天记录/工作日志中出现过的所有 Bug，按类别分组。
每日排查时须逐项核对「回归检查」列，确认未复发；发现复发即按原根因修复。
口径类约束见 PROJECT_NOTES.md 与 .workbuddy/memory/MEMORY.md，勿擅动。

---

## A. 数据抓取与净值（最高优先级）

| # | Bug | 根因 | 回归检查 |
|---|---|---|---|
| A1 | 数据更新时间戳停在昨天（11-24） | 三个 workflow 并发写 data.js，rebase 冲突被 `\|\| true` 吞掉，push 显示 up-to-date 却未推 | ① GitHub Actions 最近一轮 daily-fetch/nav-ccb/nav-rotate 结论须 success；② `assets/data.js` 的 `fetchedAt` 不得早于最近已过去工作日；③ 三 workflow 的 concurrency.group 均为 `nav-data` |
| A2 | 定时抓取漏跑（11-19） | 定时任务未触发 | 查近 24h daily-fetch 是否至少成功 1 次 |
| A3 | 建信系停在 T-2（11-19） | 单一官网源失效 | `check_data.py` 最新净值日 ≥ 最近工作日；建信三档任务齐全 |
| A4 | 中邮漏抓（11-24） | 再版说明书启用日期被误当旧成立日 | 新品数应与公告一致；`enable_date_of` 逻辑在 |
| A5 | 名称对不上导致匹配失败（11-23） | 代销冠名/改名 | ECD 桥接映射在 `daily/reg_alias.json`；`--all` 冠名前缀匹配在 |
| A6 | 三家机构（贝莱德/光大/交银）滞后（11-23） | 源端披露节奏 + 名称规则 | 如实标「滞后」，不得伪造；官网 adapter 优先于中国理财网 |
| A7 | 产品库补漏悦享天添24号（11-17） | 抓取覆盖不全 | `daily/backfill_byname.py --reg/--name` 幂等按 regCode 合并 |
| A8 | 手工产品入库后交易 pid 联动（11-17） | pid 未同步 | `fetch_manual.py` 名称反查补 regCode；`canonicalPidById()` 在 |
| A9 | 新品代销机构「待核实」（11-17/23/24） | 说明书无代销语境 | 三来源取不到回填「建设银行」；卡片无「待核实」 |
| A10 | 新品历史日期污染（11-24） | 已成立产品被并入新品 | `is_live_new()` 只留未成立+有募集日；window.start=max(today,...) |
| A11 | 新品成立日多算一天/日期错乱（11-23） | 日期抽取偏移 | 日期列起点=今天，无历史日期 |
| A12 | 新品名称抽取失败漏抓（11-23/24） | 长名/特殊版式 | `stats.failed` 应为 0；中邮再版锚定启用日 |
| A13 | 新品风险角标空（交银147/信银258，11-24） | 两种版式旧正则取不到 | 每张 nchip 有 .rk；`extract_risk()` 两条兜底在 |
| A14 | 长图只剩 2 个产品（11-23） | 截图时产品库未就绪 | 长图「覆盖产品」数量=持仓数；重跑前确认 library 就绪 |
| A15 | 每日长图 RLS 空壳（11-22） | RLS 未生效 | 登录态长图有真实数据 |
| A16 | 新品额度单位笔误「【3000】亿元」（11-22） | 说明书字段单位错 | `NP_SHOW_QUOTA=false`，额度位固定「—」 |
| A17 | 万收/净值结构异常 | 数据被静默改写 | `check_data.py` 退出码 0（等长/递增/nav>0/万收恒等式/无未来日） |

## B. 发布与链路

| # | Bug | 根因 | 回归检查 |
|---|---|---|---|
| B1 | 旧版整体覆盖 main 致全站功能丢失（11-18） | Trae 端用旧本地副本 push | 守卫标记齐全（`api_push.py --check`）；分叉先 merge 不 force push |
| B2 | 新 HTML + 旧 JS 错位致排版乱（11-23/24） | 缓存戳不一致 | 所有 `<script src>` 的 `?v=` 一致且等于 `NP_BUILD` 与 `__NP_LAYOUT_VERSION` |
| B3 | git push 502 / Empty reply（多次） | 代理/网络 | 先禁代理 HTTP/1.1 fetch；仍失败走 `tools/api_push.py` |
| B4 | api_push 误报基线陈旧（多次） | 普通 push 不刷新 `.sync_state.json` | 基线设为 origin/main 的 blob SHA |
| B5 | 预览站 SITES_START_FAILED 误报（11-24） | 健康检查超时 | 抓包实测再判定，不盲目重发 |
| B6 | 缓存戳漏 bump（11-24 w 轮） | 改 JS 未同步戳 | 改动后三处戳全量替换并核对 |

## C. 隐私与安全

| # | Bug | 根因 | 回归检查 |
|---|---|---|---|
| C1 | 退登后仍可见真实数据（11-22 严重） | RLS 策略缺失 | 访客/退登视角全站金额打码；`assets/privacy.js` RULES + roots 覆盖所有私密区块 |
| C2 | sb_secret_ 密钥不兼容（11-22） | 键名变更 | 登录态数据同步正常 |
| C3 | RLS 未生效（11-22） | SQL 未执行 | Supabase RLS 策略在；跨账号查不到他人数据 |
| C4 | 登录失败（11-24） | 用户侧凭证/输入（服务端正常） | `/auth/v1/health` 200；错误码正确显示；误改代码前先确认红字报错 |

## D. 收益与口径

| # | Bug | 根因 | 回归检查 |
|---|---|---|---|
| D1 | 持仓收益口径错误（11-19） | 按累计投入而非当前份额盈亏 | `assertHoldMath()` 通过；持仓收益=市值−当前持仓成本 |
| D2 | 年化分母用了确认日（多次） | 起息点错 | 计息起点=成交净值日 T 日；`tools/check_ann.py` 0 告警 |
| D3 | 盈亏日历收益口径不统一（11-19） | 累计/持仓混用 | 日历口径=累计；与累计卡同源 |
| D4 | 年化非资金加权（11-19） | 简单平均 | `CUM_ANN_CACHE` 保证最新年/月相等；历史用 `xirrRangeAnn` |
| D5 | 部分赎回收益口径（11-19） | 已赎回部分漏算 | 累计收益=持仓收益+已实现收益 |
| D6 | 年化防错被绕过（11-21） | 静默改写 | `check_ann.py` + `annTipOf()` + 短样本 `*` 前缀在 |

## E. 前端 UI / 交互（按主题归并）

| # | Bug | 根因 | 回归检查 |
|---|---|---|---|
| E1 | 表格滚动到顶/底卡顿（11-19） | 全站 resize 广播 | 切页只调 `__DASH_CHART_RESIZE__`，不广播 resize |
| E2 | 筛选刷新闪原生多选框（11-19/24） | JS 执行前裸 `<select multiple>` | 自绘 `.sel-wrap` 外壳写进 HTML，select 首帧 opacity:0 |
| E3 | 底部大片空白（11-20） | 容器高度算错 | 无异常空白 |
| E4 | 改错模块（11-20 0596870） | 改了非目标模块 | 盈亏汇总行高正确，未被误改 |
| E5 | 导出图片/表单/导航/列宽（11-20） | 多项 | 导出长图正常、表单无错位 |
| E6 | 移动端筛选弹层过大（11-21/24） | iOS 原生 picker | `.sel-pop` 自绘紧凑弹层；年月框 26px、弹层仅数项 |
| E7 | 导出重影（11-21） | clone 时透明 select 重现 | `swapSelectsInClone()` 跳过透明 select |
| E8 | 手势角标 SVG 偏下（11-21） | display:block | `display:inline-block;vertical-align:-2px` |
| E9 | 隐私打码漏区块（11-21/24） | 新增区块未登记 | 新私密区块同时进 RULES 与 MutationObserver roots |
| E10 | 新品排版方案C「完全乱」（11-23） | 旧 JS 缓存 | 无缓存参数抓包确认新戳；clear 缓存后正常 |
| E11 | 新品占屏过多（11-23） | 卡片过高 | 竖屏卡片 66px、空泳道隐藏 |
| E12 | 新品筛选卡顿（11-24） | 每次勾选全量重建 DOM | `applyNewProdFilter()` 只切可见性；`data-org/data-iss` 在 |
| E13 | 全站按钮点击延迟/蓝闪（11-24） | 双击缩放 300ms | `touch-action:manipulation` + 透明高亮 |
| E14 | 搜索框字号/提示文字（11-24） | 字号被通用 !important 覆盖 | `#ms-search.ms-search{font-size:12.5px!important}` 在；提示文字已删 |
| E15 | 小数点不对齐/蓝痕（11-24 三次） | 左对齐 + SF Mono 彩色抗锯齿 | `fmtMoneyCell()` 三段网格；系统字体栈 + 灰度抗锯齿；**必须用 WebKit 验证** |
| E16 | 角标填充/白底胶囊/日历对齐（11-24） | 多轮反复 | 角标填充已恢复；胶囊白底；年/月表头右对齐 |
| E17 | 按钮字重/选中填充（11-24） | 多轮反复 | 基础 500；仅 `.tab.on`/`.jumpbar .j.on` 蓝填充，其余选中无填充 |
| E18 | 新品筛选空态整页空白（11-24） | 空泳道整条隐藏 | `#np-empty` 提示块；`applyNewProdFilter()` 统计可见 chip |
| E19 | 年化条颜色/字号/溢出（11-24） | 条太深、字号过大 | 浅蓝渐变 + 数据色文字；竖屏 11px；左对齐 |
| E20 | 收益选中框太粗/数据条压线（11-24） | 2px 框 + `.rate-cell` relative 盖住 outline | 1px `::after` 覆盖层画框，z-index:2 在数据条之上 |
| E21 | 趋势图一直「图表加载中…」（11-24） | 占位文本节点未在渲染后清除 | 图库就绪后先移除 `.chart-loading` 再 init；SVG 存在且无占位文字 |
| E22 | 2026 年份字体颜色/数据色太深（11-24） | 年份用品牌蓝、数据色 #31566A 过深 | 年份列统一到 `--data-ink`（浅亮蓝 #4A8DB8） |
| E23 | 刷新/首次加载缓慢（11-24） | ECharts 338KB 串行阻塞 + 无预取 | DCL/load 时间达标；`fetch` 预取图库；dashboard.js 完成 < 2s |
| E24 | 手机端新品预告数据行可左右滑动（11-25） | 8 天 × 176px = 1408px 超出容器，`#np-lanes` 成横向滚动容器，日期表头被裁切 | 触屏/≤1200px 改日期纵向分组 + 卡片自适应网格，空泳道隐藏；WebKit/Chromium 横竖屏实测 `scrollWidth == clientWidth` |
| E25 | 06:00 排查微信推送漏发（11-25） | WorkBuddy 平台限流 429（09:11 才重置），本地任务首轮即中断，未走到 workflow_dispatch | GitHub Actions 看门狗 07:30 独立检查当天是否发出排查报告，未发出则经 Server酱告警；不依赖本地环境 |
| E26 | library 数据文件带未解决冲突标记（11-25） | 远端数据提交把 `<<<<<<<`/`=======`/`>>>>>>>` 写进 `assets/library.js` 与 `daily/library.json`，产品库 JS SyntaxError | 取远端较新一侧（fetchedAt 08:24）清除标记；`tools/check_data.py` 新增 `check_conflict_markers()` 全文扫描，命中即 FAIL |
| E27 | 新品预告仍显示募集起始日已过的产品（11-25） | 只按「已成立」过滤，募集起始日为昨日（T+1 起）的产品仍留在预告里 | `renderNewProds()` 增加 `raiseStart < 今天` 过滤：起始日 24 号的产品到 25 号即移除；交易录入候选池不受影响 |

---

## 核对方式（每日排查）
- 自动化流水线见 automation「全站每日排查与修复（06:00）」prompt。
- 本清单每项若无法自动验证（如需登录态），在报告中标注「未覆盖」并说明原因，不得谎报通过。
- 修复任何一项后须 bump 缓存戳、登记守卫标记、三视口冒烟、两站发布。
