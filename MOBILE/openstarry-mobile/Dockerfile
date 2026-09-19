FROM node:22-alpine AS builder
WORKDIR /app/SHARED/workbench
COPY SHARED/workbench/package*.json ./
RUN npm ci
COPY SHARED/workbench ./
WORKDIR /app/MOBILE/openstarry-mobile
COPY MOBILE/openstarry-mobile/package*.json ./
RUN npm ci
COPY MOBILE/openstarry-mobile/index.html MOBILE/openstarry-mobile/capacitor.config.json MOBILE/openstarry-mobile/vite.config.js ./
COPY MOBILE/openstarry-mobile/public ./public
COPY MOBILE/openstarry-mobile/src ./src
RUN npm run build

FROM nginx:1.27-alpine
COPY MOBILE/openstarry-mobile/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/MOBILE/openstarry-mobile/dist /usr/share/nginx/html
