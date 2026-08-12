import SteamUser from "steam-user";
import config from "./config.ts";
import { log } from "./utils.ts";

const logger = log.getLogger("functions");

const REQUEST_DELAY_MS = config.STEAM_REQUEST_DELAY_MS;
const REQUEST_TIMEOUT_MS = config.STEAM_REQUEST_TIMEOUT_MS;
const THROTTLE_ENABLED = REQUEST_DELAY_MS > 0;
// How long a single login attempt may keep cycling CMs before the client is
// torn down and replaced. steam-user retries silently with its own backoff,
// so this is a hard upper bound, not the normal path.
const LOGIN_PENDING_MAX_MS = 120_000;
const LOGIN_PENDING_WARN_INTERVAL_MS = 30_000;
// After a login *error* (RateLimitExceeded, InvalidPassword, ...) don't start
// a new logon per incoming request — fail fast until the cooldown expires.
const LOGIN_ERROR_COOLDOWN_MS = 10_000;

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

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`${label} timed out after ${ms}ms`)),
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
type ManagedEntry = {
  client: SteamUser;
  // Resolves on `loggedOn`, rejects on a login error or eviction.
  ready: Promise<ManagedClient>;
  createdAt: number;
  pending: boolean;
  evict: (reason: string) => void;
};
const clients = new Map<CredentialsKey, ManagedEntry>();
const loginCooldownUntil = new Map<CredentialsKey, number>();

export const buildCredentialsKey = (
  username: string,
  password: string,
): CredentialsKey =>
  username && password ? `${username}::${password}` : "anonymous";

const getEntry = (username: string, password: string): ManagedEntry => {
  const mustAuthenticate = Boolean(username && password);
  const key = buildCredentialsKey(username, password);
  const label = mustAuthenticate ? "auth" : "anon";

  const existing = clients.get(key);
  if (existing) return existing;

  const cooldownUntil = loginCooldownUntil.get(key) ?? 0;
  if (Date.now() < cooldownUntil) {
    const secondsLeft = Math.ceil((cooldownUntil - Date.now()) / 1000);
    throw new Error(
      `steam login (${label}) in cooldown for ${secondsLeft}s after a recent login failure`,
    );
  }

  const client = new SteamUser();
  let rejectLifecycle: (err: Error) => void = () => {};
  const whenEvicted = new Promise<never>((_, rej) => {
    rejectLifecycle = rej;
  });
  // Absorb the unhandled-rejection signal so it's safe to leave dangling
  // when no in-flight call happens to be racing against it at eviction.
  whenEvicted.catch(() => {});

  let resolveReady: (managed: ManagedClient) => void = () => {};
  let rejectReady: (err: Error) => void = () => {};
  const ready = new Promise<ManagedClient>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  // Same as above: eviction may happen while nobody is awaiting `ready`.
  ready.catch(() => {});

  const entry: ManagedEntry = {
    client,
    ready,
    createdAt: Date.now(),
    pending: true,
    evict: () => {},
  };

  // steam-user retries throttled logins (TryAnotherCM / ServiceUnavailable)
  // silently and forever — no `loggedOn`, no `error`. Make that state visible
  // and bound it: warn while pending, replace the client once it has been
  // stuck past LOGIN_PENDING_MAX_MS.
  const warnTimer = setInterval(() => {
    const ageMs = Date.now() - entry.createdAt;
    if (ageMs >= LOGIN_PENDING_MAX_MS) {
      evict(`login still pending after ${Math.round(ageMs / 1000)}s`);
      return;
    }
    logger.warn(
      `Steam login (${label}) still pending after ${
        Math.round(ageMs / 1000)
      }s — Steam is likely throttling logons`,
    );
  }, LOGIN_PENDING_WARN_INTERVAL_MS);

  const clearPending = () => {
    entry.pending = false;
    clearInterval(warnTimer);
  };

  const evict = (reason: string) => {
    // Only remove our own map entry: a stale event from an already-replaced
    // client must not evict the successor client.
    if (clients.get(key) === entry) {
      clients.delete(key);
      logger.warn(`Evicted Steam client (${label}): ${reason}`);
    }
    clearPending();
    const err = new ClientEvictedError(reason);
    // Fail current waiters immediately (no-ops once `ready` is settled).
    rejectReady(err);
    rejectLifecycle(err);
    try {
      // Also cancels steam-user's internal logon retry timers mid-login, so
      // an evicted client can't keep hammering CMs in the background.
      client.logOff();
    } catch (_) {
      // ignore — client may already be torn down
    }
  };
  entry.evict = evict;

  const onLoggedOn = () => {
    clearPending();
    loginCooldownUntil.delete(key);
    client.off("error", onError);
    client.on("error", (err: Error) => {
      evict(`error: ${err?.message ?? err}`);
    });
    client.on("disconnected", (eresult: number, msg?: string) => {
      evict(`disconnected (eresult=${eresult}${msg ? `, ${msg}` : ""})`);
    });
    resolveReady({ client, whenEvicted });
  };
  const onError = (err: Error) => {
    client.off("loggedOn", onLoggedOn);
    clearPending();
    loginCooldownUntil.set(key, Date.now() + LOGIN_ERROR_COOLDOWN_MS);
    if (clients.get(key) === entry) {
      clients.delete(key);
    }
    rejectReady(err);
  };

  client.once("loggedOn", onLoggedOn);
  client.once("error", onError);

  try {
    if (mustAuthenticate) {
      logger.debug("Attempting authenticated login...");
      client.logOn({ accountName: username, password });
    } else {
      logger.debug("Attempting anonymous login...");
      client.logOn({ anonymous: true });
    }
  } catch (err) {
    clearPending();
    throw err;
  }

  clients.set(key, entry);
  return entry;
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
      const key = buildCredentialsKey(username, password);
      const entry = getEntry(username, password);
      // The login needs a timeout: steam-user cycles CMs silently when
      // throttled and may emit neither `loggedOn` nor `error`. The request
      // fails after REQUEST_TIMEOUT_MS, but the pending login stays in the
      // registry: steam-user keeps retrying with its own backoff and the
      // heartbeat in getEntry() replaces the client if it stays stuck.
      // Evicting here per request would instead spawn a fresh logon attempt
      // every REQUEST_TIMEOUT_MS and amplify the throttling that caused it.
      const { client, whenEvicted } = await withTimeout(
        entry.ready,
        REQUEST_TIMEOUT_MS,
        `steam login (${key === "anonymous" ? "anon" : "auth"})`,
      );
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
        if (err instanceof TimeoutError) {
          // A timed-out PICS call usually means a half-dead session that
          // steam-user hasn't noticed yet; drop it so the next request gets
          // a fresh client instead of burning the timeout again.
          entry.evict(err.message);
        }
        throw err;
      }
    }
  });
}
