# PRD #4 — E3 App Store 采集适配层

| 项 | 值 |
|---|---|
| Issue | [#4 E3 App Store 采集适配层](https://github.com/zequnjiang/AppeyeCC/issues/4) |
| 类型 / 优先级 | Epic（作为单个可交付需求）/ P0 |
| 领域 | `area:scraper` |
| 依赖 | E1（#2）：字段口径；`countries.ios_lang` |
| 并行 | E2（#3）。**统一契约（`NormalizedApp` 等类型、`StoreAdapter` 接口、`ScraperError`、`fetch.ts`、`retry.ts`）以 PRD #3 §4.1–§4.4 为权威定义，本文不重复其全文，只写 App Store 的实现要求与差异。** 若 E3 先于 E2 合并，E3 按 PRD #3 §4 落地共用文件。 |
| 口径来源 | CEO 批准方案第 3 节；`@perttu/app-store-scraper@2.1.0` 的 `dist/index.d.ts`、`dist/index.js`、README |

## 1. 背景与目标

App Store 是第二个数据源。与 Google Play 库不同，`@perttu/app-store-scraper`：**无内置节流**（Apple 对同一 IP 频繁 429）、**错误是普通 `Error` + 消息字符串**（无类型化错误类）、**无下载量**（只有评分数与榜单名次）、但提供 **`privacy`（隐私标签）、`versionHistory`、`ratings` 直方图**。本 Epic 要把这些差异封装在 `IosAdapter` 内部，对外输出与 GP 完全一致的 `Normalized*` 结构。

目标：

1. `createIosAdapter()` 实现 `StoreAdapter`，覆盖 `list(FINANCE TOP_FREE/NEW_FREE)`、`search`、`app(ratings:true)`、`developer`、`similar`、`reviews`、`privacy`、`versionHistory`。
2. 自建令牌桶限流（默认 3 rps，`IOS_THROTTLE_RPS`）+ 并发上限 + `requestOptions{ timeout, retries, retryDelay, fetch }`。
3. 错误按消息/状态码映射为 `ScraperError`（`not_found / rate_limited / blocked / spec_drift / network`），对库返回做 zod 形状校验以检测 **spec_drift**。
4. 真实 JSON fixtures 单测 + `RUN_NETWORK_TESTS=1` 受限真实抓取。

## 2. 用户故事

- 作为 **管道开发者（E5）**，我希望 iOS 与 GP 的 `details()` 返回同一个 `NormalizedApp`，缺失能力用 `null` 表示，以便 diff 逻辑不写 `if (store === 'ios')`。
- 作为 **运营**，我希望 iOS 应用也能看到隐私标签与版本历史，以便弥补没有下载量的缺口。
- 作为 **运维**，我希望 Apple 429 时系统自动退避而不是整轮失败，以便每小时任务稳定。
- 作为 **测试工程师**，我希望离线用 fixtures 验证全部映射，以便 CI 不依赖 Apple 可用性。

## 3. 功能范围与非目标

### 3.1 范围

| 路径 | 内容 |
|---|---|
| `apps/server/src/scrapers/throttle.ts` | `createTokenBucket({ rps, burst })` 与 `createLimiter({ concurrency })`（共用，可被 E5/E6 复用） |
| `apps/server/src/scrapers/ios/client.ts` | 包一层：为每次库调用注入 `country`、`lang`、`requestOptions`，并经令牌桶 + 并发限制 |
| `apps/server/src/scrapers/ios/adapter.ts` | `createIosAdapter(deps?)` |
| `apps/server/src/scrapers/ios/normalize.ts` | iOS `App / ListApp / Review / PrivacyDetails / VersionHistory` → `Normalized*` 纯函数 |
| `apps/server/src/scrapers/ios/schemas.ts` | 对库返回的最小 zod 形状校验（用于 spec_drift 判定） |
| `apps/server/src/scrapers/ios/errors.ts` | 消息/状态码 → `ScraperError` |
| `apps/server/src/scrapers/index.ts` | `getAdapter('ios')` 分支 |
| `apps/server/test/fixtures/ios/**` | 真实 JSON fixtures + README |
| `apps/server/test/scrapers/ios/*.test.ts` | 离线单测 |
| `apps/server/test/network/ios.network.test.ts` | 真实测试 |

### 3.2 非目标

- 不做候选池、diff、落库、cron（E5/E6）。
- 不封装 `inAppPurchases`、`suggest`、`ratings()` 单独调用（直方图通过 `app({ratings:true})` 获得）。
- 不接真实代理，只用 `resolveFetch('ios', country)` 钩子。
- 不做 iPad/Mac 榜单（只用 `TOP_FREE_IOS` / `NEW_FREE_IOS`）。

## 4. 接口与实现定义

### 4.1 契约

实现 PRD #3 §4.2 的 `StoreAdapter`。工厂：

```ts
export interface IosAdapterDeps {
  lib?: IosLibLike;                         // Pick<typeof import('@perttu/app-store-scraper'), 'list'|'search'|'app'|'developer'|'similar'|'reviews'|'privacy'|'versionHistory'>；默认真实库
  throttleRps?: number;                     // 默认 config.iosThrottleRps（3）
  concurrency?: number;                     // 默认 2
  requestOptions?: { timeout?: number; retries?: number; retryDelay?: number };  // 默认 {15000, 3, 500}
  retry?: Partial<RetryPolicy>;             // 外层 withRetry，同 PRD #3 §4.5
  logger?: Logger;
  now?: () => number;                       // 令牌桶测试用
}
export function createIosAdapter(deps?: IosAdapterDeps): StoreAdapter;
```

`capabilities` 固定为 `{ installs:false, permissions:false, dataSafety:false, privacy:true, versionHistory:true, newFreeCollection:true, reviewsCount:false }`。

### 4.2 限流（`scrapers/throttle.ts`）

- 令牌桶：`createTokenBucket({ rps, burst = rps })` 返回 `{ take(): Promise<void> }`；每秒补 `rps` 个令牌，桶满 `burst`；`take()` 无令牌时等待。**iOS 全局一个桶**（Apple 按 IP 限流，与国家无关），不是每国一个。
- 并发限制：`createLimiter({ concurrency })` 返回 `run<T>(fn: () => Promise<T>): Promise<T>`，同时在飞的库调用 ≤ `concurrency`。
- 每次库调用 = `limiter.run(async () => { await bucket.take(); return lib.xxx(...) })`。注意 `list(fullDetail:true)`、`app({ratings:true})` 在库内部会发 2 个以上 HTTP 请求，令牌桶按「库调用」计数，因此 rps 需保守（默认 3）。

### 4.3 库调用参数

| 方法 | 库调用 | 说明 |
|---|---|---|
| `list` | `lib.list({ collection: 'topfreeapplications' \| 'newfreeapplications', category: 6015, num, country, lang, fullDetail: false, requestOptions })` | `top_free → TOP_FREE_IOS`，`new_free → NEW_FREE_IOS`；num 上限 200；返回 `ListApp[]` |
| `search` | `lib.search({ term, num, page: 1, country, lang, requestOptions })` | 返回完整 `App[]`（库特性），仍只映射为 `NormalizedSearchItem`，完整对象放 `raw` |
| `details` | 对每个 id：`lib.app({ id: Number(storeAppId), country, lang, ratings: true, requestOptions })` | 经 limiter 逐个调用；逐项 ok/error；`storeAppId` 非纯数字 → 该项 `invalid_input` |
| `developerApps` | `lib.developer({ devId: Number(developerId), country, lang, requestOptions })` | |
| `similar` | `lib.similar({ id: Number(storeAppId), country, lang, requestOptions })` | |
| `reviews` | `lib.reviews({ id, country, lang, page: 1..k, sort: 'mostRecent', requestOptions })` | 每页 ≤ 50；`num` 默认 50 → 1 页；num=100 → 2 页；page 上限 10 |
| `extras` | 并行 `lib.privacy({ id, country, requestOptions })` 与 `lib.versionHistory({ id, country, requestOptions })` | `permissions`、`dataSafety` 恒为 null |

`requestOptions` 每次构造：`{ timeout, retries, retryDelay, fetch: resolveFetch('ios', country) }`。

### 4.4 错误映射（`ios/errors.ts`）

库只抛 `Error(message)`，映射按顺序匹配：

| 条件（对 `error.message`，大小写不敏感） | kind | retryable |
|---|---|---|
| `/not found/` 或 `/\(404\)/` 或 `/status 404/` | `not_found` | false |
| `/status 429/` | `rate_limited` | true |
| `/status 403/` 或 `/status 401/` | `blocked` | false |
| `/status 5\d\d/`、`/aborted/`、`/timeout/`、`/fetch failed/`、`/ECONN/`、`/ENOTFOUND/`、`error.name === 'AbortError'` | `network` | true |
| `/is required/`、`/must be between/`、`/Could not resolve app id/` | `invalid_input` | false |
| 适配层 zod 校验失败（`ios/schemas.ts`） | `spec_drift` | false |
| 其它 | `unknown` | false |

`ScraperError.status` 从消息中的 `status (\d{3})` 提取（有则填）。

### 4.5 spec_drift 检测（`ios/schemas.ts`）

由于库无类型化解析错误，适配层对每类返回做**最小必需字段**校验（`z.object({...}).passthrough()`）：

- `App`：`id:number, appId:string, title:string, description:string, primaryGenreId:string, version:string, updated:string, developer:string, developerId:number, score:number, reviews:number, price:number, free:boolean`。
- `ListApp`：`id:number, appId:string, title:string`。
- `Review`：`id:string, score:number, updated:string`。
- `PrivacyDetails`：`z.object({}).passthrough()`（任意对象即可）；`VersionHistory[]`：每项 `versionDisplay:string, releaseDate:string`。

校验失败 → `ScraperError(kind='spec_drift')`，`cause` 为 zod issues，日志 error 级并附前 3 个 issue path。

### 4.6 iOS → Normalized 字段映射（`ios/normalize.ts`）

**命名陷阱**：库的 `App.score` / `App.reviews` 对应 iTunes lookup 的 `averageUserRating` / `userRatingCount`（**全版本**平均分与评分数），`currentVersionScore` / `currentVersionReviews` 才是当前版本。归一化取全版本值。

| NormalizedApp | 来源（iOS `App`） | 规则 |
|---|---|---|
| storeAppId | `id` | `String(id)` |
| bundleId | `appId` | |
| title / description | 同名 | |
| summary | — | null（iOS 无短描述；不要截取 description） |
| developerId / developerName | `developerId` / `developer` | `String(developerId)` |
| developerEmail | — | null |
| developerWebsite | `developerWebsite ?? null` | |
| privacyPolicyUrl | — | null（详情不含；`extras().privacy.privacyPolicyUrl` 可得，E5 决定是否回填） |
| icon / url | 同名 | |
| genre / genreId | `primaryGenre` / `primaryGenreId` | 保持 `"Finance"` / `"6015"`；识别引擎（PRD #5）按 genre 名归一化匹配 |
| contentRating | 同名 | `"4+"` 等 |
| releasedAt / storeUpdatedAt | `released` / `updated` | 库返回 ISO 字符串；`new Date(x).toISOString()` 统一；无效 → null |
| version / releaseNotes | `version` / `releaseNotes` | 空串 → null |
| installsText / minInstalls | — | null |
| score | `score` | |
| ratings | `reviews`（userRatingCount） | 若 `histogram` 存在且各项和 > 0，以 `reviews` 为准、不重算 |
| reviews | — | null（iOS 无文字评价数） |
| histogram | `histogram ?? null` | 键 1–5 数字 |
| price / currency / free | 同名 | |
| size | `size` | 字节字符串 → `Number`；NaN → null |
| minOs | `requiredOsVersion` | |
| adSupported | — | null |
| raw | 整个 `App` | |

`NormalizedRankItem`（来自 `ListApp`）：`storeAppId=String(id)`、`developerName=developer`、`developerId = developerId != null ? String(developerId) : null`、`summary = description ?? null`、`score=null`、`free`、`price`、`icon`、`url`、`rank` 按顺序 1 起。
`NormalizedSearchItem`（来自 `App`）：同上但 `score=app.score`、`summary=null`。
`NormalizedReview`（来自 `Review`）：`storeReviewId=id`、`reviewedAt=updated`（ISO 化）、`thumbsUp=voteSum`、`title`、`text`、`version`、`userName`。
`NormalizedAppExtras`：`privacy` = `PrivacyDetails` 原对象；`versionHistory` = `[{ version: versionDisplay, releasedAt: ISO(releaseDate), releaseNotes: releaseNotes ?? null }]`。

### 4.7 能力差异总表（供 E5/E8 引用）

| 能力 | Google Play | App Store | 归一化表现 |
|---|---|---|---|
| 下载量 | `installs` / `minInstalls` | 无 | iOS `installsText=null, minInstalls=null`；热度以榜单名次 + `ratings` 增速代理（E5/E8） |
| 短描述 | `summary` | 无 | iOS `summary=null` |
| 文字评价数 | `reviews` | 无（只有评分数） | iOS `reviews=null`，`ratings` 有值 |
| 评分直方图 | 详情自带 | `app({ratings:true})` 额外请求 | 两者 `histogram` 有值 |
| 权限 | `permissions()` | 无 | iOS `extras.permissions=null` |
| 数据安全 | `dataSafety()` | 无 | iOS `extras.dataSafety=null` |
| 隐私标签 | 无 | `privacy()` | GP `extras.privacy=null` |
| 版本历史 | 无（仅 recentChanges） | `versionHistory()` | GP `extras.versionHistory=null` |
| 开发者邮箱 | 有 | 无 | iOS null |
| 应用大小 | 无 | 有 | GP null |
| 广告标识 | `adSupported` | 无 | iOS null |
| 新上架榜 | 无 | `NEW_FREE_IOS` | GP `list(new_free)` 抛 invalid_input |
| 分类 ID | `"FINANCE"` | `"6015"` | 保持原值；`genre` 名两者均为 `Finance` |

## 5. 验收标准（AC）

离线 AC（AC-1～AC-14）随 `npm test` 运行；AC-15～AC-17 仅 `RUN_NETWORK_TESTS=1`。

- **AC-1 fixtures 真实性**：`apps/server/test/fixtures/ios/` 至少含 `list-th-finance-top_free.json`（`fullDetail:false` 的 `ListApp[]`）、`list-th-finance-new_free.json`、`search-th-loan.json`、`app-th-<id>.json`（≥2 个应用，含 `histogram`，其中 ≥1 为贷款应用）、`developer-th.json`、`similar-th.json`、`reviews-th.json`（≥10 条）、`privacy-th.json`、`versionhistory-th.json`；均为库真实返回；`README.md` 记录日期、命令、库版本。
- **AC-2 list 两个集合**：`top_free` 与 `new_free` 分别调用库时 `collection` 参数为 `topfreeapplications` / `newfreeapplications`，`category===6015`，`fullDetail===false`；返回 `rank` 1..n 连续，`store='ios'`，`storeAppId` 全为数字字符串。
- **AC-3 details 归一化**：贷款应用 fixture → `status:'ok'`；断言：`storeAppId===String(fixture.id)`、`bundleId===fixture.appId`、`summary===null`、`installsText===null`、`minInstalls===null`、`reviews===null`、`developerEmail===null`、`adSupported===null`、`ratings===fixture.reviews`、`score===fixture.score`、`histogram` 键 1–5、`size===Number(fixture.size)`、`genreId==='6015'`、`releasedAt`/`storeUpdatedAt` 匹配 `/Z$/`、`raw` 深等于 fixture、对象无 `undefined` 值。
- **AC-4 details 逐项容错与校验**：假库对第 2 个 id 抛 `Error('App not found (404)')` → 第 2 项 `error.kind==='not_found'`，第 1、3 项 ok；输入 `'abc'` → 该项 `invalid_input` 且不调用库；输入重复 id 只调用一次。
- **AC-5 spec_drift**：假库返回缺少 `primaryGenreId` 的对象 → `details` 该项 `error.kind==='spec_drift'`，且 `cause` 含 zod issues；`list` 返回缺 `id` 的条目 → 抛 `spec_drift`。
- **AC-6 错误映射**：分别让假库抛 `'App not found: 1'`、`'Request failed with status 429'`、`'Request failed with status 403'`、`'Request failed with status 503'`、`'The operation was aborted'`、`TypeError('fetch failed')`、`'term is required'`、`'Page must be between 1 and 10'` → kind 依次 `not_found / rate_limited / blocked / network / network / network / invalid_input / invalid_input`；`status` 分别为 `undefined/429/403/503/...`。
- **AC-7 令牌桶**：`createTokenBucket({rps:3, burst:3})` 配假时钟：连续 `take()` 前 3 次立即返回，第 4 次等待 ≈ 333 ms（±10%）；1 秒内最多放行 3 + 3（burst 与补充）；10 次 `take()` 总耗时 ≥ 2.3 s（真实计时器版本可放在同一测试文件用 `vi.useRealTimers` 跑一次，阈值宽松到 ≥ 2 s）。
- **AC-8 并发限制**：`concurrency:2`，同时发起 5 个 `details` 单项调用，假库记录的最大同时在飞数 === 2。
- **AC-9 外层重试**：假库前两次抛 `'Request failed with status 429'` 第三次成功 → `search` 成功、库调用 3 次、sleep 两次；抛 `'status 403'` → 调用 1 次即抛 `blocked`。
- **AC-10 requestOptions 与 fetch 钩子**：每次库调用的 `requestOptions` 深等于 `{ timeout:15000, retries:3, retryDelay:500, fetch: <resolveFetch('ios',country)> }`；`registerCountryFetch('ios','th', stub)` 后对 `th` 的调用 `requestOptions.fetch===stub`，对 `mx` 为 `globalThis.fetch`。
- **AC-11 reviews 分页**：`num=50` → 库调用 1 次 `page:1`；`num=100` → 2 次 `page:1,2`；`sort==='mostRecent'`；返回 `storeReviewId` 唯一、`reviewedAt` ISO、`thumbsUp===voteSum`。
- **AC-12 extras**：`privacy` 深等于 fixture；`versionHistory` 每项 `{version, releasedAt(ISO), releaseNotes}`；`permissions===null && dataSafety===null`；`versionHistory` 抛错而 `privacy` 成功 → `versionHistory:null` + warn，不抛；两者都失败 → 抛 `ScraperError`。
- **AC-13 capabilities 与工厂**：`adapter.store==='ios'`；`capabilities` 等于 §4.1 固定值；`getAdapter('ios')` 返回 iOS 适配器，`getAdapter('gp')` 返回 GP 适配器（E2 未合并时可暂抛 `not implemented`，合并后补测）。
- **AC-14 禁止直连**：`grep -rn "@perttu/app-store-scraper" apps/server/src --include=*.ts` 命中仅在 `apps/server/src/scrapers/ios/`。
- **AC-15 网络-榜单**（`RUN_NETWORK_TESTS=1`）：`list(th, top_free, finance, 20)` 与 `list(th, new_free, finance, 20)` 各返回 10–20 条，`storeAppId` 全为数字串；`th` 的 `lang` 使用 `countries.yaml` 的 `ios_lang`（`th`），若库对 2 字母 lang 报错则改用 `th-th` 并在 PR 记录（见 §7 Q1）。
- **AC-16 网络-搜索+详情+附加**：`search(th,'loan',10)` ≥ 1 条；前 3 个 `details` ≥ 2 项 ok，每项 `title / description / genreId / version / storeUpdatedAt / ratings / histogram` 非 null；对第 1 个 ok 项 `extras()` 的 `privacy` 非 null、`versionHistory` 长度 ≥ 1；`reviews(num=10)` 返回 ≥ 1 条。
- **AC-17 网络-预算**：AC-15 + AC-16 合计库调用 ≤ 20 次、总耗时 < 90 s、全程无 `rate_limited`（若出现，测试标记为 skipped 并打印，不算失败——Apple 共享出口 IP 常见 429）。
- **AC-18 质量门**：`npm run lint && npm run typecheck && npm test` 通过；`npm run test:network` 结果贴 PR。

## 6. 非功能要求

- **限流**：全局 3 rps（`IOS_THROTTLE_RPS`）、并发 2；6 国串行或并行时总速率不超过桶速率（桶是全局的）。
- **超时/重试**：库层 `timeout 15000, retries 3, retryDelay 500`（指数、尊重 `Retry-After`）；外层 `withRetry` 与 GP 一致。
- **容错**：单项失败不影响批量；`blocked` 立即上抛。
- **日志**：子 logger `{ module:'scrapers/ios', country }`；debug = 每次库调用与耗时；warn = 重试、单项失败、extras 部分失败；error = `blocked`、`spec_drift`（附 issue path）。
- **纯函数**：`normalize.ts`、`errors.ts` 无 I/O。
- **版本锁定**：`@perttu/app-store-scraper` 固定 `2.1.0`。
- **无 undefined 泄漏**：同 PRD #3。

## 7. 风险与开放问题

| # | 类型 | 内容 | 建议 |
|---|---|---|---|
| Q1 | 开放 | 库 `lang` 示例为 `en-us` 形式，`countries.yaml` 的 `ios_lang` 为 2 字母（`th/es/en/id`）。2 字母是否被 iTunes 接受需网络测试确认。 | CTO 在 AC-15 验证；若不接受，在 `ios/client.ts` 做 `th→th-th, es→es-mx/es-ar(按国家), en→en-us, id→id-id` 映射，并把映射表写进 PR 与 `DATA_MODEL.md` 备注，不改 YAML 语义。 |
| Q2 | 风险 | Apple 429 与共享 IP：CI 上网络测试不稳定。 | 网络测试默认关闭；429 时 skip 而非 fail（AC-17）。 |
| Q3 | 风险 | 无类型化错误，靠消息正则映射，库升级可能改文案。 | 版本锁定；错误映射有单测（AC-6）；`unknown` 兜底并记录原消息。 |
| Q4 | 假设 | `ratings` 取全版本 `userRatingCount`，不取当前版本。 | 与 GP `ratings` 语义一致；当前版本值保留在 `raw`。 |
| Q5 | 假设 | `search` 返回完整 `App` 但只映射为轻量 `NormalizedSearchItem`，详情统一走 `details()`（会重复请求）。 | 保持契约一致；E5 可用 `raw` 做优化（可选）。 |
| Q6 | 假设 | `list` 使用 `fullDetail:false`（单请求）以节省配额；`ListApp` 缺 `score`，榜单条目 `score=null`。 | 已采纳。 |
| Q7 | 开放 | `privacyPolicyUrl` 是否由 `extras().privacy.privacyPolicyUrl` 回填到 `apps.privacy_policy_url`？ | 由 E5 决定；本层保持 `details().privacyPolicyUrl=null`。 |
| Q8 | 风险 | `reviews` 的 RSS feed 只有最多 10 页 × 50 条，且不同国家 feed 独立。 | 契约 num 默认 50，管道每 6h 拉一次足够。 |
