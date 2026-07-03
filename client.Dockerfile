# First stage: build the React SPA
FROM node:20-slim AS builder
WORKDIR /app

ENV CI=true
ENV NX_DAEMON=false

# Vite bakes VITE_* vars into the bundle at build time — declared as build args.
ARG VITE_GRAPHQL_URL
ARG VITE_API_URL
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY

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

# Set VITE_ env after install so value changes don't bust the npm ci layer.
ENV VITE_GRAPHQL_URL=$VITE_GRAPHQL_URL
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY

RUN npx nx run-many --target=build --projects=data,common-components,client --configuration=production --parallel

# Second stage: serve static files with nginx
FROM nginx:alpine
COPY --from=builder /app/apps/client/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
