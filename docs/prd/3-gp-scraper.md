# PRD #3 — E2 Google Play 采集适配层

| 项 | 值 |
|---|---|
| Issue | [#3 E2 Google Play 采集适配层](https://github.com/zequnjiang/AppeyeCC/issues/3) |
| 类型 / 优先级 | Epic（作为单个可交付需求）/ P0 |
| 领域 | `area:scraper` |
| 依赖 | E1（#2）：`NormalizedApp` 字段口径与 `apps/app_snapshots` 列对应；`countries` 表提供 `gp_lang` |
| 并行 | E3（#4）App Store 适配层。**本 PRD §4.1–§4.4 的统一契约（类型、错误、fetch 钩子）为 E2/E3 共同遵守的权威定义**，先合并的 PR 落地共用文件，后者 rebase。 |
| 口径来源 | CEO 批准方案第 3 节「采集与识别管道」；`@mradex77/google-play-scraper@1.1.0` 的 `dist/index.d.ts` 与 README |

## 1. 背景与目标

管道（E5）每小时要对 6 个国家做「榜单 → 搜索 → 扩展（developer/similar）→ 批量详情 → 附加（permissions/dataSafety）→ 评价」的抓取。CLAUDE.md 约定 **业务代码禁止直接调用第三方库**，所有抓取必须经过 `apps/server/src/scrapers/` 的封装层，以统一节流、错误映射与返回结构。

目标：

1. 提供 `GpAdapter`（实现统一 `StoreAdapter` 接口），把 Google Play 的返回归一化为与 App Store 相同的 `NormalizedApp / NormalizedReview / NormalizedRankItem / NormalizedSearchItem`。
2. 每国一个 `createClient({country, lang, throttle})`，共享限流；外层增加带抖动的重试与统一错误分类（`not_found / rate_limited / blocked / spec_drift / network`）。
3. 预留按国家注入 `fetch` 的代理钩子（`scrapers/fetch.ts`）。
4. 用真实 JSON fixtures 做离线单测；`RUN_NETWORK_TESTS=1` 时跑受限的真实抓取测试。

## 2. 用户故事

- 作为 **管道开发者（E5）**，我希望调用 `adapter.details(...)` 时不用关心是 GP 还是 iOS，返回的都是同一个 `NormalizedApp`，以便 diff/落库逻辑只写一遍。
- 作为 **运维**，我希望被 Google 限流或改版时日志里能明确看到 `rate_limited` / `spec_drift`，以便判断是等一等还是升级库。
- 作为 **测试工程师**，我希望不联网也能跑完整个适配层的单测，以便 CI 稳定。
- 作为 **CTO**，我希望以后加代理只改 `fetch.ts` 一个文件，以便不动业务代码。

## 3. 功能范围与非目标

### 3.1 范围

文件（新建）：

| 路径 | 内容 |
|---|---|
| `apps/server/src/scrapers/types.ts` | 统一契约：`StoreAdapter`、`Normalized*` 类型、各方法参数类型（§4.1、§4.2；**E2/E3 共用**） |
| `apps/server/src/scrapers/errors.ts` | `ScraperError` 与 `ScraperErrorKind`（§4.3；共用） |
| `apps/server/src/scrapers/fetch.ts` | `resolveFetch(country, store)` / `registerCountryFetch(...)`（§4.4；共用） |
| `apps/server/src/scrapers/retry.ts` | 外层重试 + 抖动 `withRetry(fn, policy)`（共用） |
| `apps/server/src/scrapers/gp/client.ts` | 每国 client 缓存 `getGpClient(country, lang)` |
| `apps/server/src/scrapers/gp/adapter.ts` | `createGpAdapter(deps?)` 返回 `StoreAdapter` |
| `apps/server/src/scrapers/gp/normalize.ts` | GP `App / AppItem / Review / AppPermission / DataSafety` → `Normalized*` 纯函数 |
| `apps/server/src/scrapers/gp/errors.ts` | GP 库错误 → `ScraperError` 映射 |
| `apps/server/src/scrapers/index.ts` | `getAdapter(store: Store): StoreAdapter` 工厂（E3 合并后补 ios 分支） |
| `apps/server/test/fixtures/gp/**` | 真实抓取 JSON fixtures + `README.md`（记录时间、国家、命令） |
| `apps/server/test/scrapers/gp/*.test.ts` | 离线单测 |
| `apps/server/test/network/gp.network.test.ts` | `RUN_NETWORK_TESTS=1` 真实测试 |

覆盖的库能力：`list(FINANCE, TOP_FREE)`、`search`、`apps`（批量详情）、`developer`、`similar`、`reviews`（NEWEST）、`permissions`、`dataSafety`。

### 3.2 非目标

- 不做候选池去重、增量策略、快照 diff、落库（E5）。
- 不做 cron / 互斥锁 / crawl_runs 记录（E6）；本层只抛出结构化错误，由调用方记录。
- 不接入真实代理，只留钩子（方案「无代理」）。
- 不封装 `availability`、`suggest`、`categories`、`memoized`（当前管道不需要）。
- 不做 iOS（E3）。

## 4. 接口定义（E2/E3 共用契约）

### 4.1 归一化类型（`scrapers/types.ts`）

```ts
import type { Store } from '@appeye/shared';

/** 商店无法提供的字段一律为 null（不是 undefined、不是空串、不是 0） */
export interface NormalizedApp {
  store: Store;
  storeAppId: string;          // gp: packageName；ios: trackId 字符串
  bundleId: string | null;     // gp: = storeAppId；ios: bundleId
  title: string;
  summary: string | null;      // gp 短描述；ios 无 → null
  description: string;         // 纯文本（gp 用 description 而非 descriptionHTML）
  developerId: string | null;
  developerName: string | null;
  developerEmail: string | null;     // ios 无 → null
  developerWebsite: string | null;
  privacyPolicyUrl: string | null;   // gp: privacyPolicy；ios 详情无 → null（extras.privacy 可得）
  icon: string | null;
  genre: string | null;              // 分类名（"Finance"）
  genreId: string | null;            // 商店原值：gp "FINANCE" / ios "6015"
  contentRating: string | null;
  releasedAt: string | null;         // ISO-8601 UTC；无法解析 → null
  storeUpdatedAt: string | null;     // ISO-8601 UTC
  version: string | null;
  releaseNotes: string | null;       // gp recentChanges / ios releaseNotes
  installsText: string | null;       // gp "1,000,000+"；ios null
  minInstalls: number | null;        // gp；ios null
  score: number | null;              // 平均分 0–5
  ratings: number | null;            // 评分数
  reviews: number | null;            // 文字评价数；ios 详情不提供 → null
  histogram: { 1: number; 2: number; 3: number; 4: number; 5: number } | null;
  price: number | null;
  currency: string | null;
  free: boolean | null;
  size: number | null;               // 字节；gp 无 → null
  minOs: string | null;              // gp androidVersion / ios requiredOsVersion
  adSupported: boolean | null;       // ios 无 → null
  url: string | null;
  raw: unknown;                      // 库返回的原对象（落 raw_json）
}

export interface NormalizedAppRef {   // 榜单/搜索/扩展的轻量条目共用
  store: Store;
  storeAppId: string;
  title: string;
  developerName: string | null;
  developerId: string | null;
  icon: string | null;
  url: string | null;
  score: number | null;
  free: boolean | null;
  price: number | null;
  summary: string | null;
  raw: unknown;
}

export interface NormalizedRankItem extends NormalizedAppRef {
  country: string;
  collection: 'top_free' | 'new_free';
  category: 'finance';
  rank: number;                       // 1 起，按返回顺序
}

export type NormalizedSearchItem = NormalizedAppRef;

export interface NormalizedReview {
  store: Store;
  storeAppId: string;
  storeReviewId: string;
  userName: string | null;
  score: number | null;
  title: string | null;
  text: string | null;
  version: string | null;
  reviewedAt: string | null;          // ISO-8601 UTC
  thumbsUp: number | null;            // gp thumbsUp / ios voteSum
  raw: unknown;
}

export interface NormalizedPermission { name: string; type: 'common' | 'other'; }

export interface NormalizedAppExtras {
  store: Store;
  storeAppId: string;
  permissions: NormalizedPermission[] | null;   // gp；ios null
  dataSafety: unknown | null;                   // gp DataSafety 原结构；ios null
  privacy: unknown | null;                      // ios PrivacyDetails 原结构；gp null
  versionHistory: { version: string; releasedAt: string | null; releaseNotes: string | null }[] | null; // ios；gp null
}

/** 批量详情逐项结果（一个失败不影响其它） */
export type DetailsResult =
  | { storeAppId: string; status: 'ok'; app: NormalizedApp }
  | { storeAppId: string; status: 'error'; error: ScraperError };
```

### 4.2 适配器接口

```ts
export interface AdapterCapabilities {
  installs: boolean;        // gp true / ios false
  permissions: boolean;     // gp true / ios false
  dataSafety: boolean;      // gp true / ios false
  privacy: boolean;         // gp false / ios true
  versionHistory: boolean;  // gp false / ios true
  newFreeCollection: boolean; // gp false / ios true
  reviewsCount: boolean;    // gp true / ios false
}

export interface CountryScope { country: string; lang: string; }   // lang 来自 countries.gp_lang / ios_lang

export interface StoreAdapter {
  readonly store: Store;
  readonly capabilities: AdapterCapabilities;

  /** 榜单。num 上限 200；不支持的 collection 抛 ScraperError(kind='invalid_input') */
  list(scope: CountryScope, opts: { collection: 'top_free' | 'new_free'; category: 'finance'; num?: number }): Promise<NormalizedRankItem[]>;

  /** 关键词搜索。gp 实际上限约 30 条；返回条数可少于 num */
  search(scope: CountryScope, opts: { term: string; num?: number }): Promise<NormalizedSearchItem[]>;

  /** 批量详情。保持输入顺序；去重输入；逐项 ok/error */
  details(scope: CountryScope, opts: { storeAppIds: string[]; concurrency?: number }): Promise<DetailsResult[]>;

  /** 同一开发者的应用 */
  developerApps(scope: CountryScope, opts: { developerId: string; num?: number }): Promise<NormalizedSearchItem[]>;

  /** 相似应用 */
  similar(scope: CountryScope, opts: { storeAppId: string }): Promise<NormalizedSearchItem[]>;

  /** 最新评价，默认 num=50，按时间倒序 */
  reviews(scope: CountryScope, opts: { storeAppId: string; num?: number }): Promise<NormalizedReview[]>;

  /** 附加信息（gp: permissions+dataSafety；ios: privacy+versionHistory）。单项失败不抛，置 null 并写 warn 日志；全部失败才抛 */
  extras(scope: CountryScope, opts: { storeAppId: string }): Promise<NormalizedAppExtras>;
}
```

GP 工厂签名（便于测试注入假 client）：

```ts
export interface GpAdapterDeps {
  clientFactory?: (scope: CountryScope) => GooglePlayClientLike;   // 默认 getGpClient
  throttleRps?: number;                                             // 默认 config.gpThrottleRps
  retry?: Partial<RetryPolicy>;
  logger?: Logger;
}
export function createGpAdapter(deps?: GpAdapterDeps): StoreAdapter;
```

`GooglePlayClientLike` 为 `Pick<GooglePlayClient, 'list'|'search'|'apps'|'app'|'developer'|'similar'|'reviews'|'permissions'|'dataSafety'>`。

### 4.3 错误分类（`scrapers/errors.ts`）

```ts
export type ScraperErrorKind =
  | 'not_found'      // 应用/开发者不存在或已下架（→ E5 下架候选）
  | 'rate_limited'   // 429 且重试耗尽（→ 指数退避，写 crawl_runs.errors_json）
  | 'blocked'        // 同意墙/验证码/403（→ 告警，本轮停止该国该商店）
  | 'spec_drift'     // 商店改版导致解析失败（→ 告警级日志，需要升级库）
  | 'network'        // 超时、DNS、5xx 重试耗尽、连接重置
  | 'invalid_input'  // 调用方参数错误（不重试）
  | 'unknown';       // 兜底

export class ScraperError extends Error {
  readonly kind: ScraperErrorKind;
  readonly store: Store;
  readonly op: 'list' | 'search' | 'details' | 'developerApps' | 'similar' | 'reviews' | 'extras';
  readonly country: string;
  readonly retryable: boolean;      // rate_limited / network 为 true，其余 false
  readonly status?: number;         // HTTP 状态（有则填）
  readonly storeAppId?: string;
  readonly cause?: unknown;         // 原始错误
  toJSON(): { kind; store; op; country; status; storeAppId; message };   // 供 errors_json
}
```

GP 库错误映射（`gp/errors.ts`）：

| 库错误（`instanceof`） | kind |
|---|---|
| `NotFoundError` | `not_found` |
| `RateLimitError` | `rate_limited` |
| `BlockedError` | `blocked` |
| `SpecError`、`ParseError` | `spec_drift` |
| 其它 `HttpError`（status ≥ 500 或 network） | `network` |
| `ValidationError` | `invalid_input` |
| `AbortError` / `TypeError: fetch failed` / `ECONNRESET` 等非库错误 | `network` |
| 其它 | `unknown` |

### 4.4 fetch 注入钩子（`scrapers/fetch.ts`）

```ts
export type FetchLike = typeof fetch;
export function registerCountryFetch(store: Store | '*', country: string | '*', impl: FetchLike): void;
export function resolveFetch(store: Store, country: string): FetchLike;   // 优先级：(store,country) > (store,'*') > ('*',country) > ('*','*') > globalThis.fetch
export function resetCountryFetch(): void;   // 测试用
```

GP client 创建时把 `resolveFetch('gp', country)` 传入 `requestOptions.fetchImpl`。当前不读任何代理环境变量（见 §7 Q2）。

### 4.5 GP client 与限流/重试

- `getGpClient(country, lang)`：按 `${country}:${lang}` 缓存 `createClient({ country, lang, throttle: throttleRps, requestOptions: { retries: 2, timeoutMs: 15000, fetchImpl, onRetry, onResponse } })`。`onRetry` 写 warn 日志（url、attempt、delayMs、reason），`onResponse` 写 debug 日志（status、durationMs）。
- `throttleRps` 默认 `config.gpThrottleRps`（env `GP_THROTTLE_RPS`，默认 4）。
- 外层 `withRetry`（`scrapers/retry.ts`）：仅对 `retryable=true` 的 `ScraperError` 重试；策略 `{ maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 20000, jitterRatio: 0.5 }`，延迟 = `min(max, base * 2^(attempt-1)) * (1 ± jitterRatio·random)`；`sleep` 可注入以便测试用假计时器。`blocked` / `not_found` / `spec_drift` / `invalid_input` **不重试**。
- `details()` 使用 `client.apps({ appIds, concurrency })`，`concurrency` 默认 3；库返回 `AppsEntry[]`（fulfilled/rejected）逐项映射为 `DetailsResult`。输入去重并保持首次出现顺序。
- `list()`：`client.list({ collection: 'TOP_FREE', category: 'FINANCE', num, fullDetail: false })`；`new_free` 抛 `invalid_input`（GP 库无此集合）。
- `search()`：`client.search({ term, num, fullDetail: false })`；`developerApps()`：`client.developer({ devId, num, fullDetail: false })`；`similar()`：`client.similar({ appId, fullDetail: false })`；`reviews()`：`client.reviews({ appId, sort: 2 /* NEWEST */, num })`。
- `extras()`：并行 `permissions({ appId, short: false })` 与 `dataSafety({ appId })`；`privacy`、`versionHistory` 恒为 null。

### 4.6 GP → Normalized 字段映射（`gp/normalize.ts`）

| NormalizedApp | 来源（GP `App`） | 规则 |
|---|---|---|
| storeAppId / bundleId | `appId` | 两者相同 |
| title / description / summary | `title` / `description` / `summary ?? null` | |
| developerId / developerName | `developerId` / `developer` | |
| developerEmail / developerWebsite / privacyPolicyUrl | `developerEmail` / `developerWebsite` / `privacyPolicy` | 缺省 → null |
| icon / url | `icon` / `url` | |
| genre / genreId / contentRating | `genre` / `genreId` / `contentRating` | 保持原值 |
| releasedAt | `released` | 本地化字符串；先尝试 `Date.parse`，失败尝试英文月份格式 `MMM d, yyyy`；仍失败 → null |
| storeUpdatedAt | `updated`（epoch ms） | `new Date(updated).toISOString()` |
| version / releaseNotes | `version` / `recentChanges` | |
| installsText / minInstalls | `installs` / `minInstalls` | |
| score / ratings / reviews / histogram | 同名 | `histogram` 键为 `'1'..'5'`，转数字键 |
| price / currency / free | 同名 | |
| size | — | null（GP 不提供） |
| minOs | `androidVersion` | 如 `"7.0"`；`"VARY"` 保留原字符串 |
| adSupported | `adSupported` | |
| raw | 整个 `App` | |

`NormalizedAppRef`（来自 `AppItem`）：`storeAppId=appId`、`developerName=developer`、`developerId ?? null`、`summary ?? null`、`score ?? null`、`free`、`price`、`icon`、`url`、`raw`。
`NormalizedReview`（来自 `Review`）：`storeReviewId=id`、`reviewedAt=date`、`thumbsUp ?? null`、`title ?? null`、`text ?? null`、`version ?? null`、`userName`。
`NormalizedPermission`：`type 0 → 'common'`，`1 → 'other'`。

## 5. 验收标准（AC）

离线 AC（AC-1～AC-14）在 `npm test` 中运行，不联网；AC-15～AC-17 仅在 `RUN_NETWORK_TESTS=1` 下运行。

- **AC-1 契约文件**：`scrapers/types.ts` 导出 §4.1–§4.2 全部类型且字段名、可空性与本 PRD 一致（typecheck 通过；Alex 逐字段核对）；`scrapers/errors.ts` 导出 `ScraperError` 与 7 个 `ScraperErrorKind`。
- **AC-2 fixtures 真实性**：`apps/server/test/fixtures/gp/` 至少包含：`list-th-finance-top_free.json`、`search-th-loan.json`、`app-th-<pkg>.json`（≥2 个不同应用，其中至少 1 个为贷款应用）、`developer-th.json`、`similar-th.json`、`reviews-th.json`（≥10 条）、`permissions-th.json`、`datasafety-th.json`；每个文件为库实际返回的 JSON；`fixtures/gp/README.md` 记录抓取日期、命令与库版本。任何 fixture 不得手工编造（Alex 抽样 2 个与线上核对标题/开发者一致即可）。
- **AC-3 list 归一化**：以 `list` fixture 喂入假 client，`adapter.list({country:'th',lang:'th'},{collection:'top_free',category:'finance',num:50})` 返回长度 = fixture 条数，`rank` 从 1 连续递增，每项 `store='gp'`、`country='th'`、`collection='top_free'`、`category='finance'`、`storeAppId` 非空；`collection:'new_free'` 抛 `ScraperError(kind='invalid_input')` 且不调用 client。
- **AC-4 search 归一化**：返回 `NormalizedSearchItem[]`，`storeAppId`、`title` 非空；缺失字段（如无 `summary`）为 `null` 而非 `undefined`（用 `Object.values(item).includes(undefined)` 断言为 false）。
- **AC-5 details 归一化**：对贷款应用 fixture，`details` 返回 `status:'ok'` 且 `app` 满足：`storeAppId===bundleId`；`storeUpdatedAt` 匹配 `/^\d{4}-\d{2}-\d{2}T/`；`histogram` 键为数字 1–5 且值为整数；`size===null`；`installsText` 与 `minInstalls` 与 fixture 一致；`raw` 深等于 fixture；对象中无任何 `undefined` 值。
- **AC-6 details 逐项容错**：假 client 的 `apps` 返回 `[fulfilled, rejected(NotFoundError)]`，`details` 返回两项：第一项 `ok`，第二项 `error.kind==='not_found'`，且不抛异常；输入 `['a','b','a']` 只请求 `['a','b']` 且输出顺序为 a、b。
- **AC-7 错误映射**：分别让假 client 抛 `NotFoundError / RateLimitError / BlockedError / SpecError / HttpError(503) / ValidationError / TypeError('fetch failed')`，`adapter.search` 抛出的 `ScraperError.kind` 依次为 `not_found / rate_limited / blocked / spec_drift / network / invalid_input / network`；`retryable` 仅前述 `rate_limited`、`network` 为 true；`toJSON()` 含 `kind/store/op/country/message`。
- **AC-8 外层重试与抖动**：注入假 `sleep`，假 client 前两次抛 `RateLimitError` 第三次成功：`search` 最终成功，client 被调用 3 次，两次 sleep 的延迟分别落在 `[1000,3000]` 与 `[2000,6000]` ms（base 2000、jitter 0.5）；连续 3 次 `RateLimitError` 则最终抛 `rate_limited`；抛 `BlockedError` 时 client 只被调用 1 次。
- **AC-9 每国 client 复用**：`getGpClient('th','th')` 连续两次返回同一实例；`getGpClient('mx','es')` 返回不同实例；创建参数含 `throttle === config.gpThrottleRps`、`requestOptions.retries === 2`、`timeoutMs === 15000`（通过注入的 `createClient` spy 断言）。
- **AC-10 fetch 钩子**：`registerCountryFetch('gp','th', stubFetch)` 后创建 `th` client，其 `requestOptions.fetchImpl === stubFetch`；`resolveFetch('gp','mx')` 在未注册时返回 `globalThis.fetch`；`resolveFetch` 优先级按 §4.4 顺序（注册 `('*','*')` 与 `('gp','th')` 后，`('gp','th')` 命中后者，`('ios','th')` 命中前者）。
- **AC-11 reviews 归一化**：返回条数 = fixture 条数（≤ num），`storeReviewId` 唯一，`reviewedAt` 为 ISO，`thumbsUp` 为数字或 null，调用参数 `sort===2`。
- **AC-12 extras**：permissions fixture 映射为 `{name,type}`，`type ∈ {'common','other'}`；`dataSafety` 深等于 fixture；`privacy===null && versionHistory===null`；当 `dataSafety` 抛 `SpecError` 而 `permissions` 成功时，返回 `dataSafety:null` 并记录 warn，不抛错；两者都失败时抛 `ScraperError`。
- **AC-13 capabilities**：`adapter.store==='gp'`；`capabilities` 等于 `{installs:true, permissions:true, dataSafety:true, privacy:false, versionHistory:false, newFreeCollection:false, reviewsCount:true}`。
- **AC-14 禁止直连**：`grep -rn "@mradex77/google-play-scraper" apps/server/src --include=*.ts` 的命中仅位于 `apps/server/src/scrapers/gp/` 目录（ESLint `no-restricted-imports` 规则配置亦可，任选其一，但 grep 结果必须满足）。
- **AC-15 网络-榜单**（`RUN_NETWORK_TESTS=1`）：`list(th, top_free, finance, num=20)` 返回 10–20 条，每条 `storeAppId` 形如 `/^[a-zA-Z][\w.]+$/`。
- **AC-16 网络-搜索+详情**：`search(th, 'loan', num=10)` 返回 ≥ 1 条；取前 3 个 `storeAppId` 调 `details`，≥ 2 项 `ok`；每个 ok 项 `title`、`description`、`genreId`、`storeUpdatedAt`、`minInstalls` 非 null。
- **AC-17 网络-预算与耗时**：AC-15 + AC-16 + 对 1 个应用 `reviews(num=10)` + `extras` 合计 HTTP 请求 ≤ 40 次（通过 `onResponse` 计数），总耗时 < 90 s；测试文件顶部 `describe.skipIf(!process.env.RUN_NETWORK_TESTS)`，默认 `npm test` 不执行。
- **AC-18 质量门**：`npm run lint && npm run typecheck && npm test` 通过；`npm run test:network` 通过（CTO 在 PR「手动验证记录」贴输出）。

## 6. 非功能要求

- **限流**：每国 client 共享 `throttle`（默认 4 rps）；全局 6 国并行时总请求速率 ≤ 6×4 rps（管道层可再降）。
- **超时**：单请求 15 s；`details` 批量 100 个应用在 concurrency 3 下 < 3 min（网络正常时）。
- **容错**：任何单个应用失败不影响批量；`blocked` 立即上抛让调用方停止该国本轮。
- **日志**（pino，子 logger `{ module: 'scrapers/gp', country }`）：debug = 每次请求 status/durationMs；warn = 重试、单项失败、extras 部分失败；error = `blocked` / `spec_drift`（含 `SpecError.failures` 摘要）。
- **纯函数**：`normalize.ts` 无 I/O、无副作用，可单独单测。
- **版本锁定**：`@mradex77/google-play-scraper` 固定 `1.1.0`（已锁），升级需走独立 PR 并重录 fixtures。
- **无 undefined 泄漏**：所有 `Normalized*` 对象经 `JSON.parse(JSON.stringify())` 前后深等（即无 undefined 属性）。

## 7. 风险与开放问题

| # | 类型 | 内容 | 建议 |
|---|---|---|---|
| Q1 | 风险 | E2 与 E3 并行开发，`types.ts / errors.ts / fetch.ts / retry.ts` 为共用文件，两 PR 可能冲突。 | 以本 PRD §4 为唯一口径；CEO 先合并先完成者，后者 rebase；差异必须回到 PRD 修订而不是各改各的。 |
| Q2 | 开放 | 代理钩子是否读取环境变量（如 `SCRAPER_PROXY_TH=http://...`）自动注册？ | 本期不读；E10 部署手册决定。钩子 API 已足够。 |
| Q3 | 风险 | GP `released` 为本地化字符串（泰语/西语月份），`releasedAt` 多数为 null。 | 接受；`raw` 保留原值；后续可用 `lang='en'` 单独补抓一次英文页面（E5 决定）。 |
| Q4 | 风险 | GP 搜索每词 ~30 条上限，`num>30` 无效。 | 契约注明「返回可少于 num」；覆盖靠多关键词 + 榜单 + developer/similar（E5）。 |
| Q5 | 假设 | `list/search/developer/similar` 使用 `fullDetail:false`，详情统一走 `details()`，避免重复请求。 | 已采纳。 |
| Q6 | 假设 | 外层重试默认 3 次（含首次），在库内置 `retries:2` 之上；429 最坏情况约 9 次请求。 | 可通过 `GpAdapterDeps.retry` 调整；E6 记录到 `errors_json`。 |
| Q7 | 风险 | Google 改版导致 `SpecError`；库自带 contract tests 但需要人工升级。 | `spec_drift` 用 error 级日志并在总览页告警（E7/E8）。 |
| Q8 | 假设 | `thumbsUp` 在 GP 为「有用」票数；与 iOS 的 `voteSum` 语义略有差异，统一入 `thumbs_up`。 | 后台展示时按商店标注。 |
