import { RedisClient } from "./deps.ts";
import { DETA_PROJECT_KEY, DETA_BASE_NAME } from "./config.ts";

let redis = null;
if (env.CACHE_TYPE === "redis") {
  redis = await new RedisClient.connect({
    hostname: env.REDIS_HOST || "127.0.0.1",
    port: Number(env.REDIS_PORT) || 6379,
  });
}

export async function cacheRead(appId: number) {
  if (env.CACHE_TYPE === "redis") {
    const data = await redis.get(appId.toString());
    return data ? JSON.parse(data) : null;
  } else if (DETA_PROJECT_KEY) {
    const res = await fetch(`https://database.deta.sh/v1/${DETA_PROJECT_KEY}/${DETA_BASE_NAME}/items/${appId}`, {
      method: "GET",
      headers: {
        "X-API-Key": DETA_PROJECT_KEY,
      },
    });
    const json = await res.json();
    return json ? json.data : null;
  }
}

export async function cacheWrite(appId: number, data: any) {
  if (env.CACHE_TYPE === "redis") {
    await redis.set(appId.toString(), JSON.stringify(data));
  } else if (DETA_PROJECT_KEY) {
    await fetch(`https://database.deta.sh/v1/${DETA_PROJECT_KEY}/${DETA_BASE_NAME}/items`, {
      method: "PUT",
      headers: {
        "X-API-Key": DETA_PROJECT_KEY,
      },
      body: JSON.stringify({
        key: appId.toString(),
        data,
      }),
    });
  }
}
