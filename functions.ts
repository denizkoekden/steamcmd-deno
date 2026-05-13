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

// Minimal VDF/KeyValues parser sufficient for `app_info_print` output.
// Supports nested `"key" "value"` and `"key" { ... }` only — no macros, no
// includes, no comments (steamcmd's dump emits none of those).
const parseVdf = (text: string): Record<string, unknown> => {
  let pos = 0;
  const skip = () => {
    while (pos < text.length) {
      const ch = text[pos];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") pos++;
      else break;
    }
  };
  const readString = (): string => {
    skip();
    if (text[pos] !== '"') {
      throw new Error(
        `VDF: expected '"' at ${pos}, got '${text[pos] ?? "EOF"}'`,
      );
    }
    pos++;
    let s = "";
    while (pos < text.length && text[pos] !== '"') {
      if (text[pos] === "\\" && pos + 1 < text.length) {
        const next = text[pos + 1];
        if (next === "n") s += "\n";
        else if (next === "t") s += "\t";
        else if (next === "r") s += "\r";
        else if (next === "\\") s += "\\";
        else if (next === '"') s += '"';
        else s += next;
        pos += 2;
      } else {
        s += text[pos];
        pos++;
      }
    }
    if (text[pos] !== '"') throw new Error("VDF: unterminated string");
    pos++;
    return s;
  };
  const parseObj = (): Record<string, unknown> => {
    skip();
    if (text[pos] !== "{") throw new Error(`VDF: expected '{' at ${pos}`);
    pos++;
    const obj: Record<string, unknown> = {};
    skip();
    while (pos < text.length && text[pos] !== "}") {
      const key = readString();
      skip();
      obj[key] = text[pos] === "{" ? parseObj() : readString();
      skip();
    }
    if (text[pos] !== "}") throw new Error("VDF: unterminated object");
    pos++;
    return obj;
  };
  const root: Record<string, unknown> = {};
  skip();
  while (pos < text.length) {
    const key = readString();
    skip();
    root[key] = text[pos] === "{" ? parseObj() : readString();
    skip();
  }
  return root;
};

// Serialize steamcmd invocations — Steam content directory state is shared
// across concurrent steamcmd processes and can corrupt under contention.
let steamcmdChain: Promise<unknown> = Promise.resolve();
const enqueueSteamCmd = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = steamcmdChain.then(fn, fn);
  steamcmdChain = run.catch(() => undefined);
  return run;
};

const getAppInfoViaSteamCmd = async (
  appId: number,
  username: string,
  password: string,
  betaPassword: string,
): Promise<AppInfo | null> => {
  const steamcmdPath = config.STEAMCMD_PATH;
  if (!steamcmdPath) {
    logger.error(
      `STEAMCMD_PATH not configured; cannot resolve beta branch for appId ${appId}`,
    );
    return null;
  }

  return await enqueueSteamCmd(async () => {
    const args: string[] = [
      "+@ShutdownOnFailedCommand",
      "0",
      "+@NoPromptForPassword",
      "1",
    ];
    if (username && password) {
      args.push("+login", username, password);
    } else {
      args.push("+login", "anonymous");
    }
    args.push("+set_app_beta_password", String(appId), betaPassword);
    args.push("+app_info_update", "1");
    args.push("+app_info_print", String(appId));
    // The second print is a workaround: the first call often returns cached
    // (pre-password) data; the second reliably includes the unlocked branch.
    args.push("+app_info_print", String(appId));
    args.push("+quit");

    logger.info(`Spawning steamcmd for appId ${appId}`);
    const cmd = new Deno.Command(steamcmdPath, {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const proc = cmd.spawn();
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch (_) {
        // already exited
      }
    }, config.STEAMCMD_TIMEOUT_MS);

    let output: { code: number; stdout: Uint8Array; stderr: Uint8Array };
    try {
      output = await proc.output();
    } finally {
      clearTimeout(timer);
    }

    const out = new TextDecoder().decode(output.stdout);
    const errOut = new TextDecoder().decode(output.stderr);

    if (output.code !== 0) {
      logger.warn(
        `steamcmd exited ${output.code} for appId ${appId}: ${
          errOut.slice(0, 400) || "(no stderr)"
        }`,
      );
    }

    const changeMatch = out.match(
      /AppID\s*:\s*\d+,\s*change number\s*:\s*(\d+)/,
    );
    const changenumber = changeMatch ? Number(changeMatch[1]) : 0;

    // Match only the outer block `"<appid>"\s*{`, not field values such as
    // `"gameid" "<appid>"` inside the `common` section — those share the same
    // numeric string but are followed by another `"key"` rather than `{`.
    const blockRegex = new RegExp(`"${appId}"\\s*\\{`, "g");
    const matches = [...out.matchAll(blockRegex)];
    const lastMatch = matches[matches.length - 1];
    if (!lastMatch || lastMatch.index === undefined) {
      logger.warn(`steamcmd output for appId ${appId} contains no app block`);
      return null;
    }
    const braceStart = lastMatch.index + lastMatch[0].length - 1;
    let depth = 0;
    let braceEnd = -1;
    for (let i = braceStart; i < out.length; i++) {
      const c = out[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          braceEnd = i;
          break;
        }
      }
    }
    if (braceEnd === -1) {
      logger.warn(`steamcmd output for appId ${appId} has unmatched braces`);
      return null;
    }

    const vdfText = `"${appId}"\n${out.slice(braceStart, braceEnd + 1)}`;
    let parsed: Record<string, unknown>;
    try {
      parsed = parseVdf(vdfText);
    } catch (e) {
      logger.error(`VDF parse failed for appId ${appId}: ${e}`);
      return null;
    }

    const body = parsed[String(appId)] as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") {
      logger.warn(`No body in parsed VDF for appId ${appId}`);
      return null;
    }

    const depots = body.depots as
      | { branches?: Record<string, unknown> }
      | undefined;
    const branches = depots?.branches ?? {};
    logger.info(
      `steamcmd resolved appId ${appId} (changenumber=${changenumber}); branches: ${
        Object.keys(branches).join(", ") || "(none)"
      }`,
    );

    return {
      appid: appId,
      changenumber,
      missingToken: false,
      appinfo: { appid: String(appId), ...body },
    };
  });
};

export async function getAppInfo(
  appId: number,
  username: string,
  password: string,
  betaPassword = "",
): Promise<AppInfo | null> {
  validateAppId(appId);

  if (betaPassword) {
    logger.info(
      `Started requesting app info for appId ${appId} via steamcmd [betaPassword set]`,
    );
    return getAppInfoViaSteamCmd(appId, username, password, betaPassword);
  }

  logger.info(`Started requesting app info for appId ${appId}`);

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
    if (appInfo) {
      logger.info(`Successfully retrieved app info for appId ${appId}`);
      return appInfo;
    }

    logger.warn(`No app info found for appId ${appId}`);
    return null;
  });
}
