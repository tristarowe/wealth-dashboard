# 理财产品每日万收看板 · 项目交接说明

> 供新会话/新接手人快速接上上下文。所有文案、口径均为中文，金额保留 2 位小数。

## 1. 项目定位

静态单页看板，展示持仓理财产品的每日净值、当日收益与持仓收益。净值数据由脚本抓取写入
`assets/data.js`；交易与持仓以云端 Supabase 为准，`assets/transactions.js` 只是本地兜底底稿。
页面无构建、无框架、无 CDN，双击 `index.html` 即可打开。

- 本地目录：本仓库的克隆目录（下文统一称「项目根目录」，不绑定任何某台机器的路径）
- 线上地址（GitHub Pages）：`https://tristarowe.github.io/wealth-dashboard/`
- 对应仓库：`tristarowe/wealth-dashboard`（`main` 分支，Pages 托管根目录）
- 今日数据状态：`assets/data.js` 的 `asOf = 2026-11-18`、`fetchedAt = 2026-11-18 08:35`，最近净值 2026-11-17；
  持仓 13 只，净值跟踪 4 只，产品库 211 只，新品预告 2 只

## 2. 快速开始

```powershell
# 以下命令均在项目根目录执行
cd <项目根目录>

# 直接看页面（务必用浏览器打开，不要用编辑器看，否则只会看到源码）
Start-Process .\index.html

# 跑一次完整抓取（会重写 assets/data.js 与 daily/stats.json）
python daily/fetch_data.py

# 启动本地服务：页面里的「数据抓取」按钮会调用它真正抓数（serve.py 仅本机保留，不进仓库）
python daily/serve.py
# 然后访问 http://127.0.0.1:8765/ （加 --open 可自动打开浏览器）

# 只重建推送统计，不抓数
python daily/fetch_data.py --stats-only

# 导出看板长图（本地必须指定 chrome 通道，否则报 chromium_headless_shell 不存在）
$env:PW_CHANNEL="chrome"; python daily/shot.py

# 推送到微信（需要 daily/serverchan.key 或环境变量 SERVERCHAN_SENDKEY）
python daily/notify.py
```

## 3. 目录与文件职责

| 路径 | 职责 |
| --- | --- |
| `index.html` | v4 页面骨架 + 全部样式 + 页签切换 + html2canvas 导出脚本 |
| `assets/dashboard.js` | IIFE 渲染：首页盈亏明细/盈亏日历/盈亏趋势、交易空状态、产品库/新品预告/数据说明、产品多选、数据抓取 |
| `assets/data.js` | 唯一数据源 `window.REPORT_DATA = {asOf, products[]}` |
| `daily/fetch_data.py` | 按源链抓取 → 合并 → 校验 → 重写 data.js、stats.json |
| `daily/serve.py` | 本地服务（仅本机保留，不进仓库）：静态托管 + `POST /api/refresh` 真实执行抓取 + `GET /api/status` |
| `daily/sources_config.json` | 每款产品的数据源链与参数（顺序即优先级，靠前优先） |
| `daily/sources/*.py` | 各站点适配器，统一 `fetch(params, start, end) -> [{date, nav}]` |
| `daily/chinawealth_nv.py` | 中国理财网抓取器（被 `sources/chinawealth.py` 以子进程调用） |
| `daily/shot.py` | Playwright 截图，输出 `snapshots/<asOf>.png`，只保留最近 7 张 |
| `daily/notify.py` | Server酱 推送（长图 + 当日摘要 + 来源统计 + 滞后提示） |
| `daily/img_host.py` | 长图上传 `qu.ax` 换直链，供微信内显示 |
| `tools/sync_pages.py` | 推送看板到 Pages 仓库（含标记 / 整批中止 / 数据时间戳三道守卫） |
| `tools/pull_from_github.py` | 从仓库拉取（三方比对，保护本地未推送改动） |
| `tools/code_guard_marks.json` | 关键功能标记清单，两端共用 |
| `daily/run_daily.cmd` | 本地一键跑：抓取 → 截图 → 推送，日志写 `daily/logs/run.log` |
| `.github/workflows/daily-fetch.yml` | 云端每日 08:30（UTC 00:30）抓取、截图、提交、推送；另有三条流水线 `nav-rotate` / `add-products` / `weekly-expand` |
| `.workflow/*.yml` | Gitee Go 备用流水线（仅本机保留，不进仓库） |
| `_shared/js/echarts.min.js`、`assets/html2canvas.min.js` | 本地依赖，勿改 CDN |

