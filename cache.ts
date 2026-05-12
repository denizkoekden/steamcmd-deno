import { connect, type Redis } from "@redis";
import config from "./config.ts";
import { log } from "./utils.ts";
import { type AppInfo } from "./functions.ts";

const logger = log.getLogger("cache");

let redisClient: Redis | null = null;
let pendingConnect: Promise<Redis | null> | null = null;
let nextRetryAt = 0;
const RETRY_BACKOFF_MS = 5000;
const AUTH_FLAG_PREFIX = "auth:";
const AUTH_FLAG_TTL_SECONDS = 86400;

export type AuthFlag = "anon" | "auth";

const tryConnect = async (): Promise<Redis | null> => {
  try {
    const client = await connect({
      hostname: config.REDIS_HOST!,
      port: config.REDIS_PORT!,
      password: config.REDIS_PASSWORD,
    });
    logger.info("Connected to Redis");
    redisClient = client;
    nextRetryAt = 0;
    return client;
  } catch (err) {
    logger.error(`Failed to connect to Redis: ${err}`);
    nextRetryAt = Date.now() + RETRY_BACKOFF_MS;
    return null;
  } finally {
    pendingConnect = null;
  }
};

export async function getRedisClient(): Promise<Redis | null> {
  if (!config.CACHE_ENABLED) return null;
  if (redisClient) return redisClient;
  if (Date.now() < nextRetryAt) return null;
  if (!pendingConnect) pendingConnect = tryConnect();
  return await pendingConnect;
}

const invalidateClient = (err: unknown) => {
  logger.error(`Redis operation failed, dropping client: ${err}`);
  try {
    redisClient?.close();
  } catch (_) {
    // ignore
  }
  redisClient = null;
  nextRetryAt = Date.now() + RETRY_BACKOFF_MS;
};

export async function cacheRead(appId: string): Promise<AppInfo | null> {
  if (!config.CACHE_ENABLED) return null;

  const client = await getRedisClient();
  if (!client) return null;

  let data: string | null;
  try {
    data = await client.get(appId);
  } catch (err) {
    invalidateClient(err);
    return null;
  }

  if (!data) {
    logger.info(`Cache miss for appId ${appId}`);
    return null;
  }

  logger.info(`Cache hit for appId ${appId}`);
  try {
    const parsed = JSON.parse(data) as AppInfo;
    if (parsed && typeof parsed === "object") return parsed;
    logger.warn(`Invalid cached payload for appId ${appId}`);
    return null;
  } catch (err) {
    logger.error(`Failed to parse cached data for appId ${appId}: ${err}`);
    return null;
  }
}

export async function cacheWrite(appId: string, data: AppInfo): Promise<void> {
  if (!config.CACHE_ENABLED) return;

  const client = await getRedisClient();
  if (!client) return;

  try {
    await client.set(appId, JSON.stringify(data), {
      ex: config.CACHE_EXPIRATION,
    });
    logger.info(`Cached data for appId ${appId}`);
  } catch (err) {
    invalidateClient(err);
  }
}

export async function getAuthFlag(appId: string): Promise<AuthFlag | null> {
  if (!config.CACHE_ENABLED) return null;
  const client = await getRedisClient();
  if (!client) return null;
  try {
    const value = await client.get(AUTH_FLAG_PREFIX + appId);
    return value === "anon" || value === "auth" ? value : null;
  } catch (err) {
    invalidateClient(err);
    return null;
  }
}

export async function setAuthFlag(
  appId: string,
  flag: AuthFlag,
): Promise<void> {
  if (!config.CACHE_ENABLED) return;
  const client = await getRedisClient();
  if (!client) return;
  try {
    await client.set(AUTH_FLAG_PREFIX + appId, flag, {
      ex: AUTH_FLAG_TTL_SECONDS,
    });
  } catch (err) {
    invalidateClient(err);
  }
}
