FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.mjs ./
COPY server ./server
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server
COPY evaluation ./evaluation
COPY package.json ./
USER node
ENV HOST=0.0.0.0
EXPOSE 4173
CMD ["node","server/start.mjs"]
