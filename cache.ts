import { connect, type Redis } from "@redis";
import config from "./config.ts";
import { log } from "./utils.ts";
import { type AppInfo } from "./functions.ts";

const logger = log.getLogger("cache");

let redisClient: Redis | null = null;

export async function getRedisClient(): Promise<Redis | null> {
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

export async function cacheRead(appId: string): Promise<AppInfo | null> {
  if (!config.CACHE_ENABLED) {
    return null;
  }

  try {
    const client = await getRedisClient();
    if (!client) {
      return null;
    }
    const data = await client.get(appId);
    if (!data) {
      logger.info(`Cache miss for appId ${appId}`);
      return null;
    }

    logger.info(`Cache hit for appId ${appId}`);
    try {
      const parsed = JSON.parse(data) as AppInfo;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
      logger.warning(`Invalid cached payload for appId ${appId}`);
      return null;
    } catch (err) {
      logger.error(`Failed to parse cached data for appId ${appId}: ${err}`);
      return null;
    }
  } catch (err) {
    logger.error(`Error reading from Redis: ${err}`);
    return null;
  }
}

export async function cacheWrite(appId: string, data: AppInfo): Promise<void> {
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
