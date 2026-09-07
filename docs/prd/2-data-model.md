# PRD #2 — E1 数据模型与迁移

| 项 | 值 |
|---|---|
| Issue | [#2 E1 数据模型与迁移](https://github.com/zequnjiang/AppeyeCC/issues/2) |
| 类型 / 优先级 | Epic（作为单个可交付需求）/ P0 |
| 领域 | `area:server` |
| 依赖 | E0 工程脚手架（已完成） |
| 被依赖 | E2 / E3 / E4 / E5 / E6 / E7 |
| 口径来源 | CEO 批准方案第 2 节「数据模型」、第 3 节「采集与识别管道」；`config/countries.yaml`；`packages/shared/src/enums.ts` |

## 1. 背景与目标

AppeyeCC 需要在 SQLite 中持久化「国家配置 → 关键词/规则 → 应用主档 → 快照/指标/事件/评价/榜单 → 运行日志」这一整条链路的数据。E1 是所有后续 Epic 的地基：采集层（E2/E3）产出的归一化数据要落到这里，识别引擎（E4）读取规则、写回判定结果，管道（E5）依赖快照/事件表做变更检测，API（E7）与后台（E8/E9）直接查询这些表与视图。

目标：

1. 用 Drizzle ORM 定义全部 11 张核心表与 2 个只读视图，可通过 `npm run db:generate` / `npm run db:migrate` 从零建库。
2. 启动时把 `config/countries.yaml` 的种子（国家、关键词、识别规则）同步进 DB：**新增插入，已存在不覆盖**，保护后台的人工改动。
3. `docs/DATA_MODEL.md` 成为与 schema 严格同步、AI 与人都能直接读懂的字段字典。
4. SQLite 以 WAL 模式运行，支持 API 读与 cron 写并发。

## 2. 用户故事

- 作为 **CTO（采集/管道开发者）**，我希望有一套字段语义明确、类型稳定的表与 TS 类型，以便 E2–E6 无需再讨论「这个字段存哪、什么格式」。
- 作为 **PM / 运营**，我希望能用 `sqlite3` 直接 `select * from v_loan_apps_latest` 看到各国最新的贷款应用，以便不依赖后台也能核对数据。
- 作为 **运维**，我希望新增一个国家只需在 `config/countries.yaml` 追加条目并重启，以便扩展市场不改代码。
- 作为 **后台使用者**，我希望在后台改过的关键词/规则不会在服务重启时被 YAML 覆盖回去，以便放心地在后台调参。
- 作为 **测试工程师 Alex**，我希望每条约束都能用 `sqlite3` 或 vitest 独立验证，以便出具客观的测试报告。

## 3. 功能范围与非目标

### 3.1 范围

- `apps/server/src/db/schema.ts`：11 张表 + 2 个视图的 Drizzle 定义（视图允许用 `sqliteView(...).as(sql\`...\`)` 或在迁移 SQL 中手写 `CREATE VIEW`，二选一，但 `db:migrate` 后必须存在）。
- `apps/server/src/db/index.ts`：打开连接（`better-sqlite3`），设置 PRAGMA（WAL、foreign_keys、busy_timeout），导出 `db` 与 `sqlite` 实例；数据库文件路径来自 `config.databasePath`，父目录不存在时自动创建。
- `apps/server/src/db/migrate.ts`：执行 `apps/server/drizzle/` 下的迁移（`drizzle-orm/better-sqlite3/migrator`）；幂等，重复执行不报错。
- `apps/server/drizzle.config.ts`：drizzle-kit 配置（dialect sqlite，schema 路径，out 目录）。
- `apps/server/src/config/countries.ts`：读取并用 zod 校验 `config/countries.yaml`，导出 `loadCountriesConfig()`。
- `packages/shared/src/config.ts`：`CountriesConfigSchema`（yaml 结构）及推导类型；`packages/shared/src/enums.ts` 补充本 PRD §4.4 列出的枚举。
- `apps/server/src/db/seed.ts`：`syncSeed(db, config)` 同步函数；新增脚本 `npm run db:seed`（根 `package.json` 与 `apps/server/package.json` 各加一条），服务启动（`main.ts`）时也调用。
- `docs/DATA_MODEL.md`：逐表字段字典 + 视图定义 + 种子同步规则 + 约定（时间格式、ID 格式、JSON 列）。
- vitest 测试：`apps/server/test/db/*.test.ts`，使用临时目录中的 SQLite 文件（或 `:memory:` + 手动跑迁移）。

### 3.2 非目标（明确不做）

- 不写任何采集、diff、识别、API 逻辑（分别属于 E2–E7）。E1 只提供表、类型、迁移、种子。
- 不做 `classification_rules` / `keywords` 的后台 CRUD（E7/E9）。
- 不做数据备份/清理策略（E10）。
- 不做 `content_hash` 的计算逻辑（E5），E1 只定义列与语义。
- `loan_threshold` 不入库（见 §7 开放问题 Q1），由 E4 从 YAML 读取。

## 4. 数据定义

### 4.1 全局约定

| 约定 | 规则 |
|---|---|
| 时间戳 | `TEXT`，ISO-8601 UTC，格式 `YYYY-MM-DDTHH:mm:ss.sssZ`（例 `2026-09-07T03:00:00.000Z`）。列名以 `_at` 结尾。 |
| 日期 | `TEXT`，`YYYY-MM-DD`（UTC）。列名 `day`。 |
| 布尔 | `INTEGER`，0/1。Drizzle 用 `integer({ mode: 'boolean' })`。 |
| JSON | `TEXT`，列名以 `_json` 结尾，存 `JSON.stringify` 结果；空值存 `NULL` 而非 `'null'`。 |
| 商店 | `store TEXT`，取值 `gp` / `ios`（`StoreSchema`）。 |
| 国家 | `country TEXT`，ISO 3166-1 alpha-2 **小写**（`th`/`mx`/`ph`/`pk`/`id`/`ar`），外键到 `countries.code`。 |
| 应用 ID | `apps.id = '<store>:<store_app_id>'`：GP 为 `gp:<packageName>`（例 `gp:com.example.loan`），iOS 为 `ios:<trackId>`（例 `ios:1234567890`，数字型 trackId 转为字符串）。 |
| 自增主键 | `id INTEGER PRIMARY KEY AUTOINCREMENT`。 |
| 外键 | 全部声明；连接打开时 `PRAGMA foreign_keys = ON`。删除行为除特别说明外为 `ON DELETE CASCADE`（`apps` 被删时级联删除其快照/事件/指标/评价/榜单/可见性）。 |
| 命名 | 表名复数 snake_case，字段 snake_case；Drizzle 属性名 camelCase。 |
| 默认时间 | `created_at`/`first_seen_at` 等由应用层写入 ISO 字符串，**不用** SQLite `CURRENT_TIMESTAMP`（格式不一致）。 |

### 4.2 表定义

#### 4.2.1 `countries` — 国家配置

| 字段 | 类型 | 约束 | 语义 |
|---|---|---|---|
| code | TEXT | PK | ISO alpha-2 小写 |
| name_zh | TEXT | NOT NULL | 中文名（后台显示） |
| gp_lang | TEXT | NOT NULL | Google Play 抓取用 `lang` |
| ios_lang | TEXT | NOT NULL | App Store 抓取用 `lang` |
| enabled | INTEGER(bool) | NOT NULL DEFAULT 1 | 是否参与采集 |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

#### 4.2.2 `keywords` — 搜索关键词

| 字段 | 类型 | 约束 | 语义 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | |
| country | TEXT | NOT NULL, FK countries.code | |
| store | TEXT | NOT NULL DEFAULT 'both' | `gp` / `ios` / `both` |
| term | TEXT | NOT NULL | 搜索词原文 |
| lang | TEXT | NOT NULL | 该词语言（`en`/`th`/`es`/`tl`/`ur`/`id`…），用于后台展示与统计 |
| enabled | INTEGER(bool) | NOT NULL DEFAULT 1 | |
| source | TEXT | NOT NULL DEFAULT 'seed' | `seed`（来自 YAML）/ `manual`（后台新增） |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

索引：`UNIQUE (country, store, term)`（种子同步的自然键）；`INDEX (country, enabled)`。

#### 4.2.3 `classification_rules` — 识别规则

| 字段 | 类型 | 约束 | 语义 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | |
| country | TEXT | NULL, FK countries.code | `NULL` = 全局规则（对所有国家生效） |
| store | TEXT | NOT NULL DEFAULT 'both' | `gp` / `ios` / `both` |
| kind | TEXT | NOT NULL | `keyword` / `regex` / `category` / `negative`（`RuleKindSchema`） |
| pattern | TEXT | NOT NULL | 匹配模式，语义见 PRD #5 |
| weight | INTEGER | NOT NULL | 权重；`negative` 为负数 |
| note | TEXT | NULL | 人类可读说明 |
| enabled | INTEGER(bool) | NOT NULL DEFAULT 1 | |
| source | TEXT | NOT NULL DEFAULT 'seed' | `seed` / `manual` |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

索引：`UNIQUE (coalesce(country, '*'), store, kind, pattern)`（表达式唯一索引；因 SQLite 中 NULL 互不相等，必须用 `coalesce` 才能防止全局规则重复插入。Drizzle 若不便表达，可在迁移 SQL 中追加 `CREATE UNIQUE INDEX`）；`INDEX (country, enabled)`。

#### 4.2.4 `apps` — 应用主档（跨国家共享）

| 字段 | 类型 | 约束 | 语义 |
|---|---|---|---|
| id | TEXT | PK | `gp:<packageName>` / `ios:<trackId>` |
| store | TEXT | NOT NULL | `gp` / `ios` |
| store_app_id | TEXT | NOT NULL | GP: packageName；iOS: trackId（字符串） |
| bundle_id | TEXT | NULL | GP: 同 store_app_id；iOS: bundleId（如 `com.x.y`） |
| title | TEXT | NOT NULL | 最近一次抓取的标题 |
| developer_id | TEXT | NULL | 商店开发者 ID |
| developer_name | TEXT | NULL | |
| developer_email | TEXT | NULL | iOS 无此字段 → NULL |
| developer_website | TEXT | NULL | |
| privacy_policy_url | TEXT | NULL | |
| icon | TEXT | NULL | 图标 URL |
| genre | TEXT | NULL | 分类名（GP `Finance` / iOS `Finance`） |
| genre_id | TEXT | NULL | 分类 ID（GP `FINANCE` / iOS `6015`，保持商店原值） |
| content_rating | TEXT | NULL | |
| released_at | TEXT | NULL | 商店首次发布日期（ISO；GP 为本地化字符串无法解析时为 NULL） |
| first_seen_at | TEXT | NOT NULL | 本系统首次发现时间 |
| last_seen_at | TEXT | NOT NULL | 最近一次在任意国家抓到 |
| is_loan | INTEGER(bool) | NOT NULL DEFAULT 0 | 引擎判定（不含人工覆盖） |
| loan_score | INTEGER | NOT NULL DEFAULT 0 | 引擎得分 |
| classification_json | TEXT | NULL | 引擎输出（`ClassifyResult` JSON，见 PRD #5） |
| manual_label | TEXT | NULL | `loan` / `not_loan` / NULL（`ManualLabelSchema`），优先级最高 |
| status | TEXT | NOT NULL DEFAULT 'active' | `active` / `removed`（`AppStatusSchema`） |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

索引：`UNIQUE (store, store_app_id)`；`INDEX (is_loan, status)`；`INDEX (developer_id)`；`INDEX (last_seen_at)`。

派生语义（供视图与 API 统一）：**有效贷款判定** `effective_is_loan = CASE manual_label WHEN 'loan' THEN 1 WHEN 'not_loan' THEN 0 ELSE is_loan END`。

#### 4.2.5 `app_countries` — 应用在各国的可见性

| 字段 | 类型 | 约束 | 语义 |
|---|---|---|---|
| app_id | TEXT | NOT NULL, FK apps.id CASCADE | |
| country | TEXT | NOT NULL, FK countries.code | |
| available | INTEGER(bool) | NOT NULL DEFAULT 1 | 最近一轮在该国是否可见 |
| first_seen_at | TEXT | NOT NULL | 在该国首次发现 |
| last_seen_at | TEXT | NOT NULL | 在该国最近一次抓到 |
| last_rank | INTEGER | NULL | 最近一次榜单名次（任意 collection 中的最好名次），无则 NULL |
| last_rank_at | TEXT | NULL | `last_rank` 对应的抓取时间 |
| updated_at | TEXT | NOT NULL | |

主键：`PRIMARY KEY (app_id, country)`；索引 `INDEX (country, available)`。

#### 4.2.6 `app_snapshots` — 详情快照（仅内容变化时写入，首次必写）

| 字段 | 类型 | 约束 | 语义 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | |
| app_id | TEXT | NOT NULL, FK apps.id CASCADE | |
| country | TEXT | NOT NULL, FK countries.code | 抓取所用国家（同一 app 各国描述可能不同） |
| captured_at | TEXT | NOT NULL | |
| content_hash | TEXT | NOT NULL | 由 E5 计算的 sha256（hex，64 字符），对「可比较字段」的规范化 JSON 取哈希；E1 只约束非空与长度 |
| version | TEXT | NULL | |
| store_updated_at | TEXT | NULL | 商店端「更新时间」 |
| installs_text | TEXT | NULL | GP `1,000,000+`；iOS NULL |
| min_installs | INTEGER | NULL | GP；iOS NULL |
| score | REAL | NULL | 平均分 |
| ratings | INTEGER | NULL | 评分数 |
| reviews | INTEGER | NULL | 评价数（iOS 详情不提供 → NULL） |
| histogram_json | TEXT | NULL | `{"1":n,"2":n,"3":n,"4":n,"5":n}` |
| description | TEXT | NULL | |
| summary | TEXT | NULL | GP 短描述；iOS NULL |
| release_notes | TEXT | NULL | |
| price | REAL | NULL | |
| currency | TEXT | NULL | |
| size | INTEGER | NULL | 字节；GP 无 → NULL |
| min_os | TEXT | NULL | GP `androidVersion` / iOS `requiredOsVersion` |
| permissions_json | TEXT | NULL | GP 权限列表；iOS NULL |
| data_safety_json | TEXT | NULL | GP 数据安全；iOS NULL |
| privacy_json | TEXT | NULL | iOS 隐私标签；GP NULL |
| version_history_json | TEXT | NULL | iOS 版本历史；GP NULL |
| raw_json | TEXT | NOT NULL | 采集层 `NormalizedApp.raw`（商店原始返回） |

索引：`INDEX (app_id, country, captured_at DESC)`；`INDEX (captured_at)`。

> 说明：`version_history_json` 在方案第 2 节表格未单列，但第 3 节第 ⑦ 步明确要求「版本变化时拉 versionHistory」，需要落库位置，故在此补列。

#### 4.2.7 `app_metrics_daily` — 每日指标（upsert）

| 字段 | 类型 | 约束 | 语义 |
|---|---|---|---|
| app_id | TEXT | NOT NULL, FK apps.id CASCADE | |
| country | TEXT | NOT NULL, FK countries.code | |
| day | TEXT | NOT NULL | `YYYY-MM-DD`（UTC） |
| min_installs | INTEGER | NULL | 当日最后一次观测值 |
| score | REAL | NULL | |
| ratings | INTEGER | NULL | |
| reviews | INTEGER | NULL | |
| rank | INTEGER | NULL | 当日最好榜单名次 |
| updated_at | TEXT | NOT NULL | |

主键：`PRIMARY KEY (app_id, country, day)`；索引 `INDEX (country, day)`。

#### 4.2.8 `app_events` — 变更事件（「新发现」页数据源）

| 字段 | 类型 | 约束 | 语义 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | |
| app_id | TEXT | NOT NULL, FK apps.id CASCADE | |
| country | TEXT | NOT NULL, FK countries.code | |
| store | TEXT | NOT NULL | 冗余以便按商店筛选 |
| type | TEXT | NOT NULL | `EventTypeSchema` 的 11 个取值 |
| detected_at | TEXT | NOT NULL | |
| diff_json | TEXT | NULL | 变更明细（如 `{"version":{"from":"1.0","to":"1.1"}}`），结构由 E5 定义 |
| snapshot_id | INTEGER | NULL, FK app_snapshots.id ON DELETE SET NULL | 触发该事件的快照 |
| seen | INTEGER(bool) | NOT NULL DEFAULT 0 | 后台已读 |

索引：`INDEX (detected_at DESC)`；`INDEX (country, type, detected_at DESC)`；`INDEX (app_id, detected_at DESC)`。

#### 4.2.9 `reviews` — 用户评价

| 字段 | 类型 | 约束 | 语义 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | |
| app_id | TEXT | NOT NULL, FK apps.id CASCADE | |
| country | TEXT | NOT NULL, FK countries.code | 抓取所用国家 |
| store_review_id | TEXT | NOT NULL | 商店评价 ID |
| user_name | TEXT | NULL | |
| score | INTEGER | NULL | 1–5 |
| title | TEXT | NULL | iOS 有；GP 通常 NULL |
| text | TEXT | NULL | |
| version | TEXT | NULL | |
| reviewed_at | TEXT | NULL | ISO |
| thumbs_up | INTEGER | NULL | GP `thumbsUp`；iOS `voteSum` |
| raw_json | TEXT | NOT NULL | |
| created_at | TEXT | NOT NULL | |

索引：`UNIQUE (app_id, store_review_id)`；`INDEX (app_id, reviewed_at DESC)`。

#### 4.2.10 `rank_snapshots` — 榜单快照（每次榜单抓取写入）

| 字段 | 类型 | 约束 | 语义 |
|---|---|---|---|
| store | TEXT | NOT NULL | |
| country | TEXT | NOT NULL, FK countries.code | |
| collection | TEXT | NOT NULL | `top_free` / `new_free`（归一化名，非商店原值） |
| category | TEXT | NOT NULL | `finance`（归一化名） |
| captured_at | TEXT | NOT NULL | 同一次榜单抓取共用同一值 |
| app_id | TEXT | NOT NULL, FK apps.id CASCADE | |
| rank | INTEGER | NOT NULL | 1 起 |

主键：`PRIMARY KEY (store, country, collection, category, captured_at, app_id)`；索引 `INDEX (app_id, captured_at DESC)`；`INDEX (country, store, captured_at DESC)`。

#### 4.2.11 `crawl_runs` — 采集运行日志

| 字段 | 类型 | 约束 | 语义 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | |
| trigger | TEXT | NOT NULL | `cron` / `manual` |
| country | TEXT | NULL | 手动触发限定国家；NULL = 全部 |
| store | TEXT | NULL | 手动触发限定商店；NULL = 全部 |
| started_at | TEXT | NOT NULL | |
| finished_at | TEXT | NULL | 运行中为 NULL |
| status | TEXT | NOT NULL | `running` / `success` / `partial` / `failed` / `skipped`（`CrawlRunStatusSchema`） |
| stats_json | TEXT | NULL | 计数（如 `{"apps":120,"new":3,"updated":9,"events":12}`），结构由 E6 定义 |
| errors_json | TEXT | NULL | 错误列表 `[{"store","country","op","kind","message","at"}]` |

索引：`INDEX (started_at DESC)`。

### 4.3 只读视图

#### `v_loan_apps_latest`

每个「有效贷款应用 × 国家」一行，附最新快照的核心指标。

```sql
CREATE VIEW v_loan_apps_latest AS
SELECT
  a.id            AS app_id,
  a.store,
  a.store_app_id,
  a.title,
  a.developer_name,
  a.genre,
  a.is_loan,
  a.loan_score,
  a.manual_label,
  CASE a.manual_label WHEN 'loan' THEN 1 WHEN 'not_loan' THEN 0 ELSE a.is_loan END AS effective_is_loan,
  a.status,
  ac.country,
  ac.available,
  ac.first_seen_at,
  ac.last_seen_at,
  ac.last_rank,
  s.id            AS snapshot_id,
  s.captured_at   AS snapshot_at,
  s.version,
  s.store_updated_at,
  s.installs_text,
  s.min_installs,
  s.score,
  s.ratings,
  s.reviews
FROM apps a
JOIN app_countries ac ON ac.app_id = a.id
LEFT JOIN app_snapshots s ON s.id = (
  SELECT id FROM app_snapshots
  WHERE app_id = a.id AND country = ac.country
  ORDER BY captured_at DESC, id DESC LIMIT 1
)
WHERE CASE a.manual_label WHEN 'loan' THEN 1 WHEN 'not_loan' THEN 0 ELSE a.is_loan END = 1;
```

#### `v_today_events`

当天（UTC）的事件，附应用基本信息。

```sql
CREATE VIEW v_today_events AS
SELECT
  e.id, e.type, e.detected_at, e.country, e.store, e.seen, e.diff_json, e.snapshot_id,
  a.id AS app_id, a.title, a.icon, a.developer_name, a.loan_score, a.manual_label
FROM app_events e
JOIN apps a ON a.id = e.app_id
WHERE substr(e.detected_at, 1, 10) = strftime('%Y-%m-%d', 'now')
ORDER BY e.detected_at DESC;
```

### 4.4 `packages/shared` 新增枚举与 zod

在 `packages/shared/src/enums.ts` 追加（现有 `StoreSchema` / `EventTypeSchema` / `AppStatusSchema` 保留）：

```ts
export const KeywordStoreSchema = z.enum(['gp', 'ios', 'both']);
export const RuleKindSchema = z.enum(['keyword', 'regex', 'category', 'negative']);
export const ManualLabelSchema = z.enum(['loan', 'not_loan']);
export const CrawlTriggerSchema = z.enum(['cron', 'manual']);
export const CrawlRunStatusSchema = z.enum(['running', 'success', 'partial', 'failed', 'skipped']);
export const RankCollectionSchema = z.enum(['top_free', 'new_free']);
export const RankCategorySchema = z.enum(['finance']);
```

新建 `packages/shared/src/config.ts`（并从 `index.ts` 导出）：

```ts
export const SeedKeywordSchema = z.object({ term: z.string().min(1), lang: z.string().min(2), store: KeywordStoreSchema.default('both') });
export const SeedRuleSchema = z.object({
  kind: RuleKindSchema, pattern: z.string().min(1), weight: z.number().int(),
  note: z.string().optional(), store: KeywordStoreSchema.default('both'),
});
export const SeedCountrySchema = z.object({
  code: z.string().regex(/^[a-z]{2}$/), name_zh: z.string().min(1),
  gp_lang: z.string().min(2), ios_lang: z.string().min(2), enabled: z.boolean().default(true),
  keywords: z.array(SeedKeywordSchema).default([]), rules: z.array(SeedRuleSchema).default([]),
});
export const CountriesConfigSchema = z.object({
  countries: z.array(SeedCountrySchema).min(1),
  global_rules: z.array(SeedRuleSchema).default([]),
  loan_threshold: z.number().int().positive(),
});
export type CountriesConfig = z.infer<typeof CountriesConfigSchema>;
```

校验规则：`negative` 的 `weight` 必须 `< 0`，其它 kind 必须 `> 0`（用 `superRefine`）；`regex` 与 `negative` 的 `pattern` 必须能 `new RegExp(pattern, 'iu')`，否则加载失败并指出是哪个国家第几条。当前 `config/countries.yaml` 必须能通过校验（若发现现有 YAML 不合规，修 YAML 而不是放松校验）。

### 4.5 种子同步规则（`syncSeed`）

签名：`syncSeed(db: Db, config: CountriesConfig, now = new Date()): SeedSyncReport`
返回 `{ countries: {inserted, skipped}, keywords: {inserted, skipped}, rules: {inserted, skipped} }`。

| 对象 | 自然键（判断「已存在」） | 已存在时 | 不存在时 |
|---|---|---|---|
| countries | `code` | **跳过**（不改 name_zh / gp_lang / ios_lang / enabled） | 插入 |
| keywords | `(country, store, term)` | 跳过（不改 lang / enabled） | 插入，`source='seed'`，`enabled=1` |
| rules（国家） | `(country, store, kind, pattern)` | 跳过（不改 weight / note / enabled） | 插入，`source='seed'` |
| rules（全局） | `(NULL, store, kind, pattern)` | 跳过 | 插入，`country=NULL`，`source='seed'` |

- YAML 中删除的条目 **不** 从 DB 删除，DB 中 `source='manual'` 的行永远不被同步触碰。
- 整个同步在一个事务中执行；任一步失败则整体回滚并抛错（服务启动失败，日志指出原因）。
- 同步是幂等的：连续执行两次，第二次 `inserted` 全为 0，DB 行数不变。
- 执行时机：`main.ts` 在迁移之后、启动 API/cron 之前调用；`npm run db:seed` 独立执行（先迁移再同步）。

### 4.6 连接与 PRAGMA

`apps/server/src/db/index.ts` 打开连接后依次执行：`PRAGMA journal_mode = WAL;` `PRAGMA foreign_keys = ON;` `PRAGMA busy_timeout = 5000;` `PRAGMA synchronous = NORMAL;`。提供 `openDatabase(path)` 工厂以便测试用临时文件。

### 4.7 命令

| 命令 | 行为 |
|---|---|
| `npm run db:generate` | drizzle-kit 依据 schema 生成迁移到 `apps/server/drizzle/`（迁移文件提交进仓库） |
| `npm run db:migrate` | 创建/迁移 `DATABASE_PATH` 指向的库；幂等 |
| `npm run db:seed` | 迁移 + 种子同步，打印 `SeedSyncReport` |

### 4.8 `docs/DATA_MODEL.md` 结构要求

1. 约定（§4.1 内容）；2. 每张表：一段用途说明 + 字段表（字段/类型/约束/语义）+ 索引；3. 视图 SQL；4. 种子同步规则；5. 「与 schema 同步」提示：修改 `schema.ts` 的 PR 必须同 PR 更新本文档（已写在 PR 模板自检清单）。文档中的表名、字段名必须与 `schema.ts` 一一对应，测试 AC-14 会做机械比对。

## 5. 验收标准（AC）

所有 AC 在干净环境执行：`rm -f /tmp/appeye-test.sqlite* && DATABASE_PATH=/tmp/appeye-test.sqlite npm run db:migrate`（路径可替换）。

- **AC-1 迁移建表**：`db:migrate` 后 `sqlite3 $DB ".tables"` 恰好包含 11 张业务表 `countries keywords classification_rules apps app_countries app_snapshots app_metrics_daily app_events reviews rank_snapshots crawl_runs`（另允许 drizzle 的 `__drizzle_migrations`），以及视图 `v_loan_apps_latest`、`v_today_events`（`select name from sqlite_master where type='view'`）。
- **AC-2 迁移幂等**：连续执行两次 `db:migrate` 第二次退出码 0，`sqlite_master` 行数不变。
- **AC-3 字段与 DATA_MODEL 一致**：对 11 张表逐一 `PRAGMA table_info(<table>)`，字段名、类型、NOT NULL、默认值与本 PRD §4.2 及 `docs/DATA_MODEL.md` 一致（vitest 中用 `PRAGMA table_info` 与文档表格解析结果比对，或 Alex 手工抽查每表全部字段）。
- **AC-4 主键/唯一约束**：以下插入第二次必须失败（`UNIQUE constraint failed`）：`apps(store, store_app_id)` 重复；`keywords(country, store, term)` 重复；`classification_rules` 两条 `country=NULL, store='both', kind='keyword', pattern='x'`；`reviews(app_id, store_review_id)` 重复；`app_metrics_daily(app_id, country, day)` 重复；`app_countries(app_id, country)` 重复；`rank_snapshots` 全主键重复。
- **AC-5 外键生效**：通过 `openDatabase()` 打开的连接 `PRAGMA foreign_keys` 返回 1；插入 `app_snapshots.app_id='gp:nope'`（apps 中不存在）失败并报 `FOREIGN KEY constraint failed`；删除一条 `apps` 后其 `app_snapshots / app_events / app_metrics_daily / reviews / rank_snapshots / app_countries` 行被级联删除；删除 `app_snapshots` 一行后引用它的 `app_events.snapshot_id` 变为 NULL。
- **AC-6 WAL 与 PRAGMA**：`openDatabase()` 后 `PRAGMA journal_mode` 返回 `wal`，`PRAGMA busy_timeout` 返回 5000；库文件旁出现 `-wal`/`-shm` 文件（有写入后）。
- **AC-7 ID 格式**：`schema.ts` 导出的 `makeAppId(store, storeAppId)` 对 `('gp','com.a.b')` 返回 `gp:com.a.b`，对 `('ios', 123)` / `('ios','123')` 均返回 `ios:123`；`parseAppId('ios:123')` 返回 `{store:'ios', storeAppId:'123'}`；非法输入（无冒号、未知 store）抛错。
- **AC-8 种子同步-首次**：空库执行 `npm run db:seed`：`countries` 6 行（th/mx/ph/pk/id/ar，enabled=1）；`keywords` 行数 = YAML 各国 keywords 总数（当前 38：th 8 / mx 6 / ph 7 / pk 5 / id 6 / ar 6）；`classification_rules` 行数 = 各国 rules 总数 + global_rules 数（当前 19 + 7 = 26），其中 `country IS NULL` 的恰好 7 行；所有行 `source='seed'`。（若 YAML 在此期间被修改，以修改后的计数为准，测试应从 YAML 动态计算期望值而非写死。）
- **AC-9 种子同步-不覆盖**：先 `db:seed`，然后手工 `update countries set name_zh='测试' where code='th'`、`update keywords set enabled=0 where term='loan' and country='th'`、`update classification_rules set weight=99 where country='id' and kind='keyword'`、再插入一条 `source='manual'` 的关键词；再次 `db:seed` 后：三处修改保持不变，manual 行仍在，`SeedSyncReport` 三类 `inserted` 均为 0。
- **AC-10 种子同步-新增**：在测试中构造一份 config（YAML 副本追加国家 `vn` + 1 个关键词 + 1 条规则）调用 `syncSeed`，报告 `countries.inserted=1, keywords.inserted=1, rules.inserted=1`，其余 skipped；已有 6 国数据不变。
- **AC-11 种子校验**：`loadCountriesConfig()` 对当前仓库 `config/countries.yaml` 成功；对 `kind: negative, weight: 3`、对 `kind: regex, pattern: "("`、对 `code: TH`（大写）三种坏配置各抛出包含国家 code 与条目位置的错误。
- **AC-12 视图-贷款应用**：插入 2 个 app（A：`is_loan=1`；B：`is_loan=0, manual_label='loan'`；C：`is_loan=1, manual_label='not_loan'`），各 1 行 `app_countries(country='th')`，A 插入两条 `app_snapshots`（captured_at 不同）。`select * from v_loan_apps_latest` 返回 A、B 两行（无 C），A 的 `snapshot_id` 为较新那条，`effective_is_loan` 均为 1。
- **AC-13 视图-今日事件**：插入 `detected_at` 为当前 UTC 时间的事件 1 条与昨天的事件 1 条，`select count(*) from v_today_events` 返回 1，且结果含 `title`、`type`、`country` 列。
- **AC-14 DATA_MODEL 文档同步**：`docs/DATA_MODEL.md` 含全部 11 张表与 2 个视图小节；vitest 用正则从文档中抽取每个表小节的字段名集合，与 `PRAGMA table_info` 的字段名集合完全相等（缺一多一均失败）。
- **AC-15 shared 类型**：`@appeye/shared` 导出 `KeywordStoreSchema / RuleKindSchema / ManualLabelSchema / CrawlTriggerSchema / CrawlRunStatusSchema / RankCollectionSchema / RankCategorySchema / CountriesConfigSchema`；`npm run typecheck` 通过；`CountriesConfigSchema.parse(yaml.parse(readFile('config/countries.yaml')))` 不抛错。
- **AC-16 启动集成**：`DATABASE_PATH=<tmp> npm run dev`（或 `tsx apps/server/src/main.ts`）在库文件不存在时能自动创建目录与库、迁移、同步种子并启动，`GET /health` 返回 200；日志中出现一条包含 `seed` 与 inserted 计数的 info 记录。
- **AC-17 质量门**：`npm run lint && npm run typecheck && npm test` 全部通过；新增测试文件位于 `apps/server/test/db/`，不依赖网络，不污染仓库 `data/` 目录（使用临时路径）。

## 6. 非功能要求

- **性能**：`db:migrate` 空库 < 3 s；`syncSeed` 当前规模 < 500 ms；`v_loan_apps_latest` 在 10 万快照 / 5 千应用规模下单次查询 < 500 ms（依赖 `app_snapshots(app_id, country, captured_at DESC)` 索引；Alex 可用脚本灌数据抽测，不作为阻塞项）。
- **并发**：WAL + busy_timeout 5 s，保证 API 读与 cron 写并行不报 `SQLITE_BUSY`。
- **容错**：迁移或种子失败时进程以非 0 退出并打印可定位的错误；不留下半初始化状态（种子在事务内）。
- **日志**：迁移开始/结束、种子报告以 pino info 输出；PRAGMA 设置以 debug 输出。
- **可移植**：迁移 SQL 只使用 SQLite 语法；不依赖扩展。
- **类型安全**：所有表的 `$inferSelect` / `$inferInsert` 类型从 `schema.ts` 导出，供 E2–E7 使用。

## 7. 风险与开放问题

| # | 类型 | 内容 | 建议 |
|---|---|---|---|
| Q1 | 开放 | `loan_threshold` 是否入库以便后台修改？方案第 3 节把阈值放在 YAML；E9「设置」页若要改阈值需要存储位置。 | E1 不入库；E4 从 YAML 读取；若 E9 需要，届时新增 `settings(key, value)` 表。 |
| Q2 | 开放 | `app_snapshots` 是否需要 `crawl_run_id` 追溯是哪一轮写入？ | 本期不加；E6 若需要，可通过 `captured_at` 与 `crawl_runs` 时间区间关联。 |
| Q3 | 假设 | `crawl_runs` 增加 `country`/`store` 两列（方案未列），用于记录手动触发范围。 | 已在 §4.2.11 采纳，请 CEO 知悉。 |
| Q4 | 假设 | `rank_snapshots.collection/category` 使用归一化值 `top_free/new_free/finance`，而不是商店原值（`TOP_FREE` / `topfreeapplications` / `6015`）。 | 便于跨商店查询；原值由采集层 `raw` 保留。 |
| Q5 | 风险 | Drizzle 对「表达式唯一索引」`coalesce(country,'*')` 的支持取决于版本。 | 允许在生成的迁移 SQL 里手写该索引；`db:generate` 之后不能被 drizzle-kit 再次生成时抹掉（CTO 需验证二次 generate 的 diff 为空）。 |
| Q6 | 风险 | drizzle-kit 对 SQLite VIEW 的生成支持有限。 | 允许在迁移 SQL 追加 `CREATE VIEW`；同 Q5 验证二次 generate 稳定。 |
| Q7 | 风险 | GP `released` 为本地化字符串（如泰语月份），`released_at` 可能大量为 NULL。 | 接受；采集层尽力解析，失败置 NULL 并保留 raw（见 PRD #3）。 |
| Q8 | 假设 | 时间统一 UTC ISO 字符串而非整数 epoch，牺牲少量存储换取 `sqlite3` 直接可读。 | 已采纳。 |
