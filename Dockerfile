# ---------- Stage 1: 取出 NewAPI 稳定版本单二进制 ----------
FROM calciumion/new-api:0.4.3 AS newapi

# ---------- Stage 2: wag2api 运行时（glibc，与 NewAPI 二进制 100% 兼容） ----------
FROM node:20-bookworm-slim

# tini: 作为 PID 1 收割僵尸进程；ca-certificates: HTTPS 访问上游
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# NewAPI 单二进制（从 builder 复制）
COPY --from=newapi /new-api /app/new-api
RUN chmod +x /app/new-api

# wag2api 代码与静态资产
COPY package.json ./
COPY src/ ./src/
COPY app/app/src/main/assets/web/ ./src/web/

# 持久化目录预建
RUN mkdir -p data/accounts

# 进程守护脚本
COPY scripts/entrypoint.sh /app/scripts/entrypoint.sh
RUN chmod +x /app/scripts/entrypoint.sh

# ---------- Hark 架构规范：512MB 容器严格内存预算 ----------
# Go 软内存上限 160MiB；Node 堆上限 192MiB；两者总和控制在 350MiB 内，安全留足 160MiB 系统余量
ENV GOMEMLIMIT=160MiB \
    NODE_OPTIONS="--max-old-space-size=192" \
    WEB_DIR=/app/src/web \
    NODE_ENV=production \
    ENABLE_NEW_API=0

# 默认对外端口 8790（Render 等平台会注入 $PORT 自动覆盖）
EXPOSE 8790

# tini 作为 PID 1 传递信号与收割子进程
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/entrypoint.sh"]
