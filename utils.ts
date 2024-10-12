import * as log from "https://deno.land/std@0.196.0/log/mod.ts";
import config from "./config.ts";

await log.setup({
  handlers: {
    console: new log.handlers.ConsoleHandler(config.LOG_LEVEL),
  },
  loggers: {
    default: {
      level: config.LOG_LEVEL,
      handlers: ["console"],
    },
  },
});

// Export the 'log' object directly
export { log };
