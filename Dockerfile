FROM node:22-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY tsconfig.drawsy.json ./
COPY src/drawsy ./src/drawsy
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap ca-certificates \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && pnpm install --prod --frozen-lockfile
RUN npm install -g @openai/codex opencode-ai@1.17.20
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/drawsy-mcp-entrypoint
RUN chmod 755 /usr/local/bin/drawsy-mcp-entrypoint
ENV CODEX_HOME=/app/codex-runtime
ENV DRAWSY_CODEX_PERSISTENT_HOME=/root/.codex-persistent
EXPOSE 3031
ENTRYPOINT ["/usr/local/bin/drawsy-mcp-entrypoint"]
CMD ["pnpm", "start"]
