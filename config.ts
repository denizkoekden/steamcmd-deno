import { type LevelName } from "@std/log";
import { load as loadEnv } from "@std/dotenv";

interface Config {
  PORT: number;
  REDIS_HOST?: string;
  REDIS_PORT?: number;
  REDIS_PASSWORD?: string;
  CACHE_EXPIRATION: number;
  CACHE_ENABLED: boolean;
  PRELOAD_APP_IDS: number[];
  PRELOAD_USERNAME?: string;
  PRELOAD_PASSWORD?: string;
  LOG_LEVEL: LevelName;
  VERSION: string;
}

const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBoolean = (
  value: string | undefined,
  fallback: boolean,
): boolean => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const parseAppIds = (value: string | undefined): number[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
};

await loadEnv({ export: true });

const allowedLogLevels: LevelName[] = [
  "NOTSET",
  "DEBUG",
  "INFO",
  "WARN",
  "ERROR",
  "CRITICAL",
];

const envLogLevel = (Deno.env.get("LOG_LEVEL") || "INFO")
  .toUpperCase() as LevelName;

if (!allowedLogLevels.includes(envLogLevel)) {
  throw new Error(`Invalid LOG_LEVEL: ${envLogLevel}`);
}

const redisHost = Deno.env.get("REDIS_HOST") || undefined;
const redisPortRaw = Deno.env.get("REDIS_PORT");
const redisPort = redisPortRaw ? Number(redisPortRaw) : undefined;
const redisPortValid = redisPort !== undefined && Number.isFinite(redisPort);
const portFallback = 8000;
const parsedPort = parseNumber(Deno.env.get("PORT"), portFallback);
const safePort = parsedPort > 0 && parsedPort < 65536
  ? parsedPort
  : portFallback;

const cacheTtlFallback = 3600;
const parsedCacheTtl = parseNumber(
  Deno.env.get("CACHE_EXPIRATION"),
  cacheTtlFallback,
);
const safeCacheTtl = parsedCacheTtl > 0 ? parsedCacheTtl : cacheTtlFallback;

const config: Config = {
  PORT: safePort,
  REDIS_HOST: redisHost,
  REDIS_PORT: redisPortValid ? redisPort : undefined,
  REDIS_PASSWORD: Deno.env.get("REDIS_PASSWORD") || undefined,
  CACHE_EXPIRATION: safeCacheTtl,
  LOG_LEVEL: envLogLevel,
  CACHE_ENABLED: false,
  PRELOAD_APP_IDS: parseAppIds(Deno.env.get("CACHE_PRELOAD_APP_IDS")),
  PRELOAD_USERNAME: Deno.env.get("CACHE_PRELOAD_USERNAME") || undefined,
  PRELOAD_PASSWORD: Deno.env.get("CACHE_PRELOAD_PASSWORD") || undefined,
  VERSION: Deno.env.get("APP_VERSION") || "0.0.0-dev",
};

const cacheEnabledFromRedis = Boolean(config.REDIS_HOST && config.REDIS_PORT);
config.CACHE_ENABLED = parseBoolean(
  Deno.env.get("CACHE_ENABLED"),
  cacheEnabledFromRedis,
);

export default config;