## 4. 数据契约

```js
products[i] = {
  id, name, short, org, regCode, shareCode,
  inception,        // 成立日 = dates[0]
  latestDate,       // 最新净值日
  officialAnnual, officialAsOf,   // 官方展示年化（可能为 null）
  sourceName,       // 最新净值实际来源，如「建设银行代销净值」
  dates[],          // "YYYY-MM-DD"，升序
  nav[],            // 单位净值，与 dates 等长
  per10k[],         // 万收，per10k[0] 恒为 null，其余 = round((nav[i]-nav[i-1])*10000, 2)
  dailyAnn[]        // 年化，页面加载时重算，不写回 data.js
}
```

页面内派生：`selectedIds`（顶部多选）→ `AGG`（所选产品按日聚合，多选时标题带「合计」）。

### 页面结构（v4）

三个页签，URL hash 为 `#hold` / `#trade` / `#prod`：

- **首页**：01 盈亏明细（17 列持仓视角：净值日期/今日万收/今日收益/持仓收益/持仓年化/持仓市值/持仓天数 + 7/14/30/60/90 日 + 成立至今 + 评分，表头数据下拉可切换全部/万收/年化）→
  02 盈亏日历（左：年度月度收益表，月度收益 = 当月每日收益合计，单位元；右：按月日历，下：当月收益/正收益/回撤/挂0）→
  03 盈亏趋势（ECharts 当日收益，7/14/30/90/成立至今；90 日横轴按周、成立至今按月取刻度）
- **交易**：01 交易汇总（持仓产品，加购/赎回/清仓入口）、02 交易流水（年份/月份/产品/类型/状态筛选）
- **产品**：01 新品预告（2 只）→ 02 产品库（211 只真实产品，机构/风险/持有期/收藏/持仓/成立月份筛选）→
  03 数据说明（`assets/数据说明.pdf` 单卡片）

顶部 4 个指标卡：今日收益 / 本月收益 / 持仓收益 / 持仓金额。

## 5. 数据源策略

**优先级：管理人官网 / 代销行官方净值 > 中国理财网兜底。** 中国理财网通常慢 1–2 天，只作兜底。

- 按 `sources_config.json` 的链抓取，`chain[0]` 优先级最高
- 合并规则：低优先级先写，高优先级覆盖同日期；保留原有历史
- 若官方源已覆盖到成立日，**跳过中国理财网**（降低滑块人机验证概率）
- 官方源全部失败或历史不完整时才调理财网，失败重试 3 次、5s 递增等待
- 新增日期若 `|万收| > 500` 判为异常跳变，保留旧数据不写入
- 抓取结果早于现有 `latestDate` 时同样拒绝写入

| 适配器 | 站点/接口 | 已接入产品 |
| --- | --- | --- |
| `ccb` | 建行 `WCCMainPlatV5`，先 `TXCODE=NHY000` 初始化会话，`REC_IN_PAGE=1000` | p0157 |
| `bocom` | 交银 `/SITE/queryJylcProductDetail.do` + `/queryJylcBreakDetail.do`，`REQ_MESSAGE` 为 JSON urlencode | p2150 |
| `chinawealth` | 中国理财网，登记编码 + 份额代码，子进程调用 | p2218、p1090（及全部产品兜底） |

产品与来源对照（2026-11-10 实测，`assets/data.js` 跟踪 4 只产品）：

| id | 简称 | 来源 |
| --- | --- | --- |
| p2150 | 交银稳享日日开19号 | 交银理财官网（11-09） |
| p0157 | 建信嘉鑫稳利30天35期 | 建设银行代销净值（11-09） |
| p2218 | 信银安盈象14天165号 | 中国理财网（11-06） |
| p1090 | 中邮鸿锦7天45号 | 中国理财网（11-06） |

## 6. 每日自动化

- **云端**：`.github/workflows/daily-fetch.yml`，`cron: "30 0 * * *"`（北京时间 08:30），步骤为
  装依赖（含 `playwright install --with-deps chromium`、`fonts-noto-cjk`）→ 抓取 → 截图 →
  提交 `assets/data.js snapshots/` → 推送微信 → 失败时发告警
- **本地**：Windows 计划任务 `WealthDashboardDaily`，每日 08:30 调 `daily/run_daily.cmd`
  （关机不补跑，需要补跑时手动执行该 cmd）
