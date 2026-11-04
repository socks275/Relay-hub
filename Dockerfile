# Pine — single-container deployment.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first for layer caching. The proxy bundles are served from
# node_modules at runtime, so production deps must be installed in full.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

USER node
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
