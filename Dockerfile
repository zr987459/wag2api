FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY src/ ./src/

# 前端 Web 控制台静态资源（server.mjs 会读取 src/web 或 process.env.WEB_DIR）
COPY app/app/src/main/assets/web/ ./src/web/

# 账号与配置保存在 data/，建议挂载持久卷：-v ./data:/app/data
RUN mkdir -p data/accounts

ENV NODE_ENV=production
ENV WEB_DIR=/app/src/web
CMD ["node", "src/server.mjs"]
