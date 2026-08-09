FROM alpine:3.21 AS max-certs

RUN apk add --no-cache ca-certificates curl

RUN curl --fail --silent --show-error --location \
      https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt \
      --output /russian_trusted_root_ca.crt \
    && echo "936a43fea6e8e525bcc0f81acd9c3d21b4fc4b9b68acea7906d698005afc6504  /russian_trusted_root_ca.crt" | sha256sum -c - \
    && curl --fail --silent --show-error --location \
      https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt \
      --output /russian_trusted_sub_ca.crt \
    && echo "f0ae589f36774f29ef3648f7984b08d42fcce6f1ffeeb6236d773daeb2744ea6  /russian_trusted_sub_ca.crt" | sha256sum -c -

FROM python:3.13-alpine

RUN apk add --no-cache ca-certificates
COPY --from=max-certs /russian_trusted_root_ca.crt /usr/local/share/ca-certificates/russian_trusted_root_ca.crt
COPY --from=max-certs /russian_trusted_sub_ca.crt /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt
RUN update-ca-certificates

WORKDIR /app
COPY --chown=65534:65534 app.py /app/app.py

ENV PORT=8080 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER 65534:65534
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)"]

CMD ["python", "/app/app.py"]
