import * as log from "@std/log";
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
    app: {
      level: config.LOG_LEVEL,
      handlers: ["console"],
    },
    cache: {
      level: config.LOG_LEVEL,
      handlers: ["console"],
    },
    functions: {
      level: config.LOG_LEVEL,
      handlers: ["console"],
    },
  },
});

// Export the 'log' object directly
export { log };
