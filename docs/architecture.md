# 架构说明

本文只讲「为什么这样搭」和「改哪里会牵动哪里」。字段级细节请看 `apps/server/src/config/schema.ts`
与 `packages/shared/src/contracts/`。

---

## 一、整体形状

```
┌───────────────────────────────────────────────┐
│  浏览器                                          │
│  Vue3 + Pinia + Vue Router + Naive UI          │
└───────────────┬───────────────────────────────┘
                │  /api/*  （开发期 Vite 代理，生产期同源）
┌───────────────▼───────────────────────────────┐
│  Fastify 应用（apps/server）                     │
│                                                 │
│  onRequest → 路由 → 处理 → 信封 → onResponse 日志 │
│       │                                         │
│       ├── app.config        （已校验配置）        │
│       ├── app.extensions    （扩展点注册表）       │
│       └── webDist           （前端产物，可选）     │
└───────────────────────────────────────────────┘
                │
        config/*.yaml + 环境变量 → zod 校验 → 只读快照
```

单仓三包：

| 包 | 职责 | 不做什么 |
|---|---|---|
| `packages/shared` | zod schema、类型、常量（唯一事实源） | 不含任何 IO、不依赖 Node/浏览器 API |
| `apps/server` | HTTP 接口、配置、扩展点生命周期 | 不直接暴露第三方库的返回结构给前端 |
| `apps/web` | 渲染与交互 | 不猜字段（一律用共享 schema 校验后使用） |

---

## 二、一次请求的生命周期

以 `/api/health` 为例（生产形态，由后端托管前端）：

1. 浏览器 `GET /api/health`
2. @fastify/static 的 `/*` 路由先匹配，但 `/api/health` 有显式路由，优先级更高 → 交给路由处理函数
3. `genReqId` 生成 UUID 作为 `request.id`（同时是响应里的 `traceId`）
4. 处理函数组装载荷：`app.config`（配置）+ `app.extensions.summary()`（扩展点统计）+ 运行时信息
5. 返回 `success(request.id, payload)` → 统一信封 `{ ok, traceId, data }`
6. `onResponse` 钩子打一条日志：method / url / statusCode / durationMs / reqId
7. 前端 `apiGet()` 拆信封；`HealthPayloadSchema.parse()` 再校验一次；写入 Pinia → 页面渲染

任何一步抛错都会进 `setErrorHandler`：

- `AppError` → 用它自己的 statusCode 与 code
- Fastify schema 校验失败 → 422 `VALIDATION_FAILED`（带字段明细）
- 其他未知异常 → 500 `INTERNAL_ERROR`，真实堆栈只进日志，响应体不带

> 关键取舍：错误响应里永远不含内部细节。一个 SQL 报错可能带表名与路径，泄给前端没有收益。

---

## 三、后端分层

```
src/
├── app.ts              组装：装饰依赖、挂路由、挂钩子；不 listen
├── index.ts            入口：加载配置 → buildApp → listen → 信号处理
├── config/             schema.ts（权威定义） loader.ts（合并 + 校验 + 来源追踪）
├── core/extension/     types.ts（契约） errors.ts（错误码） registry.ts（生命周期）
├── http/
│   ├── errors.ts       AppError + toAppError（异常归一）
│   ├── envelope.ts     success() / failure()
│   ├── static.ts       静态托管、SPA 回落、缓存策略
│   └── routes/         health.ts、index.ts（总装）
├── lib/                logger.ts（含脱敏）、runtime.ts（启动时刻/内存）
└── types/fastify.ts    AppInstance 类型 + decorate 的模块声明
```

依赖方向是单向的：`routes → http → lib/types`，`core` 不依赖 `http`。
`app.ts` 是唯一的「接线处」，所以看它就知道应用由哪些零件组成。

### 为什么 buildApp 不 listen

测试用 `app.inject()` 直接打内存请求，不占端口、不受本机端口占用影响。
listen 只在 `index.ts` 里发生一次，进程边界（信号、退出码）也集中在那里。

### 为什么用 decorate 而不是层层传参

`config`、`extensions`、`configSources` 会被大量路由用到。全部放进函数参数会让每个
`registerXxxRoutes` 长出一个巨大的 deps 对象；decorate + 模块声明后，任何地方
`app.config.server.port` 都直接可用且有类型。

声明集中在 `src/types/fastify.ts`，加一个装饰器只改一处。

---

## 四、扩展点体系

目标：后续的模型接入、上下文组装、持久化都用「注册一个扩展」的方式接进来，核心代码不再改动。

### 五类扩展

| kind | 典型实现 | 依赖谁 |
|---|---|---|
| `provider` | OpenAI 兼容、Claude、本地 llama.cpp | 无（最底层） |
| `context` | 分层拼装、世界书注入、摘要压缩 | provider |
| `storage` | SQLite、JSON 文件、内存 | 无 |
| `route` | 把一整块功能的路由挂进来 | 任意 |
| `integration` | TTS、图片生成、WebDAV 备份 | 任意 |

### 生命周期

```
registered ──setup──▶ ready ──dispose──▶ disposed
     │                  ▲
     └──setup 失败──▶ failed ──dispose──▶ disposed
```

规则（都有用例守着）：

- **顺序**：`priority` 降序初始化；`dispose` 逆序执行 —— 后启动的可能依赖先启动的
- **隔离**：单个扩展初始化失败不中断启动（`extensions.strict: true` 时才中断）。
  某个 provider 的 Key 填错，不该导致整个应用打不开
