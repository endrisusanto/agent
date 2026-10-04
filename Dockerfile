# Multi-stage build for GBA Agentic Auto Web Hub (Server + Client)
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package manifests
COPY package*.json ./
COPY web-hub/client/package*.json ./web-hub/client/
COPY web-hub/server/package*.json ./web-hub/server/

# Install dependencies
RUN npm install
RUN cd web-hub/client && npm install
RUN cd web-hub/server && npm install

# Copy source files
COPY web-hub ./web-hub

# Build client and server
RUN cd web-hub/client && npm run build
RUN cd web-hub/server && npm run build

# Production runtime stage
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000

COPY package*.json ./
COPY web-hub/server/package*.json ./web-hub/server/
RUN cd web-hub/server && npm install --omit=dev

COPY --from=builder /app/web-hub/server/dist ./web-hub/server/dist
COPY --from=builder /app/web-hub/client/dist ./web-hub/client/dist

EXPOSE 4000

CMD ["node", "web-hub/server/dist/index.js"]
