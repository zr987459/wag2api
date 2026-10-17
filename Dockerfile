FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY src/ ./src/

# 账号与配置保存在 data/，建议挂载持久卷：-v ./data:/app/data
RUN mkdir -p data/accounts

ENV NODE_ENV=production
CMD ["node", "src/server.mjs"]
