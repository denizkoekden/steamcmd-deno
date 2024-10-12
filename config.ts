import { LevelName } from "https://deno.land/std@0.196.0/log/mod.ts";
import { load as loadEnv } from "https://deno.land/std@0.196.0/dotenv/mod.ts";

const env = await loadEnv();

// Set environment variables
for (const [key, value] of Object.entries(env)) {
  Deno.env.set(key, value);
}

interface Config {
  PORT: number;
  REDIS_HOST?: string;
  REDIS_PORT?: number;
  REDIS_PASSWORD?: string;
  CACHE_EXPIRATION: number;
  CACHE_ENABLED: boolean;
  LOG_LEVEL: LevelName;
}

const allowedLogLevels: LevelName[] = [
    "NOTSET",
    "DEBUG",
    "INFO",
    "WARNING",
    "ERROR",
    "CRITICAL",
  ];

  const envLogLevel = (Deno.env.get("LOG_LEVEL") || "INFO").toUpperCase() as LevelName;

if (!allowedLogLevels.includes(envLogLevel)) {
  throw new Error(`Invalid LOG_LEVEL: ${envLogLevel}`);
}


const config: Config = {
  PORT: parseInt(Deno.env.get("PORT") || "8000"),
  REDIS_HOST: Deno.env.get("REDIS_HOST"),
  REDIS_PORT: Deno.env.get("REDIS_PORT") ? parseInt(Deno.env.get("REDIS_PORT")!) : undefined,
  REDIS_PASSWORD: Deno.env.get("REDIS_PASSWORD"),
  CACHE_EXPIRATION: parseInt(Deno.env.get("CACHE_EXPIRATION") || "3600"),
  LOG_LEVEL: envLogLevel,
  CACHE_ENABLED: false, // Default to false
};

// Determine if caching is enabled based on Redis configuration
if (config.REDIS_HOST && config.REDIS_PORT) {
  config.CACHE_ENABLED = true;
}

export default config;
