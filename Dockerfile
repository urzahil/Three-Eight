FROM node:22-alpine

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
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4567/healthz >/dev/null || exit 1

CMD ["node", "server/server.js"]
