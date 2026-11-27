全站排查 2026-11-27：正常

> 本次为自动化触达的闭环补跑（承接 09:05 手动补跑）。全站排查未发现需修复的 Bug，无代码/数据改动，未发布。

### 排查时间
2026-11-27 09:08–09:20 GMT+8

### 各项结果
- **CI 状态**：daily-fetch 最近一轮 run 45912512189（#35）conclusion=success（11-26 23:42Z）；nav-ccb 最近 run 45916733265（#89）success（11-27 00:26Z）；nav-rotate 最近 run 45921182532（#296）success（11-27 01:11Z）。三 workflow 最近一轮均 success。历史失败：daily-fetch #34/#33 的 failure 步骤为「微信推送」（Server酱当日额度 40001，第三方问题），数据抓取本身成功，最近一轮已恢复 success，非站点 Bug。
- **标记守卫**：`api_push.py check --check index.html assets/dashboard.js assets/store.js tools/code_guard_marks.json` 通过，三道守卫（标记/陈旧基线/体量）无缺失，守卫版本 2026-11-26a37，本地与远端基线一致。
- **收益口径自检**：`check_ann.py` 0 告警，页面年化与独立复算一致。公开仓库仅留交易 id+pid、本地无真实持仓明细，显示「0 只持仓」属正常空跑，**持仓数值校验未覆盖**。
- **数据口径核验**：`check_data.py` 退出码 0——4 只产品、411 个万收恒等式校验点、现金类豁免 0、FAIL 0 / WARN 0；结构真实性/万收-净值一致性/年化合理性/无未来净值日/冲突标记扫描全通过。
- **数据新鲜度（含 fetchedAt）**：`daily/stats.json` 与 `assets/data.js` 的 asOf 均为 2026-11-27、fetchedAt 均为 2026-11-27 07:45，二者一致且晚于前一日 22:00–22:50 抓取窗口，无 A1「净值日期新、fetchedAt 旧」特征。最新净值日 dataDate=2026-11-26（最近已过工作日），无未来净值。
- **三视口**：桌面 1124×900 / 竖屏 393×852 / 横屏 1080×520 均 0 pageerror、0 console error；三个主标签（hold/trade/prod）pane 可见且非空；竖屏「03 盈亏趋势」子页 #chart 内有 SVG、无「图表加载中…」（E21）；新品卡 #np-lanes .nchip 各视口 2 张、均有 .rk 风险角标、产品名无「人民币」、nmeta scrollWidth−clientWidth=0 无横向溢出、竖屏空泳道不显示；代销/发行两个筛选按钮点击后弹层各出 2 个选项；#metric-value 颜色 rgb(74,141,184) 与 --data-ink(#4A8DB8) 一致（E22）。
- **缓存戳**：8 个 `<script src>` 的 `?v=`、`index.html` 的 NP_BUILD、`assets/dashboard.js` 的 `__NP_LAYOUT_VERSION` 全部一致为 `20261126ag`，无「新 HTML + 旧 JS」错位（B2/B6）。
- **两站可达**：GitHub Pages 与 WorkBuddy 预览站 index 均 HTTP 200、缓存戳同为 20261126ag；预览站静态资源带 sharecode=7ZRCM3XUN7 返回 200 正常 JS，非「链接不完整」HTML。

### 历史 Bug 回归核对结论
`tools/BUG_REGRESSION.md` 共 80 条（A1–A17 / B1–B6 / C1–C4 / D1–D6 / E1–E80 / Q03 / Q04）。逐项核对回归检查列：A1 三 workflow concurrency 与时间戳、B1/B2 守卫与缓存戳、E21 图表占位、E27 新品 T+1（源数据 9 条，募集起始日已过的 7 条被过滤，仅展示 11.30 起 2 条）、E18 空态、E43 双行小数点、E44 清仓角标 T 日、E60 泳道滚动对齐、E69/E70 年月表配色与格式、E72–E80 产品库列宽/角标等关键点均符合预期，未发现复发。无法自动验证项：E20 收益选中行运行时样式（本地 0 持仓空态，无可选中行）、E15 WebKit 字体抗锯齿专项、登录态/RLS 相关（C1–C4，无登录态）、持仓数值校验——标注**未覆盖**，未谎报。

### 数据口径核验明细
- 产品数：4
- 万收恒等式校验点：411
- FAIL：0
- WARN：0
- 现金类豁免：0

### 发现并修复的 Bug
无。本轮未确证任何需修复问题，未改动代码/数据。

### 数据滞后告警
`daily/stats.json` lagging 列 3 只：建信嘉鑫稳利30天35期（11-25）、信银安盈象14天165号（11-25）、中邮鸿锦7天45号（11-25）——源端披露滞后，属正常，未伪造净值。

### 是否发布
无代码改动，跳过发布。两站维持现有版本 20261126ag。

### 两站链接
- GitHub Pages：https://tristarowe.github.io/wealth-dashboard/index.html
- WorkBuddy 预览站：https://wbapp-t0zibstmicn6o6649v1k02.app.workbuddy.host/?sharecode=7ZRCM3XUN7

### 说明
- 本轮未发生 WorkBuddy 平台 429 限流，未降级模型，由主模型承载，排查项无压缩、全覆盖。
- 本地 main 领先远端 13 个提交为并行流程的影子提交，`git diff 41494eb..HEAD` 为空（工作树与远端 main 内容完全一致），远端 main 缓存戳与守卫版本与本地一致，无覆盖他人提交风险。
- 09:05 已完成一次手动补跑并推送成功（run 45920911546）；本轮为自动化触达的完整闭环，补齐仓库留痕与微信推送。
- daily-fetch 历史两条 failure（#34/#33）均为「微信推送」步骤第三方额度问题，非站点数据 Bug；如当日 Server酱次数耗尽导致本次 notify 步骤 40001 失败，将如实记录 run id，不重试刷额度。
