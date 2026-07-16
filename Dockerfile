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
RUN npm install -g @openai/codex
COPY --from=build /app/dist ./dist
EXPOSE 3031
CMD ["pnpm", "start"]
