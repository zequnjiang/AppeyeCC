# 需求流转规范（PROCESS）

本项目所有需求、缺陷、验收都通过 GitHub 管理与追踪。

## 角色

| 角色 | 名称 | 职责 |
|---|---|---|
| 主 Agent | CEO | 拆 Epic、创建 Issue、调度 PM→CTO→Alex→PM、合并 PR、维护看板；对最终目标负责 |
| Subagent | PM（产品经理） | 理解并拆分需求，编写 PRD；测试通过后做验收，出验收报告并关闭需求 |
| Subagent | CTO（开发工程师） | 按 PRD 开发，补测试，完成自检，提 PR 流转给测试 |
| Subagent | Alex（测试工程师） | 按 PRD 验收标准设计用例并验证，出测试报告；通过流转 PM 验收，失败退回开发 |

## Issue 类型与标签

- `type:epic` / `type:story` / `type:bug`
- `priority:p0` / `priority:p1` / `priority:p2`
- `area:server` / `area:web` / `area:scraper` / `area:classify` / `area:infra` / `area:docs`
- 状态（同一时间只能有一个）：
  `status:backlog` → `status:pm-spec` → `status:ready-for-dev` → `status:in-dev` → `status:qa` → `status:acceptance` → `status:done`
  另有 `status:blocked`。

## 流转步骤

1. **CEO** 创建 Issue（用模板），打 `status:backlog`，分配给 PM 时改为 `status:pm-spec`。
2. **PM** 编写 `docs/prd/<issue#>-<slug>.md`，包含：背景与目标、用户故事、功能范围（含非目标）、数据/接口定义、**验收标准（AC，编号、可验证）**、非功能要求、风险。以 PR 合并到 `main`，在 Issue 评论中贴 PRD 链接，改标签为 `status:ready-for-dev`。
3. **CTO** 从 `main` 切分支 `feat/<issue#>-<slug>`（缺陷用 `fix/`），改标签 `status:in-dev`。开发完成后：
   - 运行 `npm run lint && npm run typecheck && npm test` 全部通过；
   - 涉及表结构必须同步更新 `docs/DATA_MODEL.md`；
   - 提 PR（标题 `feat(#<issue#>): ...`，正文含 `Closes #<issue#>` 不要写——由 PM 关闭；写 `Refs #<issue#>`），按 PR 模板完成**自检清单**并写手动验证记录；
   - 在 Issue 评论贴 PR 链接，改标签 `status:qa`。
4. **Alex** 基于 PRD 的 AC 设计用例，在 PR 分支上运行自动化测试并做手工验证（API / 浏览器），编写 `docs/test-reports/<issue#>.md`（用例、结果、缺陷、结论），以 PR 形式提交到同一分支或单独 PR。
   - 通过：Issue 评论贴报告链接，改标签 `status:acceptance`；
   - 失败：在 Issue 评论列出缺陷（或另建 `type:bug` Issue 关联），改标签 `status:in-dev` 退回 CTO。
5. **PM** 逐条核对 AC，编写 `docs/acceptance/<issue#>.md`（AC 对照表、结论、遗留项）。
   - 通过：评论贴验收报告，改标签 `status:done`，由 CEO 合并 PR 并关闭 Issue；
   - 不通过：说明未满足的 AC，改标签 `status:in-dev` 退回。
6. **CEO** 合并 PR（squash），关闭 Issue，移动看板卡片到 Done。

## 分支与提交

- `main` 为可运行主干；所有改动经 PR 合并。
- 提交信息遵循 Conventional Commits：`feat|fix|docs|test|chore|refactor(scope): 描述`。
- PR 必须通过 CI（lint + typecheck + test）。

## 文档位置

| 文档 | 路径 |
|---|---|
| 需求文档 PRD | `docs/prd/<issue#>-<slug>.md` |
| 测试报告 | `docs/test-reports/<issue#>.md` |
| 验收报告 | `docs/acceptance/<issue#>.md` |
| 架构决策 | `docs/adr/NNNN-<slug>.md` |
| 数据模型 | `docs/DATA_MODEL.md` |
