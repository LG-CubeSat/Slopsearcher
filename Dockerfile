FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN npm install -g @openai/codex@0.159.2
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npx playwright install --with-deps chromium --only-shell && chmod -R a+rX /opt/playwright
RUN mkdir -p /data && chown node:node /data
USER node
ENV DB_PATH=/data/slopsearcher.db GOOGLE_TOKEN_PATH=/data/google-token.json SLOP_CODEX_HOME=/data/codex CODEX_HOME=/data/codex
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD ["node", "dist/cli/health.js"]
CMD ["node", "dist/main.js"]
