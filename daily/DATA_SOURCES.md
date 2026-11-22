# 理财子公司官网净值数据源核查（2026-11-22）

用途：判断哪些官网能程序化拿到 T-1 净值，作为「官网优先、中国理财网兜底」的补充源。
核查口径：当天为 2026-11-22（周日），**T-1 = 2026-11-20（周五）**；
按日开放/现金管理类若周末也披露，最新应到 11-21 或 11-22。

## 一、结论表（均为实测，非推测）

| 机构 | 是否可程序化抓取 | 关键接口 | 实测最新净值日 | 相对 T-1 | 接入成本 |
|---|---|---|---|---|---|
| 农银理财 | ✅ 已接入（2026-11-22） | `POST /awpsservice/fpproduct/productyield/findNetDiscProdList` | 2026-11-22（现金）/ 11-20 | **持平或更快** | 低 |
| 建信理财 | ✅ 可直接接入（已接入） | `GET /website/v1/api/product/detail?id=` / `chart` | 2026-11-22 | **更快** | 已上线 |
| 信银理财 | ✅ 已接入（2026-11-22） | `GET wechat.citic-wealth.com/cms.product/api/custom/productInfo/fundList` | 2026-11-22（货币）/ 11-20 | **持平或更快** | 低 |
| 兴银理财 | ✅ 已接入（2026-11-22） | `POST /api/public/pc/productVal/page` | 2026-11-20 | 持平 | 低 |
| 工银理财 | ✅ 可直接接入 | `POST papi.icbc.com.cn/.../general/getNetValue` | 2026-11-21（现金）/ 11-19（固收） | 现金更快、固收慢 1 天 | 低 |
| 交银理财 | ✅ 可直接接入 | `POST /SITE/queryJylcProductInfo.do`（REQ_MESSAGE 包裹） | 2026-11-21（现金）/ 11-19 | 同工银 | 中 |
| 浦银理财 | ✅ 可直接接入 | `POST /api/search`（chlid 1007 列表 / 1008 净值） | 2026-11-19 | 慢 1 个工作日 | 低 |
| 民生理财 | ✅ 可直接接入 | `POST /gw/po_web/BTAProductQry`（列表自带 NAV/NAV_DATE） | 2026-11-18 | 慢 2 个工作日 | 低 |
| 华夏理财 | ✅ 可接入（流量大） | 静态 `GET /common/js/gmjzbgData.js?t=<ts>` + 单产品 js | 2026-11-19（索引 11-20 发布） | 慢 1 个 | 中 |
| 平安理财 | ⚠️ 可接入（需 SM4） | `POST wmm.pingan.com.cn/app/nvl/getNvlShow`，body 为 SM4-ECB 密文，key 硬编码在前端 | 2026-11-20 | 持平 | 中 + 限频 ~4s/次 |
| 中银理财 | ✅ 可接入（但慢） | `GET /webApi/cms/productNetWorth/getNetWorthByCode` | 2026-11-18 | 慢 2 个 | 低（须逐产品循环） |
| 招银理财 | ❌ 需逆向 | `POST /prod-api/web/api/product/*`，body SM4/AES 密文 + `ts,nonce,md5` 签名 | 11-17（仅封闭式样本） | 不可用 | 高 |
| 光大理财 | ❌ 需过风控 | `POST /eportal/ui?...`，参数名随机 + 瑞数双向密文 | 11-18（无头浏览器 1/5 成功率） | 不可用 | 极高 |
| 中邮理财 | ❌ 不可行 | 全站瑞数 412，Playwright 拿到的 Cookie 回灌仍 400 | 无 | 不可用 | 极高 |

共同点：**除招银/光大/中邮三家外，其余都不需要登录、不需要签名**，卡点只在老 TLS 与分页/字段口径。

## 二、老 TLS 站点的通用处理

工银、农银、交银、浦银、信银、光大、中邮的服务器都要求放开 unsafe legacy renegotiation。
只要 `verify=False` 或 `set_ciphers("DEFAULT@SECLEVEL=1")` 在 requests≥2.32 下**不生效**，必须同时替换
`urllib3.connection.create_urllib3_context`，并在 context 上 `options |= ssl.OP_LEGACY_SERVER_CONNECT`。
另注意：走系统代理会 502，需 `session.trust_env = False`。

## 三、接口要点（按可接入价值排序）

### 农银理财（字段最规整，建议首个接入）
- 清单：`POST https://www.abcwealth.com.cn/awpsservice/fpproduct/productyield/findNetDiscProdList?current=1`，body `{"queryName":""}`，total 2244
- 序列：`POST .../findNetOr7DaysList?productId=<id>&type=<NET|7DAYS>&current=1`
- 字段：`idProduct / namFull / dateNet(yyyyMMdd)`；序列 `vluUnitNet / vluTotNet / vluPftTthou / vlu7DaysYearPft`
- 净值型与现金型用 `type` 一个参数切换，无占位噪声

