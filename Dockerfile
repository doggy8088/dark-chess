# Build stage: bundle the Vite client and the Node game server.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

# Runtime stage: static files + server bundle, production deps only
# (three.js / Rapier are devDependencies — Vite bakes them into dist/).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
EXPOSE 8080
CMD ["node", "dist-server/index.mjs"]
