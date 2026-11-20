FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=4567 \
    DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 4567
VOLUME ["/data"]
# Follows PORT, HOST and TLS_CERT/TLS_KEY, so overriding them does not mark the container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "server/healthcheck.js"]

CMD ["node", "server/server.js"]
