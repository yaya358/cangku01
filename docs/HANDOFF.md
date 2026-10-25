# 交接说明（给下一个会话）

> 新会话的上下文是空的。**先读这份 + `docs/design-world.md`，再动代码。**
> 本文件只写「现在在哪、接下来做什么、哪些坑别再踩」。

## 一、项目是什么

本地 AI 角色扮演酒馆：Vue3 前端 + Fastify/SQLite 后端，pnpm monorepo。
仓库 `C:\Users\jingy\Desktop\vork01`，远端 `github.com/yaya358/cangku01`（main）。

**当前状态**：57 个提交 / 357 个用例通过 / lint 与全仓 typecheck 干净 / 远端已同步。

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
| 3 | 私聊场景 + 低声 + 偷听 | ✅ 已完成（`core/world/eavesdrop.ts`、`whisper.ts`、场景私聊接口） |
| 4 | 好感度打分 + 阈值解锁 | ✅ 已完成（`core/world/affinity.ts`、`scoring.ts`、关系条） |
| 5 | 主线章节 + 情报本侧栏 | ✅ 已完成（`core/world/journal.ts`、三栏布局、情报本） |
| 6 | 旧会话迁移成私密场景 | ⬜ **接下来做这个** |

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

### 第 3 步：私聊 + 低声 + 偷听（已完成，要点留着备查）

- **低声不是第六种 kind**：`MessageKind` 仍是五种，`messages` 上多了 `whisper`/`eavesdrop` 两个布尔。
  低声 = 「说话 + whisper 标记」，提示词里换成「压低声音说」（`pipeline.ts` 的 `wrapUserInput`）。
- **偷听判定是纯函数**（`core/world/eavesdrop.ts`）：
  `基础率（低声 0.1 / 正常 0.45）× (0.5 + closeness) × 爱打听 1.4 × 在忙 0.45`，夹在 0.01~0.95。
  「爱打听」从 tags + personality 里认（好奇/多话/话痨/爱打听/爱追问/多嘴/八卦/curious）——
  角色卡没有 curious 字段，硬加一个没人填，不如认人话。随机源可注入，所以测得准。
- **命中**：单独一次非流式调用生成「偷听者的反应」（`buildReactionPrompt`），
  存成 `assistant` + `eavesdrop = 1` 的消息插进对话流，同时写一条 fact（之后他再开口是知道这事的）；
  敏感内容（秘密里的特征片段被提到）会在提示词里把秘密递给他，让他被刺到但不点破。
- **没命中**：也要给确定反馈 —— 落一条 `system` 消息「没人注意到你压低了声音。」，并回一帧 SSE `eavesdrop`。
  system 消息进不了模型历史（两处都过滤 `role !== 'system'`），所以只给玩家看。
- **低声要说给谁听**（`core/world/whisper.ts`）：正主 = 回答这句低声话的那条助手消息的发言人；
  听见的人 = 之后标了 `eavesdrop` 的反应。其余在场者看到的是占位文本「没听清内容」。
  这就是「压低声音」真正的价值 —— 不然没听见的人下一轮照样能引用原话。
- **私密场景**：`POST /api/world/scenes/:id/private`（只在公开场景、只能带 available 的人，
  在忙/已走/不在场各给各的说法），`POST /api/world/scenes/:id/return` 把人带回去。
  离开与回程都写进原场景日志 + fact，并在 `scenes.source_scene_id` 记住回程。
- 新增上下文层 `scene`（此刻的地方 + 在场的人 + 「他压低声音说，旁边的人未必听得见」），
  这是让模型不把不在场的人拉进来说话的关键。

### 第 4 步：好感度（已完成，要点留着备查）

- 表 `affinity (save_id, character_id, value, last_reason, unlocked, updated_at)`，
  主键「存档 + 角色」：同一个角色在另一条世界线里是另一个人生。初始 50，永远夹在 0~100
  （好感是尺子不是计数器，冲过头阈值就失去意义）。
- 每轮结束单独一次非流式打分（`core/world/scoring.ts`）：让模型换旁白视角看「刚才这一轮」，
  产出 `{"delta": -5..5, "reason": "一句具体的话"}`。解析宽容（```json 包裹、前后废话、纯文本都能捞），
  捞不到就发 `failed` 事件、不写库 —— 不假装「这轮没有变化」。
- 可关：`features: { affinityScoring: false }`（config/user.yaml 里加），关掉后连请求都不发。
- 阈值 `>= 60` 松口、`<= 20` 冷处理：跨过去一次就写进 `unlocked` + 一条 fact，之后
  在提示词里变成语气（新上下文层 `affinity`）。**数值只画条不改语气等于白算** ——
  所以这一层必须接进 pipeline。
- 接口：`GET /api/world/saves/:id/affinity`；SSE `affinity` 事件带 delta/value/mood；
  界面在在场条下面画「关系」条（20/60 有刻度线），下面一行是「谁 · 好感 +3 · 为什么」。
- 交互细节：SSE 的 `done` 一到就解锁输入，不等后面的打分/偷听反应（那两次调用还要 1.5s 左右，
  否则「停」按钮一直亮着，像卡住）。

### 第 5 步：主线 + 情报本（已完成，要点留着备查）

- 表 `quests` / `clues`。**没有做 beats 那套通用条件表**：设计文档自己写了
  「结构化字段比一门小语言划算」，所以章节需求就是两个整数（`required_clues`、
  `required_affinity`），advance 里一眼能看懂，侧栏也能直接显示成「情报 1/2 · 好感 61/60」。
- 示例主线三章写在 `journal.ts` 的 `MAINLINE` 里，`ensureMainline` 懒补：
  老存档（第 5 步之前建的）第一次读侧栏/推进时会自动补上第一章，不留空侧栏。
- 情报从哪来：**好感跨过 60 那一下** —— 取他 secret 的第一句（没有 secret 就取 goal），
  连同这一轮的原话（quote）、第几轮、谁说的，一起进情报本。同样的内容不重复记。
  这正是第 4 步「松口」的落点：没有它，好感与情报本各转各的。
- 接口：`GET /api/world/saves/:id/journal` 一次给全（章号 / 当前章 / 章节列表 / 情报 / 进度）；
  SSE 新增 `clue` 与 `quest` 两帧，界面当场加条、当场换章。
- 界面：三栏（190px 主线 | 现场 | 232px 情报本 + 好感）。情报可点开看原话；
  好感条带 20/60 刻度。窄屏（<1000px）侧栏落到上下。

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
14. **deepseek-flash 是推理模型：`maxTokens` 给紧了正文会是空的**。
    它先写推理再写正文，上限 120 时推理就把 120 吃光，返回 `text: ""` + `finishReason: "length"`。
    短回复（偷听反应那类）别设 `maxTokens`，长度用提示词约束。
15. **PowerShell 的 `Get-Content` / `Set-Content` 会毁掉中文**（第 3 条那个坑真的踩了）：
    这台机器上的 `pwsh` 其实是 Windows PowerShell 5.1，默认按 GBK 读文件，
    反向修复也救不回来（非法字节已经变成 `?`）。批量改文本用 `edit` 工具或 node 脚本。

## 五、风格约束

- 代码里的注释写**原因**（为什么这么定），不写"这是什么"
- 面向用户的文案说人话，不堆术语；出错要说清"为什么、你该怎么办"
- 明确写"不做"的边界（例如不给不在场的人发消息），比多一个功能更重要
- 每步单独提交、单独推库，推完再进下一步
