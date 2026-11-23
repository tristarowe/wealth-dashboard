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
- 已接入官网源的机构（建信/中银/农银/信银/兴银/民生）从 `nav_rotate.py` 的中国理财网轮换中排除（常量 `OFFICIAL_ORGS`），限频额度留给没有官网源的产品。

## 七、第二批接入实现记录（2026-11-23，民生理财）

接口（均无需鉴权，`trust_env=False` 绕代理）：
- 列表 `POST https://www.cmbcwm.com.cn/gw/po_web/BTAProductQry`，body `{prd_type:"0",pageNo,pageSize,code_or_name}`；`code_or_name` 按代码/名称搜索有效（截图两只 FBAE60315A/FBAE0122A 精确命中，NAV/NAV_DATE 与官网展示一致），返回 `list[{REAL_PRD_CODE,PRD_NAME,NAV,NAV_DATE,…}]`。
- 历史 `POST https://www.cmbcwm.com.cn/gw/po_web/BTADailyQry`，body `{chart_type:1,real_prd_code:"FBAE…",begin_date:"",end_date:"",pageNo,pageSize}`；返回 `list[{ISS_DATE,NAV,…}]`，按日期倒序。
- 接口前缀来自详情页 JS `/uiFramework/commonResource/zip/cmbc_wm/skin/js/main.js` 的 `queryData()`（`/gw/po_web/` + 接口名）。

实测要点：
- 民生同产品多份额（A/E/Q/S/B），如 FBAE60315A → 28天15号 A 份额 NAV 1.0410，而库内 28天15号是 **E 份额** FBAE34315E NAV 1.0035，两者是不同产品线（**纯债 vs 固收**），名称包含匹配可区分；7 只在库民生实测全部为 E 份额。
- 官网历史给 6 位小数（现金类如 1.002377），库内是 4 位小数；`cmbc_series()` 统一 `round(nav,4)` 再比对/合并，避免精度差误判串份额。
- 首批结果：7 只全部匹配并推进（历史重叠 18/18～70/70 精确一致；现金类天天盈 21/23 过 80% 阈值），2 只贵竹固收添益官网本身只到 11-19（披露慢），其余到 11-20。
- **建行 App 代销份额确认（2026-11-23）**：建行 App 上的「民生理财富竹固收28天持有期15号」代码为 `FABE34315E000000`，与民生官网 `FBAE34315E`（名称带 E 后缀）中间码 `34315E` 一致——前缀 FABE/FBAE 只是建行代销编码与民生自营编码的差异，**E 即份额标识，建行代销的是 E 份额**（说明书「A 份额：民生银行零售款；E 份额：微众银行个人客户，具体以代理销售机构为准」，末句即代销机构可挂 E 份额的依据）。建行 App 历史净值 9 点（11-10 1.0026 … 11-20 1.0035）与库内/官网 E 份额 9/9 精确一致，确认库内数据未串份额。

## 八、NLC165 全库扩展（2026-11-23，`nav_holdings_t1.py --all`）

背景：`nav_holdings_t1.py` 原本只拿 NLC165 全量索引（8 页约 8000 条）匹配交易清单里的持仓 pid，其余 200 只非持仓产品白白浪费了这条最快渠道——中银非持仓普遍卡在 11-18/19，而 NLC165 网页版已给到 11-20。加 `--all` 开关复用同一份索引补全库，`daily-fetch.yml` 已带上该参数。

防护（比持仓更严，防错配/串数据）：
- 只接受**精确名称**（`name_key` 命中 `nlc_by_name`）或**精确 ECD** 命中，不用 contains 兜底（避免「7号」错配「27号」）；
- 跳过现金类占位：NLC165 对现金管理类给 `nav=1.0`，而库内是 1.00x 折算净值，直接写入会把 per10k 算成大负数——检测 `nav==1.0 且库内 nav≠1.0` 即跳过（乐享天天 50/51/52 号实测命中此规则）；
- 净值量级校验：新 nav 偏离库内 ±5% 即跳过。

实测（2026-11-23）：全库 213 只中 24 只可推进（多为中银稳富/交银稳享系列 11-18/19 → 11-20），抽查隐含万份收益均在 0~1 合理区间，无串数据。悦享天添 26 号等 App 独有产品在 NLC165 网页版**没有**（8 页抓全确认），仍只能靠中银官网（次日）或建行 App 接口（未接入，需逆向）。

