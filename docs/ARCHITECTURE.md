# 架构概览

```
┌──────────────┐    hourly cron     ┌──────────────────────────────┐
│  node-cron   │ ─────────────────▶ │ discovery pipeline            │
└──────────────┘                    │  list → search → expand →     │
                                    │  details → classify → diff    │
┌──────────────┐                    │  → snapshots/events/metrics   │
│ Google Play  │◀── scrapers/gp ────│                               │
│ App Store    │◀── scrapers/ios ───│                               │
└──────────────┘                    └──────────────┬───────────────┘
                                                   ▼
                                    ┌──────────────────────────────┐
                                    │ SQLite (Drizzle ORM)          │
                                    └──────────────┬───────────────┘
                                                   ▼
┌──────────────┐   /api/*  (zod)    ┌──────────────────────────────┐
│ React/Vite   │◀──────────────────▶│ Fastify API + 静态托管 web   │
└──────────────┘                    └──────────────────────────────┘
```

- **monorepo**：`packages/shared`（zod 契约）、`apps/server`（Fastify + cron + 采集 + DB）、`apps/web`（React 管理后台）。
- **单进程部署**：server 同时承担 API、定时任务与静态资源托管。
- **数据原则**：快照只在内容变化时写入；每日指标 upsert；所有原始抓取 JSON 保留在 `raw_json`。
- **可扩展国家**：`config/countries.yaml` 追加国家/语言/关键词/规则即可，启动时同步到 DB。
- **代理预留**：`apps/server/src/scrapers/fetch.ts` 提供按国家注入 fetch 的钩子。