- **Gitee Go**：`.workflow/daily.yml` 备用（仅本机保留，不进仓库），额外跑 `tools/sync_pages.py` 同步线上
- 密钥：`daily/serverchan.key`、`daily/github.token`、`daily/stats.json`、`daily/logs/`、`snapshots/`
  均被 `.gitignore` 排除；GitHub 侧用 Secrets `SERVERCHAN_SENDKEY`

## 7. 常见坑

- **用编辑器打开 html 只会看到源码**，必须用浏览器打开；`.html` 当前默认程序为 Chrome
- 建行接口正常时 `Content-Type` 也是 `text/html`，只能按正文判断会话失效（`<` 开头或前 300 字含「交易失败」）
- 中国理财网同一 IP 查询过多会触发滑块验证，故减少调用次数、失败退避
- `file://` 下 fetch/XHR 被禁，data.js 只能用 `<script>` 加载
- html2canvas 渲染原生 `<select>` 会裁字：导出前用 `swapSelects` 换成 span 代理
- 导出宽度固定 1320px，窄窗口先撑宽并临时解除表格横向滚动，导出当前页签整页高度
- 移动端 ≤900px 表格首列（明细前两列）冻结 + 横向滚动，底部显示「← 左右滑动查看完整指标 →」
- GitHub Actions 走境外 IP，建行/交银/光大可能被限流，失败会自动回落理财网
- 本地跑截图必须 `PW_CHANNEL=chrome`；云端用内置 chromium

## 8. 字体字号字重规范（2026-11-19 定稿，两端共同遵守）

改动任何样式前先读 README.md「字体字号字重规范」小节（唯一权威），勿再新增 0.5px 相邻档位。摘要如下：

### 字号阶梯
| 端 | 档位 | 用途 |
|---|---|---|
| 桌面 | 11 / 12 / 13 / 15 / 21 / 36 | 说明副行 / 表头卡片 / 表格正文 / 强调大数 / 区块标题·指标值 / 主标题 |
| 手机竖屏 | 11 / 12 / 12.5 / 17 / 21 | 说明·年月表 / 表头控件 / 表格正文 / 区块标题·指标值 / 主标题 |
| 手机横屏 | 11.5 / 12 / 13 | 表格正文·表头·说明 / 日历主数值 / 强调 |

犄角上标（如 `sup.nav-lag` 的 +N）保持 9px，是唯一例外。手机竖屏盈亏日历年表/月表行高上下 padding 用 7px（2026-11-19 从 12px 压缩）。

### 字重（4 档固定）
- 400：正文、说明
- 600：表头、次级标题
- 700：数值强调、可排序列
- 800：仅主标题

### 颜色与字体
- 辅助/说明文字统一用 `var(--muted)`（#5d6b76，5.48:1，达 WCAG AA），不再新增更浅的灰（旧 `#8a9aa5`/`#93a3ae` 已弃用）。
- 中文一律 `var(--font)`，数字/代码一律 `var(--mono)`；移除 Arial 与混排声明（★ 符号按钮除外）。
- 产品库 `pmeta` 用 `var(--mono)` 13px；chip 用 `var(--font)`。

> 本节已同步进守卫清单 `tools/code_guard_marks.json` 的 protected，标记缺失即整批拒推——Trae 端同步时若用不含本节的旧版覆盖，会被两端共用守卫拦截。

## 9. 改动后验证清单

1. Playwright（`channel="chrome"`）打开页面，无 pageerror、无控制台报错
2. 桌面 1440×1000 与移动 390px 均无横向溢出（`scrollWidth == innerWidth`）
3. 日历边界：最早月左箭头禁用、最新月右箭头禁用
4. 导出 PNG：下拉、按钮、表格无裁切，导出期间隐藏 `.hero-actions`
5. 真实抓取：先 `python daily/serve.py`，再点 `#refresh-data`；按钮应显示「抓取中…」→「已更新/已是最新」，失败时提示「抓取失败/部分更新」且保留旧值
6. 改口径时同步更新 `index.html`「数据来源与口径」说明

## 10. 当前待办 / 风险

- [ ] 中邮（瑞数 WAF）、信银（份额代码核对）的快源攻坚，目前只能靠中国理财网，慢 1–2 天
- [ ] 中银官方接口只到 T-2，需确认是否有更快的详情页接口
- [ ] 首次 GitHub Actions 手动运行需核对境外 IP 下各官网可达性（失败会自动回落，不会中断）
- [ ] 电脑关机当天不会补跑，依赖云端流水线兜底