### 信银理财（列表自带净值，最省请求）
- 列表：`GET https://wechat.citic-wealth.com/cms.product/api/custom/productInfo/fundList?pageNum=1&pageSize=20&productType=<1封闭|2每日购|4货币>&prodSaleCustom=0`
- 字段：`prodCode / prodNameShort / navDate(yyyymmdd) / nav / totalNav`（列表即带最新净值）
- 补历史：`GET .../getTAProductNav?prodCode=<code>&queryUnit=1`
- 实测：每日购类 11-20，货币类 11-22

### 兴银理财（一次能拉全站净值）
- 列表：`POST https://www.cibwm.com.cn/api/public/pc/productInfo/search` body `{"keyword":"","pageNum":1,"pageSize":100}`
- 净值：`POST /api/public/pc/productVal/page` body `{"criteria":{"productCode":"9A290010","startDate":"","endDate":""},"page":{"pageNumber":1,"pageSize":10}}`
- 字段：`netvalDt / effIopv / effTotNetVal`；`criteria` 留空可拉全站（370 万行，需分页）
- 注意：现金管理类存在 `dataDt=11-20` 同时挂 `netvalDt=11-21/11-22` 的双写，别当 T 日净值

### 工银理财
- 列表：`POST https://papi.icbc.com.cn/icbc/iepa/oproxy/finance/deposit/general/productList`，body `{"saleTarget":"","prodIdOrName":"","zoneNo":"0000","pageIndex":1,"pageSize":100}`
- 净值：`POST .../finance/deposit/general/getNetValue`，body `{"prodId":"23GS5355","modelType":"09","pageIndex":1,"pageSize":10}`
- 字段：`workDate / value / totValue`。**`pubDate` 是披露日不是净值日**，用 pubDate 会虚报 T-1
- `consignment/getNetValueList` 对行内产品返回空 `list`，别用它当主接口

### 交银理财
- 列表：`POST https://www.bocommwm.com/SITE/queryJylcProductInfo.do`，form 字段 `REQ_MESSAGE='{"REQ_HEAD":{...},"REQ_BODY":{"pageStart":1,"pageEnd":15,"product":"personal","keyWord":""}}'`
- 历史：`POST /SITE/queryJylcBreakDetail.do`（`type=max` 取全量，`c_interestway` 0=净值型 1=现金型）
- 字段：`c_fundcode / c_fundname / d_cdate / f_netvalue / f_tenthousincome`
- 坑：`pageStart/pageEnd` 是行号不是页码；未成立产品会返回 `d_setupdate` 晚于净值日的占位点（1.0000），须过滤

### 浦银理财
- 统一入口：`POST https://www.spdb-wm.com/api/search`，body `{"chlid":1007|1008|1009|1010,"page":1,"size":30,"searchword":"(prodRegCode='Z7006925000679')",...}`
- `chlid`：1007 产品列表 / 1008 历史净值 / 1009 区间收益 / 1010 业绩基准；`searchword` 是类 SQL 片段，母产品用 `prodRegCode=`，子份额用 `subShareCode=`
- 字段：`netValueDate / shareNetVal / acumltNetVal / netRevPer10000 / yieldSevenDate`

### 民生理财
- 列表：`POST https://www.cmbcwm.com.cn/gw/po_web/BTAProductQry`，form `prd_type=0&pageNo=1&pageSize=500&status=1`，total 3078
- 历史：`POST /gw/po_web/BTADailyQry`，form `chart_type=0&real_prd_code=<code>&begin_date=20260101`
- 字段：`REAL_PRD_CODE / PRD_NAME / NAV / NAV_DATE / TOT_NAV`

### 华夏理财（静态文件，需 cache-busting）
- 索引：`GET https://www.hxwm.com.cn/common/js/gmjzbgData.js?t=<毫秒>`，`var jzbgData = [...]`，10368 条，字段 `{id,title,date,address}`
- 明细：`https://www.hxwm.com.cn` + `address`，内容为 JSON 数组，含 `netValueDate / shareNetVal / prodRegCode`
- **不带 `?t=` 会命中 CDN 拿到约 20 天前的旧快照**，必须 cache-busting

### 平安理财（已逆向，可脱离浏览器）
- `POST https://wmm.pingan.com.cn/app/nvl/getNvlShow`，body 为明文 JSON 的 **SM4-ECB-PKCS7 hex**：
  `{"productId":"QWCG03029A","pageNum":1,"pageSize":5,"startDate":"","endDate":"","currentTimeMillis":<服务器毫秒>,"uuid":"<uuid4>"}`
- 密钥硬编码在前端 bundle：`B34440569682494CCADDAA9D603961D2`；服务器时间取 `GET /common/getCurrentTimeMillis`
- 坑：`pageSize > 8` 被拒（`300315 illegal request`）；约 50 次内触发人机验证，需 4s/次 + 退避