**八·补、统一最快口径：代销冠名前缀匹配（2026-11-23）**
- 问题：同机构内净值日期不一致，部分并非源端无数据，而是**建行代销网给产品加了冠名前缀**（如 `南极星稳富7天持有期7号` = 中银「稳富7天持有期7号」、`中邮理财灵活·鸿运日开40号` = 库内简称）。`--all` 原只用精确名称匹配，被前缀挡住 → 退回到更慢的官网/理财网，出现同机构 11-19 与 11-20 混杂。
- 规则：精确名称/ECD 未命中时，用白名单前缀 `NLC_SAFE_PREFIXES`（南极星/中银理财/建信理财/交银理财/光大理财/民生/中邮/农银/信银/兴银）+ 简称/全名的**完整 key 命中**（非裸 contains，避免「7号」错配「27号」）。前缀命中额外过 `隐含万份收益=(新nav−旧nav)×10000 ∈ [−5,5]` 校验，叠加原有 ±5% 量级校验，双保险防串份额。
- 实测：全库仅救回 3 只被前缀挡住的产品（中银稳富14天5号、稳富7天6号、中邮灵活鸿运日开40号，均 11-19→11-20，万份收益 0.30/1.50/1.00 正常），无错配。
- **边界（勿回退）**：同机构日期不一致多数是**源端披露节奏差异**，非抓取规则问题——建信睿鑫180天3期、民生贵竹添益23/24号等，官网/理财网源端本身就停在旧日期，**强行拉齐=伪造净值，绝不可做**。中银悦享天添26-29号、乐享天天53/54号在 NLC165 无匹配、官网只到 11-19，属披露上限；要到 11-20 只能靠建行 App 接口（未接入）。当天披露时滞问题：产品常在早抓之后才披露新值，脚本打 `bocTried/navTried=今日` 后当天不再重试——遇到「官网已有新值但库内滞后」，清该标记即时补刷即可（见当日工作记录）。
- 更正（见第九节）：上段曾把「贝莱德100天1期」归入"源端停更、不可拉齐"，**实证有误**——建行代销 NLC165 其实有它到 11-20 的真实净值，是名称写法（机构名后缀）没匹配上。已由身份核匹配修复。真正的边界只剩"源端确实无数据"的产品。

## 九、身份核归一匹配：彻底解决"名称对不上"（2026-11-23，`nav_holdings_t1.py`）
- 问题：建行代销 NLC165 的净值比理财网快 1~2 天，但部分产品因**名称写法系统性差异**匹配不上，白白退到慢源。三类名差：
  1. **机构名位置不同**：库内 `贝莱德建信理财贝淳金元100天…1期`，代销 `贝淳金元100天…1期贝莱德建信理财`（机构名在尾部）→ 贝淳金元100天1期因此停在 11-10；
  2. **份额字母后缀**：代销 `光大理财阳光金乐盈日开31号…D/I`（尾部单字母标识份额），库内无；
  3. **渠道专享后缀**：代销 `…21天最低持有D房贷专享`，库内无。
- 方案（`identity_key()`）：产品名经 `name_key` 去标点后，再剥离机构名（前/后，`ORG_TOKENS` 按长度降序避免"建信理财"截断"贝莱德建信理财"）+ 渠道专享字样（`CHANNEL_SUFFIX`）+ 尾部份额字母（`_SHARE_TAIL_RE`），得到稳定**身份核**。`build_identity_index()` 从 NLC 名称索引派生 `{身份核:[(date,nav,全名)]}`；持仓路径 1c 与 `--all` 均用 `pick_identity()` 做身份核**精确等值**匹配（非裸 contains，避免"7号"错配"27号"）。
- 防串四道闸：① 身份核精确等值；② 隐含万份收益 `(新nav−旧nav)×10000 ∈ [−5,5]`（D/I 份额差 0.0001=1 元过，跨产品线差几倍被拦）；③ 同日多候选净值差 >0.5% 整只放弃；④ 保留原有现金类 nav=1.0 占位跳过 + ±5% 量级。多候选时取日期最新、净值与库内最接近者。
- 实测（2026-11-23 dry-run + 写入）：35 只推进，贝莱德 20/20 全部到 11-20（100天1期 11-10→11-20 nav 1.0049）、光大 8 只到 11-20、交银 3 只到 11-20；现金类 3 只正确跳过，无异常/无串份额。
- 交银官网单点兜底：少数产品（灵动慧利132/133号、固收精选12号）NLC165 未收录或持平，但官网已披露 11-20。`BOCOM_FUNDCODES` 按 pid 精确锁定 fundcode（**勿按名称匹配，同名多期易串**），`pull_bocom_index()` 一次拉全量列表 + 代码检索，官网点同样过万份收益 ±5 校验。映射经实测校准：133号=5811226658、132号=5811226608、12号=5811226579。
- **仍属源端上限（勿强拉）**：光大 6 只停在 11-19（代销源本身只到 19）、交银 12 只停 11-19（官网未披露），这些是真·披露节奏，不是匹配问题。

