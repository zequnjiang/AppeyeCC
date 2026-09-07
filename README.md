# AppeyeCC

个人贷款应用市场监控系统。监控泰国、墨西哥、菲律宾、巴基斯坦、印尼、阿根廷（可扩展）Google Play / App Store 上的个人贷款类应用：新上架、更新动态、下载量、评分评价、基本信息（官网、隐私协议、权限等），每小时刷新，并提供管理后台查看。

## 快速开始

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev        # API: http://localhost:3000
npm run dev:web    # 后台: http://localhost:5173
```

## 文档
- 架构：`docs/ARCHITECTURE.md`
- 数据模型：`docs/DATA_MODEL.md`
- 协作流程（GitHub Issue 流转、角色分工）：`docs/PROCESS.md`
- 需求 / 测试 / 验收文档：`docs/prd/`、`docs/test-reports/`、`docs/acceptance/`
