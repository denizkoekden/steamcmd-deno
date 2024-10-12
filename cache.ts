// cache.ts
import { connect } from "https://deno.land/x/redis@v0.29.3/mod.ts";
import config from "./config.ts";
import { getLogger } from "./utils.ts";
const logger = getLogger("cache");

let redisClient: any = null;

export async function getRedisClient() {
  if (!config.CACHE_ENABLED) {
    return null;
  }

  if (!redisClient) {
    try {
      redisClient = await connect({
        hostname: config.REDIS_HOST!,
        port: config.REDIS_PORT!,
        password: config.REDIS_PASSWORD,
      });
      logger.info("Connected to Redis");
    } catch (err) {
      logger.error(`Failed to connect to Redis: ${err}`);
      // Disable caching if connection fails
      config.CACHE_ENABLED = false;
      redisClient = null;
    }
  }
  return redisClient;
}

export async function cacheRead(appId: string): Promise<any | null> {
  if (!config.CACHE_ENABLED) {
    return null;
  }

  try {
    const client = await getRedisClient();
    if (!client) {
      return null;
    }
    const data = await client.get(appId);
    if (data) {
      logger.info(`Cache hit for appId ${appId}`);
      return JSON.parse(data);
    } else {
      logger.info(`Cache miss for appId ${appId}`);
      return null;
    }
  } catch (err) {
    logger.error(`Error reading from Redis: ${err}`);
    return null;
  }
}

export async function cacheWrite(appId: string, data: any): Promise<void> {
  if (!config.CACHE_ENABLED) {
    return;
  }

  try {
    const client = await getRedisClient();
    if (!client) {
      return;
    }
    await client.set(appId, JSON.stringify(data), {
      ex: config.CACHE_EXPIRATION,
    });
    logger.info(`Cached data for appId ${appId}`);
  } catch (err) {
    logger.error(`Error writing to Redis: ${err}`);
  }
}
