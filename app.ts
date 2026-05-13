import { Application, Router, type RouterContext } from "@oak/oak";

import config from "./config.ts";
import { cacheRead, cacheWrite, getAuthFlag, setAuthFlag } from "./cache.ts";
import { type AppInfo, buildCredentialsKey, getAppInfo } from "./functions.ts";
import { log } from "./utils.ts";

const logger = log.getLogger("app");
const app = new Application();
const router = new Router();
const inFlight = new Map<string, Promise<AppInfo | null>>();
const preloadAppIds = config.PRELOAD_APP_IDS ?? [];
const preloadUsername = config.PRELOAD_USERNAME ?? "";
const preloadPassword = config.PRELOAD_PASSWORD ?? "";

const parseBasicAuth = (
  header: string | null,
): { username: string; password: string } => {
  if (!header) return { username: "", password: "" };
  const [scheme, encoded] = header.split(" ", 2);
  if (!encoded || scheme.toLowerCase() !== "basic") {
    return { username: "", password: "" };
  }
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return { username: "", password: "" };
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return { username: "", password: "" };
  return {
    username: decoded.slice(0, sep),
    password: decoded.slice(sep + 1),
  };
};

const warmCache = async (
  appIds: number[],
  username: string,
  password: string,
) => {
  if ((username && !password) || (!username && password)) {
    logger.error(
      "Prewarm skipped: provide both CACHE_PRELOAD_USERNAME and CACHE_PRELOAD_PASSWORD or neither.",
    );
    return;
  }

  const hasAuth = Boolean(username && password);

  for (const id of appIds) {
    const idKey = `${id}`;
    try {
      const knownFlag = await getAuthFlag(idKey);
      let info: AppInfo | null = null;
      let source: "anon" | "auth" = "anon";

      if (knownFlag === "auth" && hasAuth) {
        info = await getAppInfo(id, username, password);
        source = "auth";
      } else {
        info = await getAppInfo(id, "", "");
        if (info?.missingToken && hasAuth) {
          logger.info(
            `Prewarm appId ${id}: missingToken on anon, retrying authenticated`,
          );
          const authInfo = await getAppInfo(id, username, password);
          if (authInfo) {
            info = authInfo;
            source = "auth";
          }
        }
        if (info) {
          await setAuthFlag(idKey, info.missingToken ? "auth" : "anon");
        }
      }

      if (info) {
        await cacheWrite(idKey, info);
        const flag = info.missingToken ? ", still missingToken" : "";
        const cached = knownFlag ? `, flag=${knownFlag}` : "";
        logger.info(
          `Prewarmed cache for appId ${id} (${source}${flag}${cached})`,
        );
      } else {
        logger.warn(`Prewarm failed, no app info for appId ${id}`);
      }
    } catch (err) {
      logger.error(`Prewarm failed for appId ${id}: ${err}`);
    }
  }
};

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
  const { username, password } = parseBasicAuth(
    ctx.request.headers.get("authorization"),
  );
  const betaPassword = ctx.request.headers.get("x-steam-beta-password") ||
    ctx.request.url.searchParams.get("beta_password") ||
    "";

  ctx.response.type = "application/json";

  const parsedAppId = Number.parseInt(appId, 10);
  if (!Number.isSafeInteger(parsedAppId) || parsedAppId <= 0) {
    ctx.response.status = 400;
    ctx.response.body = { error: "appId must be a positive integer." };
    return;
  }

  logger.info(
    `Request received for appId ${appId}${
      betaPassword ? " [betaPassword set]" : ""
    }`,
  );

  const credentialsKey = buildCredentialsKey(username, password);
  const inFlightKey = `${appId}::${credentialsKey}::${
    betaPassword ? `beta:${betaPassword}` : "nobeta"
  }`;
  const cacheKey = betaPassword ? `${appId}::beta:${betaPassword}` : appId;

  let data: AppInfo | null = null;

  if (config.CACHE_ENABLED) {
    data = await cacheRead(cacheKey);
    if (data) {
      logger.info(`Returning cached data for appId ${appId}`);
      ctx.response.body = data;
      return;
    }
  }

  try {
    let appInfoPromise = inFlight.get(inFlightKey);
    if (!appInfoPromise) {
      appInfoPromise = getAppInfo(
        parsedAppId,
        username,
        password,
        betaPassword,
      );
      inFlight.set(
        inFlightKey,
        appInfoPromise.finally(() => inFlight.delete(inFlightKey)),
      );
    }

    const appInfo = await appInfoPromise;
    if (appInfo) {
      if (config.CACHE_ENABLED) {
        await cacheWrite(cacheKey, appInfo);
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

app.addEventListener("listen", () => {
  logger.info(`Server is running on http://localhost:${config.PORT}`);
});

if (config.CACHE_ENABLED && preloadAppIds.length > 0) {
  const runPrewarm = () =>
    warmCache(preloadAppIds, preloadUsername, preloadPassword).catch((err) =>
      logger.error(`Cache prewarm failed: ${err}`)
    );

  runPrewarm();

  if (config.PRELOAD_INTERVAL_MS > 0) {
    setInterval(runPrewarm, config.PRELOAD_INTERVAL_MS);
    logger.info(
      `Periodic prewarm scheduled every ${config.PRELOAD_INTERVAL_MS}ms for ${preloadAppIds.length} appId(s)`,
    );
  }
}

await app.listen({ port: config.PORT });
