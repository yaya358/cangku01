# 交接说明（给下一个会话）

> 新会话的上下文是空的。**先读这份 + `docs/design-world.md`，再动代码。**
> 本文件只写「现在在哪、接下来做什么、哪些坑别再踩」。

## 一、项目是什么

本地 AI 角色扮演酒馆：Vue3 前端 + Fastify/SQLite 后端，pnpm monorepo。
仓库 `C:\Users\jingy\Desktop\vork01`，远端 `github.com/yaya358/cangku01`（main）。

**当前状态**：54 个提交 / 289 个用例通过 / lint 与全仓 typecheck 干净 / 远端已同步。

```bash
pnpm install && pnpm dev     # 后端 8787 + 前端 5173
pnpm --filter @tavern/server run test
pnpm -r run typecheck && pnpm lint
```

## 二、已完成的能力（别重复实现）

角色卡 V1/V2/V3 导入导出 · 头像上传 · 世界书（关键词/次要/递归/常驻）· 上下文分层与预算 ·
聊天落库 · 重说（swipes）· 对话树分支 · 秘密与目的 · 玩家身份 · 剧本事件（轮次/条件/结局/事实）·
剧本导出导入 · 五种输入方式（speak/act/think/narrate/ooc）· 微信式会话列表 · 酒馆大厅 ·
世界存档地基（saves/scenes/presence）· 场景内对话（在场者接话）· Docker · README/架构文档

## 三、正在进行的大改造：世界模式（见 docs/design-world.md）

目标：从「按角色开会话」变成「一个存档 → 场景 → 在场者」，并加好感度、主线、情报本、偷听。

| 步 | 内容 | 状态 |
|---|---|---|
| 1 | 场景对话接口（在场者接话） | ✅ 已完成（`routes/world.ts`） |
| 2 | 前端场景视图 | ✅ 已完成（`views/SceneView.vue` + `GET /api/world/scenes/:id`） |
| 3 | 私聊场景 + 低声 + 偷听 | ⬜ **接下来做这个** |
| 4 | 好感度打分 + 阈值解锁 | ⬜ |
| 5 | 主线章节 + 情报本侧栏 | ⬜ |
| 6 | 旧会话迁移成私密场景 | ⬜ |

### 第 2 步：前端场景视图（已完成，要点留着备查）

- `GET /api/world/scenes/:id` → `{ scene, present, cast, conversationId, messages }`；
  `present` 里带 `reachability` 与 `hint`（文案在 `describeReachability`，前端不重复写）
- 新页面 `apps/web/src/views/SceneView.vue`（路由 `/scenes/:id`）、状态在 `stores/scene.ts`、
  接口在 `api/world.ts`
- 顶部头像条显示在场者与「在忙什么」，点一下给出可达性文案；助手气泡上方显示发言人名字
- 底部五种输入方式仍在，发送走 `POST /api/world/scenes/:id/stream`
- 顺手修了两个第 1 步的 bug：
  1. 轮转取模用成「消息总数」（每轮两条，等于永远同一个人）→ 改成数助手消息（已开口的次数）
  2. 每轮的 user 消息没接 `parentId` → 每轮各自成根，翻看时只剩最后一轮
- 场景会话**不进** `/api/conversations` 列表（`scene_id IS NOT NULL` 的过滤）：
  它属于场景，列到旧对话里会被当成角色私聊，点进去说话会搅乱场景上下文

### 第 3 步：私聊 + 低声 + 偷听

- `messages.whisper` 字段已存在（迁移 11），未使用
- 私聊 = 新建 `kind='private'` 的场景 + 把两人 `enter` 进去；离开公共场景时要能被注意到
- 偷听概率：`whisper`(大幅降低) × 场景 `closeness`(0.3 嘈杂 / 0.7 安静) × 偷听者性格 × 是否在忙
- 命中后要**生成偷听者的反应**插入对话流（不是弹提示），敏感内容还要掉好感
- 未命中也要给确定反馈（"没人注意到"），否则玩家无法判断安全感

### 第 4 步：好感度

- 新表 `affinity(save_id, character_id, value, last_reason, unlocked)`
- 每轮结束单独一次小请求打分（-5~+5 + 一句理由），**必须可关闭**，失败不阻塞主回复
- 阈值：≥60 松口给情报；≤20 冷处理

### 第 5 步：主线 + 情报本

- `quests`（章节/目标/状态）、`clues`（内容/来源/轮次）
- 侧栏三块：主线进度、情报本（可展开看原话）、好感条

### 第 6 步：迁移

- 每条旧 `conversations` → 一个 `kind='private'` 的 scene，消息不动（`scene_id` 回填）

## 四、已知的坑（都踩过，别再踩）

1. **zod `.default()` 会让输出类型变必填** —— 老调用方会类型报错。要兼容就用 `.optional()` + 代码里 `?? 默认值`。
2. **改了用户输入的包装**（现在是 `陈九说：「…」`）会导致断言全红 —— 断言用 `toContain`，不要用 `toBe`。
3. **PowerShell 不要用 `Get-Content`/`Set-Content` 改含中文的文件** —— 会变乱码（踩过一次，靠 `git checkout` 救回）。改文件用 edit/write 工具或 node 脚本。
4. **`edit` 报 `file changed since it was read`** —— 是 `pnpm format` 重排过，重新 read 再改。
5. **8787/5173 端口被旧进程占用** —— 先 `Get-NetTCPConnection -LocalPort 8787 -State Listen` 杀进程再起。
6. **后台任务 5 分钟会被 watchdog 杀掉** —— 起服务后立刻验证，别指望它活着。
7. **JSON 字段（swipes/usage/hall_members）损坏要回落**（`[]`/`null`），不要让整条记录读不出来。
8. **迁移只能用 `ALTER TABLE ADD COLUMN` 或建新表**；已有 11 版，`LATEST_VERSION` 自动推导。
9. **本机验证**：真实模型是 `deepseek-flash`，一轮约 1.3-2 秒、150-250 token；别写会跑几十轮的验证脚本。
10. **提交前必须**：`pnpm -r run typecheck` + `pnpm lint` + 后端测试全绿；commit 用中文正文，说明"为什么"。
11. **改了 `packages/shared` 必须先 `pnpm --filter @tavern/shared run build`** —— 前后端从 `dist` 读类型，
    不 build 就是拿旧契约做 typecheck，白忙一场。
12. **临时脚本别放仓库里**：eslint 不忽略 `tmp/`，Chrome profile 之类一放进去 lint 直接爆几千条。
    放 `%TEMP%` 下跑。
13. **本机端口上的旧后端可能是「不带 watch」起的**（`node --import tsx src/index.ts`），
    改完代码它不会自己重启 —— 新接口 404 先怀疑这个，杀掉重起 `pnpm dev:server`。

## 五、风格约束

- 代码里的注释写**原因**（为什么这么定），不写"这是什么"
- 面向用户的文案说人话，不堆术语；出错要说清"为什么、你该怎么办"
- 明确写"不做"的边界（例如不给不在场的人发消息），比多一个功能更重要
- 每步单独提交、单独推库，推完再进下一步
