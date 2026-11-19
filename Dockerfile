FROM node:24.22.3-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY api ./api
COPY frontend ./frontend
COPY shared ./shared
RUN npm run generate:openapi && npm run generate:sdk && npm run build

FROM node:24.22.3-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    CALENDAR_DB_PATH=/app/data/calendar.sqlite
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && install -d -o node -g node /app/data
COPY server ./server
COPY shared ./shared
COPY --from=build /app/frontend/dist ./frontend/dist
USER node
EXPOSE 3000
CMD ["node", "server/index.ts"]
