# ---------- Stage 1: 取出 NewAPI 单二进制 ----------
FROM calciumion/new-api:latest AS newapi

# ---------- Stage 2: wag2api 运行时（glibc，NewAPI 二进制兼容） ----------
FROM node:20-bookworm-slim

# tini: 作为 PID 1 收割僵尸进程；ca-certificates: HTTPS 访问上游
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# NewAPI 单二进制（仅有 /new-api；镜像内其他依赖不需要）
COPY --from=newapi /new-api /app/new-api
RUN chmod +x /app/new-api

# wag2api 代码
COPY package.json ./
COPY src/ ./src/
# 前端 Web 控制台静态资源（server.mjs 读取 src/web 或 $WEB_DIR）
COPY app/app/src/main/assets/web/ ./src/web/

# 持久化目录（建议挂载：-v ./data:/app/data）
RUN mkdir -p data/accounts

# 启动脚本
COPY scripts/entrypoint.sh /app/scripts/entrypoint.sh
RUN chmod +x /app/scripts/entrypoint.sh

# ---------- Hark 架构规范：512MB 容器内存保护 ----------
# Go 软内存上限 160MiB；Node 堆上限 192MiB；两者之和 + 运行时开销 < 512MiB
ENV GOMEMLIMIT=160MiB \
    NODE_OPTIONS="--max-old-space-size=192" \
    WEB_DIR=/app/src/web \
    NODE_ENV=production

# 默认关闭 NewAPI，保持原生 wag2api 行为（向后兼容）
ENV ENABLE_NEW_API=0

# 对外端口（Render 会注入 $PORT 覆盖）
EXPOSE 3000

# tini 作为 PID 1；entrypoint 负责子进程守护
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/entrypoint.sh"]
