import {
    Application,
    Router,
    RouterContext,
  } from "https://deno.land/x/oak@v12.5.0/mod.ts";

import { log } from "./utils.ts";
import config from "./config.ts";
import { cacheRead, cacheWrite } from "./cache.ts";
import { getAppInfo } from "./functions.ts";
import { AppInfo } from "./functions.ts";

console.log('Starting the application...');

const logger = log.getLogger("app");
const app = new Application();
const router = new Router();

console.log('Setting up middleware...');

// Middleware for logging requests and measuring response time
app.use(async (ctx, next) => {
  const start = performance.now();
  await next();
  const ms = performance.now() - start;
  ctx.response.headers.set("X-Response-Time", `${ms.toFixed(2)}ms`);
  logger.info(`${ctx.request.method} ${ctx.request.url} - ${ms.toFixed(2)}ms`);
});

console.log('Setting up routes...');

// Route to get app info
router.get("/v1/info/:appId", async (ctx: RouterContext<"/v1/info/:appId">) => {
  const { appId } = ctx.params;
  let username: string | null = null;
  let password: string | null = null;

  logger.info(`Request received for appId ${appId}`);

  // Check if request has a body and parse it if available
  if (ctx.request.hasBody) {
    const body = ctx.request.body();

    if (body.type === "json") {
      const bodyValue = await body.value;
      username = bodyValue.username || null;
      password = bodyValue.password || null;
    }
  }

  let data: AppInfo | null = null;

  if (config.CACHE_ENABLED) {
    // Check cache
    data = await cacheRead(appId);
    if (data) {
      logger.info(`Returning cached data for appId ${appId}`);
      ctx.response.body = data;
      return;
    }
  }

  // Fetch data from Steam
  try {
    const appInfo = await getAppInfo(Number(appId), username, password);
    if (appInfo) {
      // Cache the data if caching is enabled
      if (config.CACHE_ENABLED) {
        await cacheWrite(appId, appInfo);
      }
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

app.addEventListener('listen', () => {
  logger.info(`Server is running on http://localhost:${config.PORT}`);
  console.log(`Server is running on http://localhost:${config.PORT}`);
});

console.log('Starting to listen on port', config.PORT);

await app.listen({ port: config.PORT });
