FROM public.ecr.aws/docker/library/node:20-alpine AS frontend-build

WORKDIR /frontend

COPY crm-ui/package*.json ./
RUN npm ci

COPY crm-ui/ ./

ARG VITE_API_BASE=""

ENV VITE_API_BASE=$VITE_API_BASE

RUN npm run build

FROM public.ecr.aws/docker/library/nginx:1.27-alpine

COPY docker/nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /frontend/dist /usr/share/nginx/html

RUN mkdir -p /var/www/static /var/www/media
