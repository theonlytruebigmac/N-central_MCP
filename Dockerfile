FROM node:25-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src/ ./src/

# Run as non-root.
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

EXPOSE 3100

# Probe /healthz; pass on any non-5xx, fail on connection refused.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||3100)+'/healthz').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "index.js"]
