FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

FROM node:20-alpine AS production
RUN addgroup -g 1001 -S nodejs && adduser -S appuser -u 1001
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=appuser:nodejs server.js package.json ./
COPY --chown=appuser:nodejs public ./public
USER appuser
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "server.js"]
