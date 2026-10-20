# Backend container (OPS-01). Paper mode only; credentials and limits come from the environment at run time and are
# never baked into the image. Base pinned by digest (Node 24.21.0, matching package.json engines).
FROM node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY backend ./backend
RUN npm run build

FROM node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production APP_MODE=paper HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/paper
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force \
 && mkdir -p /data && chown node:node /data
COPY --from=build /app/backend/dist/src ./backend/dist/src
COPY db/migrations ./db/migrations
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "backend/dist/src/main.js"]
