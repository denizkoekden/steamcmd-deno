import { ConsoleHandler, getLogger, type LevelName, setup } from "@std/log";
import config from "./config.ts";

const handlerName = "console";

await setup({
  handlers: {
    [handlerName]: new ConsoleHandler(config.LOG_LEVEL as LevelName),
  },
  loggers: {
    default: {
      level: config.LOG_LEVEL,
      handlers: [handlerName],
    },
    app: {
      level: config.LOG_LEVEL,
      handlers: [handlerName],
    },
    cache: {
      level: config.LOG_LEVEL,
      handlers: [handlerName],
    },
    functions: {
      level: config.LOG_LEVEL,
      handlers: [handlerName],
    },
  },
});

export const log = { getLogger };
