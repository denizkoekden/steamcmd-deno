import { env } from "./deps.ts";

export const STEAM_ACCOUNT = env.ACCOUNT_NAME || null;
export const STEAM_PASSWORD = env.PASSWORD || null;
export const CACHE_TYPE = env.CACHE_TYPE || "redis";
export const REDIS_URL = env.REDIS_URL || null;
export const DETA_PROJECT_KEY = env.DETA_PROJECT_KEY || null;
export const DETA_BASE_NAME = env.DETA_BASE_NAME || "steam_cache";