- **子扩展**：`setup` 内可以继续注册扩展，用「多轮初始化 + 轮次上限」兜住，防止写错成死循环
- **批量原子性**：`register(a, b)` 里只要有一个不合法，整批都不注册，不留半截状态
- **拒绝野路子**：已 ready 的扩展不允许直接注销，必须先 dispose，避免连接/定时器泄漏

### 扩展能看到什么

只有 `ExtensionContext`：logger、env、appVersion、features 快照、registry 本身。
**不暴露 Fastify 实例和数据库连接** —— 否则扩展之间会通过全局对象隐式耦合，想替换其中一个就得读全部代码。

---

## 五、配置管线

```
内置默认值（schema defaults）
      ↓ deep merge
config/default.yaml      （出厂设置，随代码提交）
      ↓ deep merge
config/user.yaml         （个人设置，gitignore）
      ↓ deep merge
环境变量                  （TAVERN_ 前缀 + __ 分隔，最后压过一切）
      ↓ AppConfigSchema.safeParse
只读 AppConfig + 来源清单（sources / overrides）
```

设计要点：

- **schema 是唯一权威**：`z.strictObject` 让拼错的字段直接报错，而不是被静默忽略后
  「怎么改了配置没生效」
- **段默认值靠 schema 自己算**：`zod .default()` 要求传完整值，手写一遍必然漂移，
  所以用 `sectionDefaults(schema) = () => schema.parse({})`
- **默认值与 yaml 的一致性由测试保证**：`loader.test.ts` 里有一条「default.yaml 解析结果
  必须等于 `createDefaultConfig()`」，任何一边改动都会红
- **来源可追踪**：`sources`（读了哪些文件）与 `overrides`（哪些环境变量生效了）会进启动日志
  与 `/api/health`，排查「线上为什么和本地不一样」时不用猜
- **环境变量还原类型**：`'8787'` → 数字、`'true'` → 布尔、`'[..]'` → 数组，解析不了才保留字符串

---

## 六、契约共享

`packages/shared` 导出 zod schema 与由它推导的类型：

```ts
// 后端：构造时受类型约束，字段漏写直接编译不过
const payload: HealthPayload = { … };

// 前端：运行时再校验一次，后端改字段会立刻暴露，而不是渲染出 undefined
return HealthPayloadSchema.parse(raw);
```

`shared` 以 `tsc` 产物（`dist`）对外导出，`prepare` 钩子保证 `pnpm install` 后依赖方就能解析到。
之所以不直接导出 `src/*.ts`：那样 `tsc` 编译出的后端代码会 `import` 一个 `.ts` 文件，
线上 Node 跑不起来。

前端（Vite）与后端（tsx）都用「不带扩展名 / 带 `.js`」各自的习惯写法，互不影响。

---

## 七、启动与关闭时序

```
loadConfig()                     ← 配置错在这里就退出（exit 1）
createLogger()                   ← 按配置建 pino（含密钥脱敏）
buildApp()                       ← decorate 依赖 → 挂路由 → 挂钩子
  ├─ register(cors)
  ├─ decorate config / configSources / configOverrides / webDist / extensions
  ├─ registerRoutes()
  └─ addHook onReady / onClose   ← 扩展点 setup / dispose
listen(host, port)
installProcessGuards()           ← SIGINT/SIGTERM/uncaughtException
```

关闭时：`SIGINT`/`SIGTERM` → `app.close()`（触发 `onClose` → 扩展逆序 dispose）→ 退出。
超过 10 秒没关完就强制退出，避免容器里卡住。清理顺序是「先停流量，再释放资源」。

---

## 八、关键取舍

**1. 不用 ORM（下一阶段）**
`better-sqlite3` + 手写 DAO。理由是 sqlite 的查询模式简单、SQL 可读性高，
而且这一层要支撑 5000 行量级的自有代码；ORM 的抽象成本此时高于收益。

**2. 后端用 NodeNext + `.js` 后缀**
`tsc` 产物直接 `node dist/index.js` 可跑，不引入 bundler。代价是源码里 import 要写 `.js`，
换来的是「编译产物 = 运行产物」，没有隐藏的转译魔法。

**3. 后端也托管前端**
`pnpm build && pnpm start` 只开一个端口就能用，部署与演示都省一步。
开发期仍用 5173（有 HMR），两者互不干扰。

**4. 日志里做字段遮罩**
`apiKey`、`authorization`、`token`、`cookie` 在 pino 层统一 `[redacted]`。
酒馆类应用的核心资产就是用户的密钥与私密对话，指望每个调用点记得脱敏迟早出事。

**5. 健康检查按项聚合**
每项检查独立 try/catch 并计时，单项失败标 `degraded` 而不是整体 500。
这样「哪个依赖坏了」一眼可见，而不是只知道服务不健康。

---

## 九、下一阶段

阶段 2「模型接入层」将落地：
provider 扩展接口 → OpenAI 兼容实现（含 SSE 流式）→ baseURL / 采样参数 → Key 加密存储 → 用量统计与重试。

扩展点体系的接口（`core/extension`）、配置段的扩展方式（`config/schema.ts`）、
契约的共享方式（`packages/shared`）都已就位，不需要再动核心代码。
