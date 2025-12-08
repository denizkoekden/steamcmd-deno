import SteamUser from "steam-user";
import { log } from "./utils.ts";

const logger = log.getLogger("functions");

// Throttle Steam calls to avoid hitting login and request rate limits.
const REQUEST_DELAY_MS = Number(
  Deno.env.get("STEAM_REQUEST_DELAY_MS") ?? "0",
);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let requestChain: Promise<unknown> = Promise.resolve();
const enqueueRequest = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = requestChain.then(fn);
  requestChain = run
    .catch(() => undefined)
    .then(() => sleep(REQUEST_DELAY_MS));
  return run;
};

export interface AppInfo {
  appid: number;
  changenumber: number;
  missingToken: boolean;
  appinfo: Record<string, unknown>;
}

const validateAppId = (appId: number) => {
  if (!Number.isSafeInteger(appId) || appId <= 0) {
    logger.error(`Invalid appId provided: ${appId}`);
    throw new Error("appId must be a positive integer.");
  }
};

const validateCredentials = (username: string, password: string) => {
  if (username && typeof username !== "string") {
    logger.error(`Invalid username type: ${typeof username}`);
    throw new Error("Username must be a string.");
  }
  if (password && typeof password !== "string") {
    logger.error(`Invalid password type: ${typeof password}`);
    throw new Error("Password must be a string.");
  }
};

export async function getAppInfo(
  appId: number,
  username: string,
  password: string,
): Promise<AppInfo | null> {
  logger.info(`Started requesting app info for appId ${appId}`);
  validateAppId(appId);
  validateCredentials(username, password);

  return await enqueueRequest(async () => {
    const client = new SteamUser();

    const login = async (anonymous: boolean) => {
      const loginPromise = new Promise<void>((resolve, reject) => {
        client.once("loggedOn", () => {
          logger.debug("Successfully logged in to Steam.");
          resolve();
        });
        client.once("error", (err: Error) => {
          if (err.message === "LogonSessionReplaced") {
            logger.debug(
              "LogonSessionReplaced: Current session was replaced by a new one.",
            );
            resolve();
            return;
          }
          reject(err);
        });
      });

      if (anonymous) {
        logger.debug("Attempting anonymous login...");
        client.logOn({ anonymous: true });
      } else {
        logger.debug("Attempting authenticated login...");
        client.logOn({ accountName: username, password });
      }

      await loginPromise;
    };

    const fetchAppInfo = async () => {
      logger.info(`Fetching product info for appId ${appId}`);
      const data = await client.getProductInfo([appId], [], true);

      if (!data || typeof data !== "object") {
        logger.error("Invalid response received from getProductInfo.");
        throw new Error("Unexpected response format.");
      }

      logger.debug(`Raw product info: ${JSON.stringify(data)}`);

      if (data.apps && data.apps[appId]) {
        logger.info(`Successfully retrieved app info for appId ${appId}`);
        return data.apps[appId] as AppInfo;
      }

      logger.warn(`No app info found for appId ${appId}`);
      return null;
    };

    const mustAuthenticate = Boolean(username && password);
    const waitForDisconnect = () =>
      new Promise<void>((resolve) =>
        client.once("disconnected", () => resolve())
      );
    const listenForErrors = () => {
      const handler = (err: Error) => {
        logger.error(`Steam client error: ${err?.message ?? err}`);
      };
      client.on("error", handler);
      return () => client.off("error", handler);
    };

    const unlisten = listenForErrors();
    try {
      await login(!mustAuthenticate);
      let appInfo = await fetchAppInfo();

      if (appInfo && appInfo.missingToken && mustAuthenticate) {
        logger.info(
          `Missing token for appId ${appId}, retrying with anonymous login...`,
        );
        client.logOff();
        await waitForDisconnect();
        await login(true);
        appInfo = await fetchAppInfo();

        if (appInfo && appInfo.missingToken) {
          logger.warn(
            `App info for appId ${appId} is incomplete, missing token even after anonymous login.`,
          );
        }
      }

      return appInfo;
    } finally {
      unlisten();
      client.logOff();
    }
  });
}
