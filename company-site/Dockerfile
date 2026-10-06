ARG LIBRARY_REGISTRY=public.ecr.aws/docker/library
FROM ${LIBRARY_REGISTRY}/nginx:1.27-alpine

COPY . /usr/share/nginx/html

# SCP can preserve restrictive Windows-created directory modes. Normalize all
# static assets so the unprivileged nginx worker can traverse new sections.
RUN chmod -R a+rX /usr/share/nginx/html

HEALTHCHECK --interval=15s --timeout=5s --retries=10 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
