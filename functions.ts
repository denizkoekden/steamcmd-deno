import SteamUser from "steam-user";
import { log } from "./utils.ts";

const logger = log.getLogger("functions");

// Throttle Steam calls to avoid hitting login and request rate limits.
const REQUEST_DELAY_MS = Number(
  Deno.env.get("STEAM_REQUEST_DELAY_MS") ?? "0",
);
const THROTTLE_ENABLED = REQUEST_DELAY_MS > 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let requestChain: Promise<unknown> = Promise.resolve();
const enqueueRequest = <T>(fn: () => Promise<T>): Promise<T> => {
  if (!THROTTLE_ENABLED) return fn();

  const run = requestChain.then(fn);
  requestChain = run
    .catch(() => undefined)
    .then(() => sleep(REQUEST_DELAY_MS));
  return run;
};

type CredentialsKey = string;
const clientPromises = new Map<CredentialsKey, Promise<SteamUser>>();

const getClient = (
  username: string,
  password: string,
): Promise<SteamUser> => {
  const mustAuthenticate = Boolean(username && password);
  const key = mustAuthenticate ? `${username}::${password}` : "anonymous";

  const existing = clientPromises.get(key);
  if (existing) return existing;

  const createClient = new Promise<SteamUser>((resolve, reject) => {
    const client = new SteamUser();
    const onLoggedOn = () => {
      client.off("error", onError);
      // Keep a listener for logging future errors on the persistent client.
      client.on("error", (err: Error) => {
        logger.error(
          `Steam client error (${mustAuthenticate ? "auth" : "anon"}): ${
            err?.message ?? err
          }`,
        );
      });
      resolve(client);
    };
    const onError = (err: Error) => {
      client.off("loggedOn", onLoggedOn);
      reject(err);
    };

    client.once("loggedOn", onLoggedOn);
    client.once("error", onError);

    if (mustAuthenticate) {
      logger.debug("Attempting authenticated login...");
      client.logOn({ accountName: username, password });
    } else {
      logger.debug("Attempting anonymous login...");
      client.logOn({ anonymous: true });
    }
  });

  const trackedClient = createClient.catch((err) => {
    clientPromises.delete(key);
    throw err;
  });

  clientPromises.set(key, trackedClient);
  return trackedClient;
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
    const fetchAppInfo = async (client: SteamUser) => {
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
    const client = await getClient(username, password);
    let appInfo = await fetchAppInfo(client);

    if (appInfo && appInfo.missingToken && mustAuthenticate) {
      logger.info(
        `Missing token for appId ${appId}, retrying with anonymous client...`,
      );
      const anonymousClient = await getClient("", "");
      appInfo = await fetchAppInfo(anonymousClient);

      if (appInfo && appInfo.missingToken) {
        logger.warn(
          `App info for appId ${appId} is incomplete, missing token even after anonymous login.`,
        );
      }
    }

    return appInfo;
  });
}
