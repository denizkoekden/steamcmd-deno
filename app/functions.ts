import SteamUser from "npm:steam-user";
import { log } from "./utils.ts";
const logger = log.getLogger("functions");

export interface AppInfo {
  appid: number;
  changenumber: number;
  missingToken: boolean;
  appinfo: Record<string, unknown>;
}

export async function getAppInfo(appId: number, username: string, password: string): Promise<AppInfo | null> {
  logger.info(`Started requesting app info for appId ${appId}`);

  const client = new SteamUser();

  // Function to create a login promise
  const createLoginPromise = () => {
    return new Promise<void>((resolve, reject) => {
      client.once('loggedOn', () => {
        logger.debug('Successfully logged in to Steam!');
        resolve();
      });

      client.once('error', (err: Error) => {
        // Suppress "LogonSessionReplaced" as a non-critical error
        if (err.message === 'LogonSessionReplaced') {
          logger.debug('LogonSessionReplaced: Current session was replaced by a new one.');
          resolve(); // Treat it as a successful logon, since we expect it when re-logging
        } else {
          logger.error(`Error logging in to Steam: ${err}`);
          reject(err);
        }
      });
    });
  };

  // Perform login (either authenticated or anonymous)
  let loggedOnPromise = createLoginPromise();
  if (username && password) {
    client.logOn({ accountName: username, password: password });
  } else {
    client.logOn({ anonymous: true });
  }

  // Wait for the client to log on
  try {
    await loggedOnPromise;
  } catch (err) {
    client.logOff();
    throw err;
  }

  // Function to fetch product info
  const fetchAppInfo = async () => {
    try {
      logger.info(`Fetching product info for appId ${appId}`);
      const data = await client.getProductInfo([appId], [], true);

      if (data.apps && data.apps[appId]) {
        logger.info(`Successfully retrieved app info for appId ${appId}`);
        return data.apps[appId] as AppInfo;
      } else {
        logger.warning(`No app info found for appId ${appId}`);
        return null;
      }
    } catch (err) {
      logger.error(`Error fetching app info: ${err}`);
      client.logOff();
      throw err;
    }
  };

  // Fetch app info with the current login
  let appInfo = await fetchAppInfo();

  // If missingToken is true, retry as anonymous as some apps only work anonymously
  if (appInfo && appInfo.missingToken && username && password) {
    logger.info(`Missing token for appId ${appId}, retrying with anonymous login...`);

    // Wait for the client to log off before retrying
    await new Promise<void>((resolve) => {
      client.logOff();
      client.once('disconnected', () => {
        logger.debug('Logged off from Steam, retrying as anonymous...');
        resolve();
      });
    });

    // Retry logging in as anonymous
    loggedOnPromise = createLoginPromise();
    client.logOn({ anonymous: true });

    // Wait for the client to log on again
    try {
      await loggedOnPromise;
      appInfo = await fetchAppInfo(); // Fetch app info again
    } catch (err) {
      logger.error(`Error during anonymous retry for appId ${appId}: ${err}`);
      throw err;
    }

    if (appInfo && appInfo.missingToken) {
      logger.warning(`App info for appId ${appId} is incomplete, missing token even after anonymous login.`);
    }
  }

  return appInfo;
}
