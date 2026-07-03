# First stage: build the Astro static site.
# Astro 6 requires Node >=22 (Node 20 is rejected at build time).
FROM node:22-slim AS builder
WORKDIR /app

ENV CI=true
ENV NX_DAEMON=false

# Copy manifests first so `npm ci` is cached until a package.json changes.
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

COPY . .

# Build Astro directly (not `nx build marketing`) to avoid the
# @geekvetica/nx-astro executor's stdout/stderr maxBuffer overflow.
# Astro's config writes output to ../../dist/apps/marketing.
RUN cd apps/marketing && npx astro build

# Second stage: serve static files with nginx
FROM nginx:alpine
COPY --from=builder /app/dist/apps/marketing /usr/share/nginx/html
COPY marketing-nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
