# ResutoMCP server image. Build from the repository root:
#   docker build -f apps/mcp-server/Dockerfile -t resuto-mcp .
# Run behind an HTTPS reverse proxy / load balancer:
#   docker run -p 7100:7100 -e RESUTO_API_URL=https://api.example.com \
#     -e MCP_PUBLIC_URL=https://mcp.example.com resuto-mcp
# The image holds no secrets and no database access: each request carries the
# client's rmcp_ key, which the Resuto API validates.

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @resuto/mcp-server... \
 && pnpm --filter @resuto/mcp-server build \
 && pnpm --filter @resuto/mcp-server deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=7100
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/mcp-server/dist ./dist
USER node
EXPOSE 7100
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:7100/health >/dev/null || exit 1
CMD ["node", "dist/main.js"]
