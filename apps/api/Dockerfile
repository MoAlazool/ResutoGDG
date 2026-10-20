# Resuto API + worker image (same image, different command).
# Build from the repository root: docker build -f apps/api/Dockerfile -t resuto-api .
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @resuto/api... \
 && pnpm --filter @resuto/contracts build \
 && pnpm --filter @resuto/integrations build \
 && pnpm --filter @resuto/api build \
 && pnpm --filter @resuto/api deploy --prod --legacy /out

# Production target (no demo data or demo assets): docker build --target production -f apps/api/Dockerfile .
FROM node:22-slim AS production
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
COPY supabase/migrations ./supabase/migrations
COPY scripts/db ./scripts/db
COPY scripts/deploy ./scripts/deploy
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# API: default. Worker: `node dist/worker.js`. Migrations: `node scripts/db/migrate.mjs`.
# Hosted staging: `node scripts/deploy/start-api.mjs` (migrations, then the API; optional demo data).
CMD ["node", "dist/main.js"]

# Staging/demo target (the default, last stage, which Render staging builds): production plus the demo loader and
# the fixtures and media it uploads. The loader refuses NODE_ENV=production; production images use
# --target production and contain none of it (audit PS-27).
FROM production AS staging
USER root
COPY scripts/demo ./scripts/demo
COPY tools/legacy-migration/fixtures/olive-room.legacy-state.json ./tools/legacy-migration/fixtures/olive-room.legacy-state.json
COPY supabase/seeds/olive-room.demo.json ./supabase/seeds/olive-room.demo.json
COPY supabase/seeds/media ./supabase/seeds/media
COPY apps/web/public/brand/olive-interior.webp ./apps/web/public/brand/olive-interior.webp
USER node
