FROM ghcr.io/ggml-org/llama.cpp:server-cuda12-b10524@sha256:ea610f2c82d033b6765b24fa7c0ab15c267d564f883de7c494f1e3073d496374

LABEL org.opencontainers.image.source="https://github.com/pixelgraple/KREA2-Vision-Suite"

USER root
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       aria2 ca-certificates curl python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages vastai==1.5.5

WORKDIR /opt/krea2
COPY worker.py /opt/krea2/worker.py
COPY start-worker.sh /opt/krea2/start-worker.sh
RUN chmod 0755 /opt/krea2/start-worker.sh

# Vast PyWorker listens on the published worker port. The second port is used
# only by the SDK's internal session-end webhook listener.
ENV WORKER_PORT=3000 \
    WORKER_HTTP_PORT=3001 \
    USE_SSL=false
EXPOSE 3000/tcp 3001/tcp

ENTRYPOINT ["/opt/krea2/start-worker.sh"]
