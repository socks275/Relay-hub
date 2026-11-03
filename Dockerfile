# syntax=docker/dockerfile:1
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    RELAY_LOG_LEVEL=info

WORKDIR /app

# No dependencies to install — copy the app and run it.
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public

# Run unprivileged. The node image already ships a `node` user.
USER node

EXPOSE 3000

# Container-level healthcheck so orchestrators can restart a wedged instance.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
