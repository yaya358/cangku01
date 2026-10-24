# Git 提交规范与提交计划

本文件规定本仓库的提交节奏、信息格式与常见急救操作。

---

## 一、提交粒度：多少算一次

**核心原则：一个提交 = 一件能一句话说清、能独立回退、提交后代码仍可运行的事。**

| 维度 | 建议 | 说明 |
|---|---|---|
| 改动量 | 50 ~ 300 行 | 超过 500 行就该考虑拆成几个提交 |
| 一件事 | 1 个提交只做 1 件事 | 别把「修 bug」和「加新功能」塞进同一个提交 |
| 可运行 | 提交后项目必须能启动 | 半截跑不起来的代码不提交到 main |
| 频率 | 每天 1 ~ 5 个 | 干完一小块就提交，不要攒到晚上一次性提交 |
| 总量 | 本项目 30 ~ 80 个 | 5000 行代码自然对应这个量级 |

**这样切是对的：**
- 加一个接口 + 它的数据模型 + 它的一条测试 = 一个提交
- 「实现角色卡 PNG 导入」= 一个提交（解析器 + 接口 + 前端入口可以合并，但接口和前端分开更好）

**这样切是错的：**
- ❌ 一次性提交 3000 行，信息写 `update`
- ❌ 一天写完全部代码，全挤在同一小时提交（验收一看时间戳就知道）
- ❌ 每改一个空格提交一次（没有信息量，历史变噪音）
- ❌ 提交时把 `node_modules`、数据库文件、`.env` 一起塞进去

---

## 二、提交信息格式（Conventional Commits）

```
<类型>(<范围>): <简述>

可选正文：为什么这样改，而不是改了什么（代码本身已经说明了改什么）
```

**类型表：**

| 类型 | 用途 | 例子 |
|---|---|---|
| `feat` | 新功能 | `feat(chat): SSE 流式对话接口` |
| `fix` | 修 bug | `fix(context): 修复世界书递归扫描死循环` |
| `refactor` | 重构，不改行为 | `refactor(provider): 抽出统一的重试逻辑` |
| `docs` | 文档 | `docs: 补充 API 接口说明` |
| `chore` | 杂项、构建、配置 | `chore: 配置 ESLint 与 Prettier` |
| `test` | 测试 | `test(context): 补充分层组装单元测试` |
| `style` | 格式调整 | `style: 统一缩进为 2 空格` |
| `perf` | 性能优化 | `perf(memory): 摘要压缩改用更便宜的模型` |

**好的提交信息：** `feat(character): 实现 PNG tEXt chunk 角色卡解析`
**坏的信息：** `更新`、`改了点东西`、`111`

---

## 三、标准提交流程

```bash
git status                  # 我改了哪些文件？
git diff                    # 具体改了什么内容？（提交前必看）
git add src/chat/service.ts # 精确添加，少用 git add .
git commit -m "feat(chat): SSE 流式对话接口"
git push                    # 推送到 GitHub
```

**提交前检查清单：**
- [ ] `git diff` 看过，没有误改的文件
- [ ] 没有 `.env`、密钥、数据库、`node_modules`
- [ ] 项目能启动
- [ ] 提交信息符合上面格式

---

## 四、本项目提交计划

> 计划会随实际进展微调：拆分出来的提交记在对应阶段下，目标始终是「一次提交一件事、提交后能跑」。

### 阶段 0：基建（已完成，8 次提交）

| # | 提交信息 | 内容 |
|---|---|---|
| 1 | `chore: 初始化 pnpm 单仓与目录结构` | workspace 布局、tsconfig 基线、shared 包骨架 |
| 2 | `chore: 配置 ESLint + Prettier` | ESLint 10 扁平配置、Prettier、.gitattributes |
| 3 | `chore: 后端 Fastify 骨架、分层目录与 /api/health` | 响应信封、错误归一、traceId、日志钩子、inject 测试 |
| 4 | `feat(core): 扩展点注册表与生命周期管理` | 五类扩展、排序、失败隔离、逆序释放 |
| 5 | `chore: 配置系统（yaml 分层合并 + zod 校验）` | schema 权威化、深合并、来源追踪 |
| 6 | `feat(config): 环境变量覆盖与配置来源追踪` | `TAVERN_` 映射、类型还原、PaaS 别名 |
| 7 | `chore: 前端 Vue3 + Vite + Pinia + Naive UI 骨架与代理联调` | 契约校验、状态仓库、深色主题、404 兜底 |
| 8 | `feat(server): 生产模式下托管前端静态资源与 SPA 回落` | 单端口整站、缓存分层、自动发现 dist |

### 阶段 1：模型接入层（约 700 行）
9. `feat(provider): 定义 provider 适配器接口`
10. `feat(provider): 实现 OpenAI 兼容接口与流式输出`
11. `feat(provider): 支持自定义 baseURL 与采样参数`
12. `feat(provider): API Key 加密存储`
13. `feat(provider): token 用量统计与失败重试`

### 阶段 2：角色卡（约 600 行）
14. `feat(character): 角色卡数据模型与 CRUD 接口`
15. `feat(character): PNG tEXt chunk 解析与角色卡导入`
16. `feat(character): 角色卡导出为社区格式`
17. `feat(frontend): 角色列表与详情页`

### 阶段 3：上下文引擎（约 900 行，项目核心）
18. `feat(context): 上下文分层组装管线`
19. `feat(context): token 预算分配器`
20. `feat(context): 世界书关键词触发与递归扫描`
21. `feat(context): prompt 组装结果预览接口`
22. `feat(frontend): 上下文预览面板`

### 阶段 4：聊天与分支（约 900 行）
23. `feat(chat): 会话与消息数据模型`
24. `feat(chat): SSE 流式对话接口`
25. `feat(chat): 停止生成 / 重生成 / 编辑消息`
26. `feat(chat): 滑动候选 swipes`
27. `feat(chat): 对话树分支（时间线）`
28. `feat(frontend): 聊天主界面与流式渲染`

### 阶段 5：记忆与群聊（约 800 行）
29. `feat(memory): 滚动摘要压缩`
30. `feat(memory): 剧情事实表`
31. `feat(chat): 多角色群聊与发言调度`
32. `feat(frontend): 群聊界面`

### 阶段 6：收尾（约 600 行）
33. `feat(io): SillyTavern 数据导入导出`
34. `feat: 主题切换与快捷键`
35. `test: 核心上下文引擎单元测试`
36. `docs: 完整使用文档`
37. `chore: Docker 部署配置`

---

## 五、急救手册

| 情况 | 命令 |
|---|---|
| 提交漏了文件 | `git add 漏掉的文件` → `git commit --amend --no-edit` |
| 提交信息写错 | `git commit --amend -m "正确信息"` |
| 想撤回提交但保留改动 | `git reset --soft HEAD~1` |
| 想看某次提交改了什么 | `git show <commit哈希>` |
| 看看最近做了什么 | `git log --oneline -10` |
| 误提交了密钥 | 立刻改密钥 → `git rm --cached .env` → 加进 `.gitignore` → 提交；注意历史中仍有残留，需 `git filter-repo` 彻底清除 |

**⚠️ 已经 push 的提交不要用 `--amend`**，会导致历史分叉、必须强推。本地提交随便改，推上去之后就当作历史。
