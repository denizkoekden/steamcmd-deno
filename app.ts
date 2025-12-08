import { Application, Router, type RouterContext } from "@oak/oak";

import config from "./config.ts";
import { cacheRead, cacheWrite } from "./cache.ts";
import { type AppInfo, getAppInfo } from "./functions.ts";
import { log } from "./utils.ts";

const logger = log.getLogger("app");
const app = new Application();
const router = new Router();
const inFlight = new Map<string, Promise<AppInfo | null>>();
const preloadAppIds = config.PRELOAD_APP_IDS ?? [];
const preloadUsername = config.PRELOAD_USERNAME ?? "";
const preloadPassword = config.PRELOAD_PASSWORD ?? "";

const warmCache = async (
  appIds: number[],
  username: string,
  password: string,
) => {
  if ((username && !password) || (!username && password)) {
    logger.error("Prewarm skipped: provide both CACHE_PRELOAD_USERNAME and CACHE_PRELOAD_PASSWORD or neither.");
    return;
  }

  for (const id of appIds) {
    try {
      const info = await getAppInfo(id, username, password);
      if (info) {
        await cacheWrite(`${id}`, info);
        logger.info(`Prewarmed cache for appId ${id}`);
      } else {
        logger.warn(`Prewarm failed, no app info for appId ${id}`);
      }
    } catch (err) {
      logger.error(`Prewarm failed for appId ${id}: ${err}`);
    }
  }
};

// Middleware for logging requests and measuring response time
app.use(async (ctx, next) => {
  const start = performance.now();
  await next();
  const ms = performance.now() - start;
  ctx.response.headers.set("X-Response-Time", `${ms.toFixed(2)}ms`);
  logger.info(`${ctx.request.method} ${ctx.request.url} - ${ms.toFixed(2)}ms`);
});

router.get("/v1/version", (ctx) => {
  ctx.response.type = "application/json";
  ctx.response.body = { version: config.VERSION };
});

router.get("/v1/info/:appId", async (ctx: RouterContext<"/v1/info/:appId">) => {
  const { appId } = ctx.params;
  const username = ctx.request.headers.get("username") ?? "";
  const password = ctx.request.headers.get("password") ?? "";

  ctx.response.type = "application/json";

  const parsedAppId = Number.parseInt(appId, 10);
  if (!Number.isSafeInteger(parsedAppId) || parsedAppId <= 0) {
    ctx.response.status = 400;
    ctx.response.body = { error: "appId must be a positive integer." };
    return;
  }

  if ((username && !password) || (!username && password)) {
    ctx.response.status = 400;
    ctx.response.body = {
      error: "Provide both username and password or neither.",
    };
    return;
  }

  logger.info(`Request received for appId ${appId}`);

  let data: AppInfo | null = null;

  if (config.CACHE_ENABLED) {
    data = await cacheRead(appId);
    if (data) {
      logger.info(`Returning cached data for appId ${appId}`);
      ctx.response.type = "application/json";
      ctx.response.body = data;
      return;
    }
  }

  try {
    let appInfoPromise = inFlight.get(appId);
    if (!appInfoPromise) {
      appInfoPromise = getAppInfo(parsedAppId, username, password);
      inFlight.set(appId, appInfoPromise.finally(() => inFlight.delete(appId)));
    }

    const appInfo = await appInfoPromise;
    if (appInfo) {
      if (config.CACHE_ENABLED) {
        await cacheWrite(appId, appInfo);
      }
      ctx.response.type = "application/json";
      ctx.response.body = appInfo;
    } else {
      ctx.response.status = 404;
      ctx.response.body = { error: `App with ID ${appId} not found` };
    }
  } catch (err) {
    logger.error(`Error processing request for appId ${appId}: ${err}`);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal Server Error" };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

app.addEventListener("listen", () => {
  logger.info(`Server is running on http://localhost:${config.PORT}`);
});

if (config.CACHE_ENABLED && preloadAppIds.length > 0) {
  warmCache(preloadAppIds, preloadUsername, preloadPassword).catch((err) =>
    logger.error(`Cache prewarm failed: ${err}`)
  );
}

await app.listen({ port: config.PORT });
