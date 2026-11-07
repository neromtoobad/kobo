FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run web:build
ENV NODE_ENV=production
EXPOSE 4350
CMD ["npx", "tsx", "app/server.ts"]
