import SteamUser from "steam-user";
import config from "./config.ts";
import { log } from "./utils.ts";

const logger = log.getLogger("functions");

const REQUEST_DELAY_MS = config.STEAM_REQUEST_DELAY_MS;
const REQUEST_TIMEOUT_MS = config.STEAM_REQUEST_TIMEOUT_MS;
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

const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

type CredentialsKey = string;
const clientPromises = new Map<CredentialsKey, Promise<SteamUser>>();

export const buildCredentialsKey = (
  username: string,
  password: string,
): CredentialsKey =>
  username && password ? `${username}::${password}` : "anonymous";

const getClient = (
  username: string,
  password: string,
): Promise<SteamUser> => {
  const mustAuthenticate = Boolean(username && password);
  const key = buildCredentialsKey(username, password);

  const existing = clientPromises.get(key);
  if (existing) return existing;

  const createClient = new Promise<SteamUser>((resolve, reject) => {
    const client = new SteamUser();

    const evict = (reason: string) => {
      const tracked = clientPromises.get(key);
      if (tracked) {
        clientPromises.delete(key);
        logger.warn(
          `Evicted Steam client (${
            mustAuthenticate ? "auth" : "anon"
          }): ${reason}`,
        );
      }
      try {
        client.logOff();
      } catch (_) {
        // ignore — client may already be torn down
      }
    };

    const onLoggedOn = () => {
      client.off("error", onError);
      client.on("error", (err: Error) => {
        evict(`error: ${err?.message ?? err}`);
      });
      client.on("disconnected", (eresult: number, msg?: string) => {
        evict(`disconnected (eresult=${eresult}${msg ? `, ${msg}` : ""})`);
      });
      resolve(client);
    };
    const onError = (err: Error) => {
      client.off("loggedOn", onLoggedOn);
      clientPromises.delete(key);
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

  clientPromises.set(key, createClient);
  return createClient;
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

export async function getAppInfo(
  appId: number,
  username: string,
  password: string,
  betaPassword = "",
  betaBranch = "",
): Promise<AppInfo | null> {
  validateAppId(appId);

  const hasBeta = Boolean(betaPassword && betaBranch);
  logger.info(
    `Started requesting app info for appId ${appId}${
      hasBeta ? ` [branch=${betaBranch} betaPassword set]` : ""
    }`,
  );

  return await enqueueRequest(async () => {
    const client = await getClient(username, password);
    logger.info(`Fetching product info for appId ${appId}`);

    const data = await withTimeout(
      client.getProductInfo([appId], [], true),
      REQUEST_TIMEOUT_MS,
      `getProductInfo(${appId})`,
    ) as { apps?: Record<number, AppInfo> } | undefined;

    if (!data || typeof data !== "object") {
      logger.error("Invalid response received from getProductInfo.");
      throw new Error("Unexpected response format.");
    }

    logger.debug(`Raw product info: ${JSON.stringify(data)}`);

    const appInfo = data.apps?.[appId];
    if (!appInfo) {
      logger.warn(`No app info found for appId ${appId}`);
      return null;
    }

    if (hasBeta) {
      try {
        // CMsgClientPICSPrivateBetaRequest returns the depot section for a
        // single password-protected branch. The branch metadata is stripped
        // from getProductInfo since Valve's Nov 2024 server change, so we
        // merge the unlocked branch back into appinfo.depots.branches to
        // keep the response shape identical to the pre-Nov-2024 behavior.
        const result = await withTimeout(
          client.getAppPrivateBeta(appId, betaBranch, betaPassword),
          REQUEST_TIMEOUT_MS,
          `getAppPrivateBeta(${appId}, ${betaBranch})`,
        ) as { depotSection?: Record<string, unknown> };

        const privateDepots = result?.depotSection?.privatedepots as
          | { branches?: Record<string, unknown> }
          | undefined;
        const privateBranches = privateDepots?.branches;

        if (privateBranches && typeof privateBranches === "object") {
          const depots = (appInfo.appinfo.depots ??= {}) as Record<
            string,
            unknown
          >;
          const branches = (depots.branches ??= {}) as Record<string, unknown>;
          Object.assign(branches, privateBranches);
          logger.info(
            `Merged private branch '${betaBranch}' into appId ${appId}; branches now: ${
              Object.keys(branches).join(", ")
            }`,
          );
        } else {
          logger.warn(
            `getAppPrivateBeta returned no branches for appId ${appId} / branch '${betaBranch}' (wrong password?)`,
          );
        }
      } catch (err) {
        logger.warn(
          `getAppPrivateBeta failed for appId ${appId} / branch '${betaBranch}': ${err}`,
        );
      }
    }

    logger.info(`Successfully retrieved app info for appId ${appId}`);
    return appInfo;
  });
}
