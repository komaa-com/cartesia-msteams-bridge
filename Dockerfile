# build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# runtime stage
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8080
# healthcheck against the bridge's /healthz endpoint
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-8080}/healthz || exit 1
USER node
CMD ["node", "dist/cli.js"]
