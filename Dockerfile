# ---------- Stage 1: 取出 NewAPI 稳定版本单二进制 ----------
FROM calciumion/new-api:v1.0.0-rc.45 AS newapi

# ---------- Stage 2: wag2api 运行时（glibc，与 NewAPI 二进制 100% 兼容） ----------
FROM node:20-bookworm-slim

# tini: 作为 PID 1 收割僵尸进程
# ca-certificates: HTTPS 访问上游
# nginx + gettext-base: 轻量前置分流网关（约 4MB，内存占用仅 2MB，隔离 NewAPI 与 wag2api 管理暗门）
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates nginx gettext-base \
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

# 进程守护脚本与分流模板
COPY scripts/entrypoint.sh /app/scripts/entrypoint.sh
COPY scripts/nginx.conf.template /app/scripts/nginx.conf.template
RUN chmod +x /app/scripts/entrypoint.sh

# ---------- 基础环境变量 ----------
ENV GOMEMLIMIT=160MiB \
    WEB_DIR=/app/src/web \
    NODE_ENV=production \
    ENABLE_NEW_API=0

# 默认对外端口 8790（Render 等平台会注入 $PORT 自动覆盖）
EXPOSE 8790

# tini 作为 PID 1 传递信号与收割子进程
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/entrypoint.sh"]
