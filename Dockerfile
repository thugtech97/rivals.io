# Game server (Colyseus) for Fly.io. Build context = repo root, because the server
# imports code from ../shared. The client is deployed separately (Vercel).

FROM node:24-slim

WORKDIR /app

# Install production dependencies first (cached unless package files change)
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

# Then the code
COPY shared ./shared
COPY server ./server

WORKDIR /app/server
ENV NODE_ENV=production
ENV PORT=2567
EXPOSE 2567

CMD ["node", "--import", "tsx", "src/index.ts"]
