FROM public.ecr.aws/docker/library/nginx:1.27-alpine

COPY . /usr/share/nginx/html

HEALTHCHECK --interval=15s --timeout=5s --retries=10 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

