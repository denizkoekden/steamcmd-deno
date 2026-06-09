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

class ClientEvictedError extends Error {
  constructor(reason: string) {
    super(`Steam client evicted: ${reason}`);
    this.name = "ClientEvictedError";
  }
}

type CredentialsKey = string;
type ManagedClient = {
  client: SteamUser;
  whenEvicted: Promise<never>;
};
const clientPromises = new Map<CredentialsKey, Promise<ManagedClient>>();

export const buildCredentialsKey = (
  username: string,
  password: string,
): CredentialsKey =>
  username && password ? `${username}::${password}` : "anonymous";

const getClient = (
  username: string,
  password: string,
): Promise<ManagedClient> => {
  const mustAuthenticate = Boolean(username && password);
  const key = buildCredentialsKey(username, password);

  const existing = clientPromises.get(key);
  if (existing) return existing;

  const createClient = new Promise<ManagedClient>((resolve, reject) => {
    const client = new SteamUser();
    let rejectLifecycle: (err: Error) => void = () => {};
    const whenEvicted = new Promise<never>((_, rej) => {
      rejectLifecycle = rej;
    });
    // Absorb the unhandled-rejection signal so it's safe to leave dangling
    // when no in-flight call happens to be racing against it at eviction.
    whenEvicted.catch(() => {});

    const evict = (reason: string) => {
      // Only remove our own map entry: a stale event from an already-replaced
      // client must not evict the successor client.
      if (clientPromises.get(key) === createClient) {
        clientPromises.delete(key);
        logger.warn(
          `Evicted Steam client (${
            mustAuthenticate ? "auth" : "anon"
          }): ${reason}`,
        );
      }
      rejectLifecycle(new ClientEvictedError(reason));
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
      resolve({ client, whenEvicted });
    };
    const onError = (err: Error) => {
      client.off("loggedOn", onLoggedOn);
      if (clientPromises.get(key) === createClient) {
        clientPromises.delete(key);
      }
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

  const MAX_ATTEMPTS = 2;

  return await enqueueRequest(async () => {
    for (let attempt = 1;; attempt += 1) {
      // The login itself needs a timeout: steam-user cycles CMs silently when
      // throttled and may emit neither `loggedOn` nor `error`, which would
      // otherwise leave every request awaiting this promise hanging forever.
      const key = buildCredentialsKey(username, password);
      const clientPromise = getClient(username, password);
      let managed: ManagedClient;
      try {
        managed = await withTimeout(
          clientPromise,
          REQUEST_TIMEOUT_MS,
          `steam login (${key === "anonymous" ? "anon" : "auth"})`,
        );
      } catch (err) {
        if (clientPromises.get(key) === clientPromise) {
          clientPromises.delete(key);
          // The hung login may still complete later; don't leak the session.
          clientPromise.then(({ client }) => client.logOff()).catch(() => {});
        }
        throw err;
      }
      const { client, whenEvicted } = managed;
      logger.info(`Fetching product info for appId ${appId}`);

      try {
        const data = await withTimeout(
          Promise.race([
            client.getProductInfo([appId], [], true),
            whenEvicted,
          ]),
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
              Promise.race([
                client.getAppPrivateBeta(appId, betaBranch, betaPassword),
                whenEvicted,
              ]),
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
              const branches = (depots.branches ??= {}) as Record<
                string,
                unknown
              >;
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
      } catch (err) {
        if (err instanceof ClientEvictedError && attempt < MAX_ATTEMPTS) {
          logger.warn(
            `appId ${appId}: ${err.message}; retrying with fresh client (attempt ${
              attempt + 1
            }/${MAX_ATTEMPTS})`,
          );
          continue;
        }
        throw err;
      }
    }
  });
}