## 四、抓不到 T-1 时的替代路径（按优先级）

1. **代销行官网净值列表**（最快、最稳）。例：建行 `NLC165`（`IvsmPd_ECD` 精确匹配），实测 2026-11-22 当天
   建信 11-21/11-22、中银/交银/中邮 11-19，普遍比理财子公司官网早 1 天且覆盖他行代销产品。
   代码见 `daily/nav_holdings_t1.py::pull_nlc165`。
2. **理财子公司官网**（本文件第一节，能到 T-1 的优先接入：农银、信银、兴银、工银现金类、交银现金类）。
3. **中国理财网**（T+1 报送、T+2 展示，周末不更新）——现有兜底，`daily/nav_bulk.py`。
4. **母行手机银行/网银接口**：结构与代销行官网同级，但通常需要登录态，不建议。
5. **App 端接口**：加固更重，且多需设备指纹，优先级最低。

结论：**T-1 的瓶颈通常不是抓取能力，而是披露节奏**。中银/交银/中邮/光大/民生等在「T+1 的次日上午」才发布
T 日净值，周日的合理上限就是 11-19（周五净值要等周一）。这类滞后不能用抓取解决，只能在页面如实标注披露日。

## 五、建议的接入批次

- 第一批（低风险、当天可上）：农银、信银、兴银——三家都无鉴权、字段干净，能覆盖现金管理类的 T 日净值。
- 第二批：浦银、民生——结构简单但只到 T-1/T-2，价值在于替代中国理财网的限频轮换。
- 第三批（工期大）：平安（SM4 已破解，需限频）、工银、交银（REQ_MESSAGE 包裹 + 两套净值表）。
- 不接入：招银（签名 + 包体加密）、光大（瑞数，无头浏览器成功率 1/5）、中邮（瑞数全站 412）。

## 六、第一批接入实现记录（2026-11-22，daily/nav_sites.py）

批次与验收：农银 3 只 / 信银 6 只 / 兴银 0 只（暂无在库产品），实测 9 只全部由 11-19 推进到 11-20，
与当日工作日 T-1 持平；未命中的产品一律跳过并打印原因，不做猜测性写入。

实现中新发现的、与第三节初稿不同的事实（以本节为准）：

| 机构 | 初稿说法 | 实测修正 |
|---|---|---|
| 农银 | 列表字段含 idProduct/namFull/dateNet | 列表**不含登记编码**，只能按整名（queryName）搜索；实测整名命中唯一（total=1）。序列接口 15 条/页，NET 与 7DAYS 需分别取，净值型 vluUnitNet、现金类 vluPftTthou |
| 信银 | 列表即带最新净值 | 正确，但**不支持名称过滤**（prodName/keyword/name 三个参数都被忽略，total 恒为全量），必须按 productType(1/2/4) 全量索引：实测 1195 个名称、约 22 次请求、pageSize 上限 200 |
| 信银份额 | 未提 | 同一 prodName 下有 B/D 等多个 prodCode（净值可差 0.0001），**代销行字段无法区分**（B/D 同为「建设银行」）。唯一可靠判据是 `getTAProductNav` 的 `productNavPic` 与库内历史逐点比对：B 份额 22/22 精确一致，D 份额仅 0~5/22 |
| 兴银 | search 无登记编码描述 | `productInfo/search` **自带 registerCode**，可直接精确匹配；但同一登记编码下有 A/B/C 多份额，仍需历史比对。`productVal/page` 的 pageSize 上限 100，total 833 |

防串份额规则（三条，改动须同步 nav_sites.py 与本文）：
1. 多候选时，逐点比对库内历史：净值型比 nav（容差 1e-6），现金型（净值恒 1.0）比万份收益（容差 0.02 元/万份）；
2. 最优者须 **≥3 个重叠点且一致率 ≥80%**，否则整只放弃并打印「多份额无法判定」；
3. 单一候选时，无重叠（新品）改用量级校验（尾部净值与库内 latestNav 偏差 ≤2%）。

其他口径修正：
- 兴银现金类存在 `dataDt` 与 `netvalDt` 双写，统一取 `dataDt` 当净值日，避免把次日点当 T 日净值；
- 兴银只有单位净值、没有万份收益字段，合并时对「净值恒 1.0」的序列**保护库内万份收益**，不让 apply() 按净值差重算成 0.00；
- 达标率口径从「自然日 T-1」改为「最近一个已过去的工作日」——周日跑批时自然日 T-1 是周六，永远不可能达标；
- 已接入官网源的机构（建信/中银/农银/信银/兴银）从 `nav_rotate.py` 的中国理财网轮换中排除（常量 `OFFICIAL_ORGS`），限频额度留给没有官网源的产品。

待办（第二、三批）：浦银、民生（第二批）；平安（SM4+限频）、工银、交银（第三批）。
