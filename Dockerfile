# 多阶段构建：先装依赖并构建前后端，再把产物复制进运行镜像。
# 分两阶段是为了让运行镜像里不带 devDependencies 与源码。

FROM node:24-alpine AS builder
WORKDIR /repo

# pnpm 由 corepack 提供，版本跟随 package.json 的 packageManager
RUN corepack enable

# 先只复制清单文件：依赖没变时这一层可以复用缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# 再复制源码并构建（shared → server → web）
COPY . .
RUN pnpm build

FROM node:24-alpine AS runner
WORKDIR /repo
ENV NODE_ENV=production

RUN corepack enable

# 只带运行需要的东西：清单、产物、依赖
COPY --from=builder /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=builder /repo/packages/shared/package.json packages/shared/
COPY --from=builder /repo/apps/server/package.json apps/server/
COPY --from=builder /repo/apps/web/package.json apps/web/
COPY --from=builder /repo/node_modules node_modules
COPY --from=builder /repo/packages/shared/dist packages/shared/dist
COPY --from=builder /repo/apps/server/dist apps/server/dist
COPY --from=builder /repo/apps/web/dist apps/web/dist
COPY --from=builder /repo/config config

# 数据目录挂卷，容器重建不丢会话与头像
VOLUME ["/repo/data"]
EXPOSE 8787

# 单端口启动：后端同时提供 API 与前端静态资源
CMD ["node", "apps/server/dist/index.js"]
