# syntax = docker/dockerfile:1
ARG NODE_VERSION=20

########## build ##########
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app

ENV CI=true
ENV NX_DAEMON=false

# Copy manifests first so `npm ci` is cached until a package.json changes.
# npm workspaces needs every workspace package.json present at install time.
COPY package.json package-lock.json ./
COPY apps/api/package.json                    apps/api/package.json
COPY apps/client/package.json                 apps/client/package.json
COPY apps/client-e2e/package.json             apps/client-e2e/package.json
COPY apps/super-admin-portal/package.json     apps/super-admin-portal/package.json
COPY apps/super-admin-portal-e2e/package.json apps/super-admin-portal-e2e/package.json
COPY apps/marketing/package.json              apps/marketing/package.json
COPY libs/common-components/package.json      libs/common-components/package.json
COPY libs/data/package.json                   libs/data/package.json

RUN npm ci --no-audit --no-fund

# Copy the rest of the monorepo and build the API.
COPY . .
RUN npx nx build api --configuration=production

# Emit a self-contained dist: pruned package.json + lockfile + workspace_modules.
RUN npx nx run api:prune

########## runtime ##########
FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# apps/api/dist now contains main.js, a pruned package.json/lock, and
# workspace_modules for any linked libs — a standalone deployable.
COPY --from=build /app/apps/api/dist ./

RUN npm ci --omit=dev --no-audit --no-fund

EXPOSE 8080
CMD ["node", "main.js"]
