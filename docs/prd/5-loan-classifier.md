# PRD #5 — E4 贷款应用识别引擎

| 项 | 值 |
|---|---|
| Issue | [#5 E4 贷款应用识别引擎](https://github.com/zequnjiang/AppeyeCC/issues/5) |
| 类型 / 优先级 | Epic（作为单个可交付需求）/ P0 |
| 领域 | `area:classify` |
| 依赖 | E1（#2）：`classification_rules` 表、`RuleKindSchema`、`ManualLabelSchema`、`CountriesConfigSchema.loan_threshold`；PRD #3 §4.1 的 `NormalizedApp` 类型（引擎只依赖类型，不依赖 E2/E3 实现） |
| 被依赖 | E5（管道在详情落库前调用）、E7（`PATCH /apps/:id/label`、规则 CRUD 后重算） |
| 口径来源 | CEO 批准方案第 3 节「识别引擎」；`config/countries.yaml` 的 `rules` / `global_rules` / `loan_threshold`；Google Play 金融政策 [answer/9876821](https://support.google.com/googleplay/android-developer/answer/9876821) |

## 1. 背景与目标

采集层每小时会拉回数百个 Finance 类候选应用，其中大部分是银行、钱包、记账、投资、计算器等非贷款应用。识别引擎负责用**可解释的加权规则**判断一个应用是否为「个人贷款应用」，输出得分与命中明细，供管道写入 `apps.is_loan / loan_score / classification_json`，供后台展示「为什么判为贷款」，并允许人工 `manual_label` 覆盖。

设计原则：**规则驱动、纯函数、可解释、可回归**。规则来自 DB（`classification_rules`，种子来自 YAML），阈值来自 YAML `loan_threshold`；每一次判定都能列出命中了哪些规则、在哪个字段、摘录是什么。

## 2. 用户故事

- 作为 **管道（E5）**，我希望调用 `classify(app, country, rules, threshold)` 就得到 `isLoan/score/matches`，以便直接落库并在跨阈值时发 `classified_loan` 事件。
- 作为 **运营**，我希望在应用详情页看到「命中：泰语贷款关键词(+3, title: "…สินเชื่อ…")、BoT 披露(+3, description: "…")、FINANCE 分类(+2)」，以便判断误判并调规则。
- 作为 **运营**，我希望手动把误判的应用标为「非贷款」后，无论规则怎么算它都不再出现在贷款列表，以便结果可控。
- 作为 **CTO / 测试**，我希望每个国家都有真实商店文案构成的正例/负例，以便每次改规则都能回归。

## 3. 功能范围与非目标

### 3.1 范围

| 路径 | 内容 |
|---|---|
| `apps/server/src/classify/types.ts` | `ClassificationRule`、`ClassifyInput`、`ClassifyResult`、`RuleMatch`（§4.1） |
| `apps/server/src/classify/engine.ts` | `classify()` 纯函数；`compileRules()` 预编译（正则缓存） |
| `apps/server/src/classify/text.ts` | 文本规范化（NFKC、小写、空白折叠）、摘录生成 |
| `apps/server/src/classify/rules-repo.ts` | `loadRules(db, { country, store })` 从 `classification_rules` 读取 + 进程内缓存 + `invalidateRules()` |
| `apps/server/src/classify/threshold.ts` | `getLoanThreshold()`：读取 `loadCountriesConfig().loan_threshold`（E1 提供） |
| `apps/server/src/classify/index.ts` | 组合入口 `classifyApp(db, app, country)`（读规则 + 阈值 + 调 `classify`） |
| `packages/shared/src/classify.ts` | `ClassifyResultSchema` / `RuleMatchSchema`（zod，供 API 返回 `classification_json` 与前端渲染） |
| `apps/server/test/fixtures/classify/<cc>/{positive,negative}/*.json` | 每国正例 ≥5、负例 ≥5，真实商店文案 |
| `apps/server/test/classify/*.test.ts` | 引擎单测 + fixtures 回归 |
| `config/countries.yaml` | 若回归发现种子规则不足，允许调整 weight/pattern/新增规则（改动写入 PR「假设与取舍」） |

### 3.2 非目标

- 不做机器学习/LLM 判定；不调用外部 API。
- 不做规则 CRUD API（E7）与后台页面（E9）。
- 不负责写库（`apps.is_loan` 等由 E5 写）；不负责发 `classified_loan` 事件（E5）。
- 不对 `reviews`、`releaseNotes`、`developerName` 打分（首版只看 title/summary/description/genre；见 §7 Q3）。
- 不做多语言分词/词干化；关键词为子串匹配。

## 4. 接口定义

### 4.1 类型（`classify/types.ts`）

```ts
import type { NormalizedApp } from '../scrapers/types.js';
import type { RuleKind, ManualLabel, Store } from '@appeye/shared';

export interface ClassificationRule {
  id: number | string;        // DB id；测试/YAML 直读时可用 'th:0' 这样的字符串
  country: string | null;     // null = 全局
  store: Store | 'both';
  kind: RuleKind;             // 'keyword' | 'regex' | 'category' | 'negative'
  pattern: string;
  weight: number;             // negative 为负数
  note?: string | null;
  enabled: boolean;
}

export type MatchField = 'title' | 'summary' | 'description' | 'genre';

export interface RuleMatch {
  ruleId: number | string;
  kind: RuleKind;
  pattern: string;
  weight: number;
  field: MatchField;
  excerpt: string;            // 命中处前后各 ≤40 字符（总 ≤ 100），命中词原样保留
}

export interface ClassifyInput {
  app: Pick<NormalizedApp, 'store' | 'title' | 'summary' | 'description' | 'genre' | 'genreId'>;
  country: string;
  rules: ClassificationRule[];   // 调用方已按 country/store 过滤或未过滤均可，引擎再过滤一次
  threshold: number;
  manualLabel?: ManualLabel | null;
}

export interface ClassifyResult {
  isLoan: boolean;            // 最终判定（已应用 manualLabel）
  score: number;              // 规则得分（不受 manualLabel 影响）
  threshold: number;
  matches: RuleMatch[];       // 按 weight 绝对值降序，再按 ruleId
  manualLabel: ManualLabel | null;
  ruleScoreIsLoan: boolean;   // 纯规则判定（score >= threshold），便于后台展示「规则说 X，人工改为 Y」
  engineVersion: 1;
}

export function classify(input: ClassifyInput): ClassifyResult;
export function compileRules(rules: ClassificationRule[]): CompiledRule[];   // 可缓存；无效正则被剔除并 warn
```

`classification_json` 列存 `ClassifyResult` 的 JSON（`packages/shared` 的 `ClassifyResultSchema` 与之一致）。

### 4.2 规则筛选

引擎对 `input.rules` 应用以下过滤后才参与打分：

1. `enabled === true`；
2. `country === null || country === input.country`；
3. `store === 'both' || store === input.app.store`。

### 4.3 匹配语义

| kind | pattern 语义 | 匹配字段 | 匹配方式 |
|---|---|---|---|
| `keyword` | 以 `\|` 分隔的若干**字面**词（如 `สินเชื่อ\|เงินกู้`，`préstamo\|prestamo`） | title, summary, description | 每个词做**子串**匹配（不加词边界，因泰语/印尼语无空格分词）；任一词命中即该字段命中 |
| `regex` | JS 正则源码，编译 flags `iu` | title, summary, description | `RegExp.test`；`\b` 等按 Unicode 语义 |
| `category` | 分类常量名（如 `FINANCE`） | genre | 命中条件：`normalizeGenre(app.genreId) === pattern.toUpperCase()` **或** `normalizeGenre(app.genre) === pattern.toUpperCase()`，其中 `normalizeGenre(s) = s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')`。因此 GP `genreId="FINANCE"` 与 iOS `genre="Finance"` 均命中 `FINANCE`；iOS `genreId="6015"` 不命中但不影响结果 |
| `negative` | 与 `regex` 相同（JS 正则，`iu`） | title, summary, description | 命中则加上 `weight`（负数） |

通用规则：

- **大小写不敏感**：文本与 keyword 词均先 `normalizeText()`：`String.prototype.normalize('NFKC')` → `toLowerCase()`（用默认 locale，不用 `toLocaleLowerCase('tr')` 等特殊）→ 空白（含 ` `、全角空格、换行）折叠为单个空格 → `trim()`。正则对规范化后的文本执行。
- **Unicode 安全**：泰文、阿拉伯文（乌尔都语）、带重音的西语在 NFKC 后按码点匹配；正则必须带 `u` 标志；`keyword` 词内若含正则元字符（`.`、`+`、`(`）按字面处理（引擎用 `indexOf`，不构造正则）。
- **同一规则在同一字段只计一次**：一条规则在 `description` 里命中 5 次仍只加 1×weight；同一规则在 `title` 与 `description` 各命中一次 → 2 条 `RuleMatch`，2×weight。
- **空字段**：`summary === null` 时跳过该字段；`description` 为空串同样跳过。
- **无效规则**：`regex/negative` 的 `pattern` 无法 `new RegExp(p,'iu')` → 剔除并 `logger.warn({ruleId})`，不抛错，不影响其它规则；`keyword` 拆分后为空词（如 `a||b` 中的空段）忽略。
- **得分**：`score = Σ matches.weight`（整数）。
- **判定**：`ruleScoreIsLoan = score >= threshold`；`isLoan = manualLabel === 'loan' ? true : manualLabel === 'not_loan' ? false : ruleScoreIsLoan`。
- **excerpt**：对 keyword/regex/negative 取该字段**首个**命中位置，向前向后各截 40 个码点（`Array.from(text)` 计数，避免拆坏代理对），超出边界不补省略号；category 的 excerpt 为 `app.genre ?? app.genreId ?? ''`。
- **确定性**：相同输入输出完全相同（`matches` 顺序稳定：`|weight|` 降序 → `ruleId` 升序 → `field` 按 title/summary/description/genre）。

### 4.4 规则加载与阈值

- `loadRules(db, { country, store })`：查询 `classification_rules WHERE enabled=1 AND (country IS NULL OR country=?) AND store IN ('both', ?)`，映射为 `ClassificationRule[]`；进程内按 `${country}:${store}` 缓存，TTL 60 s；`invalidateRules()` 清空（E7 规则 CRUD 后调用）。
- `getLoanThreshold()`：`loadCountriesConfig().loan_threshold`（当前 6），进程内缓存；允许 env `LOAN_THRESHOLD` 覆盖（数字，用于运维临时调参；写入 `.env.example` 注释）。
- `classifyApp(db, app, country, manualLabel?)`：组合以上三者调用 `classify`，供 E5 使用。

### 4.5 fixtures 规范

- 目录：`apps/server/test/fixtures/classify/<cc>/positive/*.json`、`.../negative/*.json`，`cc ∈ {th,mx,ph,pk,id,ar}`，每目录 ≥ 5 个文件（合计 ≥ 60）。
- 每个文件：

```json
{
  "store": "gp",
  "storeAppId": "com.example.app",
  "capturedAt": "2026-09-08",
  "source": "https://play.google.com/store/apps/details?id=com.example.app&hl=th&gl=th",
  "title": "…",
  "summary": "…或 null",
  "description": "…（真实商店文案，可截断到前 3000 字符）",
  "genre": "Finance",
  "genreId": "FINANCE",
  "expected": true
}
```

- **必须用真实商店文案**（由 CTO 通过 E2/E3 适配器、库 CLI 或商店页面复制），不得编造；`source` 可追溯。
- 正例：该国实际在架的个人贷款/现金贷/BNPL-cash 应用（含至少 1 个 iOS、至少 1 个本地语言描述为主的应用）。
- 负例：至少覆盖 5 类中的 4 类：银行官方 App、电子钱包/支付、记账/预算、投资/股票/加密、贷款计算器/EMI 计算器、游戏或与「cash」谐音的非金融应用。每国负例中至少 1 个 `genreId` 为 FINANCE（确保不是仅靠分类判定）。
- 回归测试：用 `loadCountriesConfig()` 的 YAML 规则（转换为 `ClassificationRule[]`，`id` 形如 `th:0` / `global:3`）与 `loan_threshold` 跑全部 fixtures，`expected` 必须全部命中。若真实文案导致失败，优先调整 YAML 规则（权重/模式/新增），**不得修改 fixture 文案或 expected**；调整说明写入 PR。

## 5. 验收标准（AC）

全部离线，随 `npm test` 运行。下列「规则集 R0」指从当前 `config/countries.yaml` 转换得到的规则集，阈值 6。

- **AC-1 类型与 schema**：`classify/types.ts` 导出 §4.1 全部类型；`@appeye/shared` 导出 `ClassifyResultSchema`、`RuleMatchSchema`；`ClassifyResultSchema.parse(classify(...))` 不抛错；`npm run typecheck` 通过。
- **AC-2 基本打分**：单条 `keyword` 规则 `pattern='loan', weight=2`，app `{title:'Quick Loan', summary:null, description:'get a loan today', genreId:'TOOLS'}` → `score=4`，`matches` 长度 2（field 分别 title、description），`isLoan=false`（阈值 6）。
- **AC-3 同字段只计一次**：description 含 3 次 `loan` → 该规则在 description 仅 1 条 match，`score=2`。
- **AC-4 大小写不敏感**：`pattern='préstamo'` 对 `'PRÉSTAMO RÁPIDO'` 命中；`pattern='LOAN'` 对 `'loan'` 命中；regex `pattern='\\bAPR\\b'` 对 `'apr 36%'` 命中（`i` 标志）。
- **AC-5 Unicode 安全**：keyword `'สินเชื่อ'` 对 `'สินเชื่อส่วนบุคคล'` 命中；keyword `'قرض'` 对含该词的乌尔都文描述命中；NFKC：keyword `'loan'` 对全角 `'ｌｏａｎ'` 命中；excerpt 截取含表情符号/泰文组合字符的文本时不产生孤立代理对（`excerpt` 通过 `encodeURIComponent` 不抛 `URIError`）。
- **AC-6 keyword 字面匹配**：keyword `pattern='c.a.s.h'` 不命中 `'crash'`（点按字面），命中 `'c.a.s.h'`；keyword `'a||b'` 等价于 `'a|b'`。
- **AC-7 regex 与 negative**：regex `'(\\d{1,3})\\s*(days)\\b.{0,60}(\\d{2,4})\\s*(days)'` 对 `'Loan term: 91 days to 365 days'` 命中；negative `'\\bgame\\b'` weight −4 对 `'Cash Game Tycoon'` 命中且 `score` 减 4；negative 对 `'gamers'` 不命中（词边界）。
- **AC-8 category 跨商店**：category `pattern='FINANCE'` weight 2：对 `{genreId:'FINANCE', genre:'Finance'}`（GP）命中；对 `{genreId:'6015', genre:'Finance'}`（iOS）命中；对 `{genreId:'6015', genre:'Finanzas'}` 不命中；对 `{genreId:'TOOLS', genre:'Tools'}` 不命中；match 的 `field==='genre'`。
- **AC-9 规则筛选**：规则集含 `country:'mx'`、`country:null`、`country:'th'` 三条相同 pattern/weight 的 keyword 规则，对 `country:'th'` 的 app 判定时只有 `null` 与 `'th'` 两条生效（同一字段 `matches` 为 2 条、得分为 2×weight）；`store:'ios'` 的规则对 `store:'gp'` 的 app 不生效；`enabled:false` 的规则不生效。
- **AC-10 无效正则不致命**：规则集含 `regex pattern='('` 与一条正常 keyword，`classify` 不抛错，正常规则照常计分，logger 收到 1 条 warn 含该 `ruleId`。
- **AC-11 manual_label 优先**：`score=10`（≥6）+ `manualLabel:'not_loan'` → `isLoan=false, ruleScoreIsLoan=true, score=10`；`score=0` + `manualLabel:'loan'` → `isLoan=true, ruleScoreIsLoan=false`；`manualLabel:null/undefined` → `isLoan===ruleScoreIsLoan`。
- **AC-12 阈值边界**：`score=6, threshold=6` → `isLoan=true`；`score=5` → false；`threshold` 原样回填到结果。
- **AC-13 excerpt**：description 为 200 个字符、命中词在第 100 位 → `excerpt` 长度 ≤ 100 码点且包含命中词；命中词在开头 → excerpt 以命中词开头。
- **AC-14 确定性与顺序**：同一输入调用两次 `JSON.stringify` 结果相同；`matches` 按 `|weight|` 降序、`ruleId` 升序、field 顺序 title→summary→description→genre。
- **AC-15 fixtures 数量与真实性**：6 国 × (positive ≥5, negative ≥5)，每个文件含 `storeAppId/source/capturedAt/expected`，`source` 为商店 URL；至少 6 个 iOS fixture（每国 ≥1）；每国负例中 ≥1 个 `genreId` 为 FINANCE/6015；Alex 抽 3 个 fixture 打开 `source` 核对标题一致。
- **AC-16 fixtures 回归**：用 R0 与阈值 6 对全部 fixtures 运行，`isLoan === expected` 全部通过；测试输出每国 TP/TN 计数。
- **AC-17 全局规则计数**：R0 中 `country===null` 的规则数 === YAML `global_rules` 长度；`th` 生效规则数 === `global_rules` + `th.rules` 长度（通过 `compileRules` 后过滤计数断言）。
- **AC-18 DB 规则加载**：在临时库 `db:seed` 后，`loadRules(db,{country:'th',store:'gp'})` 返回条数 = AC-17 的 th 生效数；把一条 th 规则 `enabled=0` 后，缓存未过期时返回不变，`invalidateRules()` 后减少 1；`store='ios'` 的规则不出现在 `store:'gp'` 结果中。
- **AC-19 端到端组合**：`classifyApp(db, <th 正例 fixture>, 'th')` 返回 `isLoan=true`，`matches` 非空且每条 `ruleId` 为 DB 整数 id；将该 app 的 `manualLabel='not_loan'` 传入 → `isLoan=false`。
- **AC-20 性能**：R0（当前 26 条规则）对 1000 个描述长度 3000 字符的 app 连续 `classify`，总耗时 < 2 s（`compileRules` 只做一次）。
- **AC-21 质量门**：`npm run lint && npm run typecheck && npm test` 通过；若调整了 `config/countries.yaml`，E1 的种子测试仍通过（AC 计数从 YAML 动态计算）。

## 6. 非功能要求

- **纯函数**：`classify` / `compileRules` / `normalizeText` 无 I/O、无全局状态（正则缓存可作为 `compileRules` 返回值携带）。
- **性能**：单次 `classify` ≤ 2 ms（3000 字符描述、30 条规则）；规则预编译缓存。
- **安全**：规则由后台管理员编辑，仍需防 ReDoS：`pattern` 长度 ≤ 500；`compileRules` 拒绝长度超限规则（warn）；文档提示避免嵌套量词。**不**引入正则超时依赖。
- **可解释**：`RuleMatch` 必须携带 `pattern`、`weight`、`field`、`excerpt`，后台不需回查规则表即可渲染。
- **日志**：warn = 无效规则 / 超长规则；debug = 每次判定 `{appId?, country, score, isLoan, matchCount}`（由调用方 E5 打，引擎接受可选 logger）。
- **向后兼容**：`engineVersion` 固定 1；未来改匹配语义须升版本并在 `classification_json` 中可区分。

## 7. 风险与开放问题

| # | 类型 | 内容 | 建议 |
|---|---|---|---|
| Q1 | 风险 | 全局 keyword `loan\|cash\|credit\|lending\|borrow` 权重 2 采用子串匹配，`cash` 会命中 cashback/cashier，`credit` 会命中 credit card；FINANCE +2 再加一次即 4 分，接近阈值。 | 依赖 negative 规则与阈值 6 兜底；fixtures 回归若暴露误判，优先把该全局 keyword 改成 regex 词边界版本（`\\b(loan|lending|borrow)\\b`）并把 `cash/credit` 降权，改动写入 PR。 |
| Q2 | 风险 | 巴基斯坦规则最少（2 条，最高 4+2=6 恰好达阈值），且 GP 政策要求「一 NBFC 一 App」的披露文案在描述中不一定出现。 | 回归时若 pk 正例不足 6 分，允许新增 pk regex（如 `\\bNBFC\\b`、`Islamic finance`、`installment`）；PM 已在 YAML 之外不预设，交由真实文案决定。 |
| Q3 | 开放 | 是否将 `releaseNotes`、`developerName` 纳入匹配字段？（如开发者名含 "Lending"） | 首版不纳入，保持字段集 title/summary/description/genre；E5 上线两轮后按误判样本决定。 |
| Q4 | 开放 | `loan_threshold` 是否按国家区分？ | 首版全局单一阈值；若需要，可在 YAML `countries[].loan_threshold` 覆盖（需同步 E1 schema），本期不做。 |
| Q5 | 假设 | iOS `genreId="6015"` 不做映射表，靠 `genre` 名 `Finance` 归一化命中 `FINANCE`；非英语商店语言下 iOS `primaryGenre` 可能本地化（如 `Finanzas`）。 | 若网络测试发现 iOS 在 `es` 语言下返回本地化分类名，在 E3 适配器增加 `6015→FINANCE` 的 genreId 映射（PRD #4 Q 项更新），引擎语义不变。 |
| Q6 | 假设 | `negative` 采用正则语义而非 keyword 语义，因种子里混用了 `\\bgame\\b` 与纯词。 | 已采纳并在 §4.3 固定。 |
| Q7 | 假设 | `manual_label` 只覆盖 `isLoan`，不改变 `score`，后台同时展示两者。 | 已采纳。 |
| Q8 | 风险 | fixtures 依赖 CTO 手工收集 60+ 条真实文案，工作量大。 | 可用 E2/E3 适配器 + `RUN_NETWORK_TESTS` 一次性录制（每国 search 2 个词取前 10 条，人工标注 expected）；文案截断到 3000 字符以控制仓库体积。 |