## 十、新品预告名称抽取修复（2026-11-23，`fetch_newproducts.py`）
- 问题：用户问「11.24-11.30 没有新品吗」——实为**两条叠加**：① 数据是当日 06:01 旧快照（建行下午才发新公告），重抓后入库 3→10 只；② 部分 PDF 产品全称抽取错乱/漏抓，即使重抓也脏。
- **名称抽取**（`extract_product_name()`）：旧逻辑 `flat_field(flat,"理财产品名称")` 会命中正文释义句「在同一理财产品名称下设置…」；而要素表真实标签多为「产品名称」（无"理财"二字）。修法：去空白愈合被 PDF 拆断的标签（「理财产 品名称」「147 号」）→ 收集所有 `(理财)产品名称` 候选 → 遇下一字段名截断 + 形态校验（含产品特征词、排除释义句）→ 取首个像产品名的。修复了交银147号、信银258号名称混入正文、招银60天/工银158号名称为空的问题。
- **成立日兜底**（`extract_dates()` ③b）：招银说明书要素表标签被断字成「产品成↵立日」匹配不到 → 成立日空 → `plausible()` 判假被丢。兜底改取「认购登记日/产品登记日」的具体日期（与成立日一致）。`label_dates()` 本就遍历所有标签取首个带日期者，无需改。
- 效果：10 只入库（中邮 2025-06 旧公告正确 dropped），其中 7 只募集日落在 11.24-11.30。守卫 a26→a27。
- **成立日多算一天修复（同日二次修）**：用户拿说明书截图问「成立日 12-01 为何看板显示 12-02」。根因：`label_dates` 用泛化标签「成立日」+ span=80，先命中正文「成立日后的2个工作日…2026-12-02」，抢在要素表「产品成立日期 2026-12-01」之前。修法：成立日优先用精确标签（产品成立日期/理财产品成立日/产品成立日）+ 紧邻日期 span=26，只认要素表直读；失败再回退宽泛标签、再回退认购登记日。光大3只 12-02→12-01（与截图一致）；信银258 的 12-02 是其 PDF 原文真实值，不变。
- **代销机构「待核实」根因**：`channel_raw` 原用 `flat_field(flat,"理财产品销售机构")` 先命中正文噪音（如「销售服务费支付给理财产品销售机构」）顶掉解析器有效字段。改为三源按可信度取首个 `clean_channels` 非空者（解析器字段 > 标准标签 > 代销语境兜底）。兜底 `sale_channel_fallback()` 只认销售/代销语境（合作销售机构信息/代销机构基本信息/代销机构/销售机构：指XX），**绝不取「托管人：指XX银行」**（交银147里托管人也是建行，误取会串）。结果：交银147、信银258 补上"建设银行"；工银158、招银60天说明书确无明确代销行字段（招银只有"销售服务机构：指…"释义句无点名），如实保留"待核实"，不瞎填。守卫 a27→a28。
- **渠道覆盖仍只有建设银行**：`crawl_notices()` 走建行 `NF5011` 接口，payload 里 source 文案「六大行及股份制银行」与实际不符（历史遗留，未改）。其他行的新品公告未接入——这是「某周看似无新品」的结构性原因之一，后续可扩渠道。

## 十一、新品预告排版改版：方案C 日期泳道列 + 代销机构多选（2026-11-23，`index.html` / `assets/dashboard.js`）
- 问题：用户反馈新品变多后旧「甘特图按募集天数拉伸卡片宽度」排版乱——单日募集卡片窄、跨日的宽，名称被压成省略号，日期显示不全。出 3 套图稿（`新品预告排版图稿.html`），用户选方案 C。
- **布局（方案C）**：日期泳道列——每天一列、卡片等宽 184px（横屏 170px），起始日相同的产品竖排当列，跨日募集在卡片内用 `起→止` 注明，不再按跨度拉伸。表头 `#np-head` 改为纯日期列（与泳道同宽对齐，横向滚动）；卡片竖向结构：`机构·代销` / 名称（两行完整换行 `word-break:break-all`）/ 募集·成立·风险·额度两行。空日期列灰底「无新品」。
- **代销机构多选联动**：按钮从旧表头第一列 `#np-org-sel`（单选）移到**表头上方工具栏** `.np-toolbar`，`multiple` + 复用 `.sel-wrap`/`openSelPop` 多选弹层（`npBindMultiSel()`）。状态 `NP_UI.channels`（数组，空=全部）；数据从 `NP.lanes` 拉平为 `flat`（每件附 `saleChannel`，空→「待核实」），按选中机构过滤后再按募集起始日分桶入列。实测：全选10只、只选建设银行8只、只选待核实2只、组合正常，label/hint/统计同步。
- **手机端**：泳道改纵向日期分组（一天一组，日期头 `.lane-day` 在 lane 内显示，桌面隐藏），保证长图截图截全所有新品（横向滚动方案在手机上会只截到第一列）。`#np-head` 手机隐藏。
- **兼容**：保留 `.ts-lane/.nchip/.nr/.nm/.na/.rk` 类名供 `daily/shot.py` 截图元数据校验；`.nr` 现在是 `11.23` 或 `11.23→11.26`，已同步把 shot.py 的 date 解析改为 `split(/[→\-－]/)[0]` 取起始日，保证推送排序/展示正确。守卫 a28→a29（删除旧甘特标记，登记方案C新标记）。
- 数据文件本身未改（`newproducts.json`/`newproducts.js` 无变化）——本次纯前端排版改造。

待办（第三批）：平安（SM4+限频，密钥已破解见本文第一节）、工银、交银官网全量轮换（单点兜底已用于 3 只，未做全量接入）；第二批的浦银尚未接入。建行 App 端接口（覆盖悦享天添 26 号等 App 独有产品）需专项逆向。
