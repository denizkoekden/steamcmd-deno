FROM denoland/deno:2.5.6

ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=${APP_VERSION}
ENV DENO_DIR=/deno-dir

EXPOSE 8000

WORKDIR /app

COPY deno.json deno.lock deps.ts ./
RUN deno cache --lock=deno.lock --frozen deps.ts

COPY . .
RUN deno cache --reload --lock=deno.lock --frozen app.ts
# Drop any cached artifacts to avoid baking broken npm caches; recreate writable dir for runtime.
RUN rm -rf /app/node_modules "$DENO_DIR" && mkdir -p "$DENO_DIR" && chown deno:deno "$DENO_DIR"

USER deno

CMD ["deno", "task", "start"]
