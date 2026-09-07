# AppeyeCC

个人贷款应用市场监控系统：监控泰国/墨西哥/菲律宾/巴基斯坦/印尼/阿根廷等国 Google Play 与 App Store 上的个人贷款类应用（新上架、更新、下载量、评价、基本信息、权限等），每小时刷新，并提供管理后台。

## 技术栈
- Node ≥22.12，TypeScript（NodeNext ESM），npm workspaces monorepo
- `apps/server`：Fastify 5 + node-cron + Drizzle ORM + better-sqlite3；采集库 `@mradex77/google-play-scraper`、`@perttu/app-store-scraper`
- `apps/web`：React 19 + Vite + Tailwind 4 + TanStack Query + react-router 7，界面语言 zh-CN
- `packages/shared`：zod 契约与类型（server/web 共用）

## 常用命令
- `npm run dev` 启动 server（tsx watch，端口 3000）；`npm run dev:web` 启动前端（5173，代理 /api）
- `npm run lint` / `npm run typecheck` / `npm test`（vitest）；`npm run test:network` 跑真实抓取测试
- `npm run db:generate` 生成迁移；`npm run db:migrate` 执行迁移
- `npm run crawl -- --country th --store gp` 手动触发一轮采集

## 约定
- 所有需求/缺陷/验收通过 GitHub Issue 流转，规范见 `docs/PROCESS.md`；角色定义见 `.claude/agents/`
- 表结构改动必须同步 `docs/DATA_MODEL.md`
- API 契约先在 `packages/shared` 用 zod 定义，再在 server 实现、web 使用
- 提交信息使用 Conventional Commits；分支 `feat/<issue#>-<slug>`
- 抓取必须走各自 scraper 封装层（`apps/server/src/scrapers/`），统一节流与错误映射，禁止在业务代码里直接调用第三方库
