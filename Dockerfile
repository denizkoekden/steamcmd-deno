FROM denoland/deno:2.5.6

ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=${APP_VERSION}

EXPOSE 8000

WORKDIR /app

COPY deno.json deno.lock deps.ts ./
RUN deno cache --lock=deno.lock --frozen deps.ts

COPY . .
RUN deno cache --lock=deno.lock --frozen app.ts
RUN rm -rf /app/node_modules

USER deno

CMD ["deno", "task", "start"]
