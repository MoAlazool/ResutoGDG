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

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
COPY supabase/migrations ./supabase/migrations
COPY scripts/db ./scripts/db
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# API: default. Worker: `node dist/worker.js`. Migrations: `node scripts/db/migrate.mjs`.
CMD ["node", "dist/main.js"]
