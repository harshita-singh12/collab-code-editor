# Multi-stage build: compile TypeScript for the whole workspace, then ship
# only the server's production dependencies + compiled JS.
FROM node:20-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/ot-demo/package.json packages/ot-demo/package.json

RUN npm install --workspaces --include-workspace-root

COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/ot-demo packages/ot-demo

RUN npm run build --workspace=packages/shared \
 && npm run build --workspace=packages/server

FROM node:20-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json

RUN npm install --workspace=packages/shared --workspace=packages/server --omit=dev

COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/packages/server/dist packages/server/dist
COPY packages/server/migrations packages/server/migrations

WORKDIR /repo/packages/server
EXPOSE 4000
CMD ["node", "dist/index.js"]
