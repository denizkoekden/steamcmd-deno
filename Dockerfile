FROM denoland/deno:2.5.6

ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=${APP_VERSION}
ENV DENO_DIR=/deno-dir
ENV STEAMCMD_PATH=/opt/steamcmd/steamcmd.sh
ENV HOME=/home/deno

EXPOSE 8000

USER root

# Install steamcmd (32-bit) so the Deno API can resolve private/beta branches.
# Steam requires CMsgClientPICSPrivateBetaRequest for hidden branch metadata
# since Nov 2024, which node-steam-user does not implement — steamcmd does.
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        lib32gcc-s1 \
        libstdc++6:i386 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/steamcmd ${HOME} \
 && curl -fsSL https://media.steampowered.com/installer/steamcmd_linux.tar.gz \
        | tar -xz -C /opt/steamcmd \
 && chown -R deno:deno /opt/steamcmd ${HOME}

USER deno

# Trigger steamcmd's first-run self-update during build so the runtime call
# doesn't pay that cost on the first request. Ignore failures — the binary may
# legitimately exit non-zero before the update completes.
RUN ${STEAMCMD_PATH} +quit || true

WORKDIR /app

USER root
COPY deno.json deno.lock deps.ts ./
RUN deno cache --lock=deno.lock --frozen deps.ts

COPY . .
RUN deno cache --reload --lock=deno.lock --frozen app.ts
# Drop any cached artifacts to avoid baking broken npm caches; recreate writable dir for runtime.
RUN rm -rf /app/node_modules "$DENO_DIR" && mkdir -p "$DENO_DIR" && chown deno:deno "$DENO_DIR"

USER deno

CMD ["deno", "task", "start"]
