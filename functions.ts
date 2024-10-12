import SteamUser from "npm:steam-user";
import { getLogger } from "./utils.ts";
const logger = getLogger("functions");

export async function getAppInfo(appId: number): Promise<any> {
  logger.info(`Started requesting app info for appId ${appId}`);

  const client = new SteamUser();

  // Create a Promise that resolves when logged on or rejects on error
  const loggedOnPromise = new Promise<void>((resolve, reject) => {
    client.once('loggedOn', () => {
      logger.info('Successfully logged in to Steam!');
      resolve();
    });

    client.once('error', (err) => {
      logger.error(`Error logging in to Steam: ${err}`);
      reject(err);
    });
  });

  // Attempt to log on anonymously
  client.logOn({ anonymous: true });

  // Wait for the client to log on
  try {
    await loggedOnPromise;
  } catch (err) {
    client.logOff();
    throw err;
  }

  // Fetch product info
  try {
    logger.info(`Fetching product info for appId ${appId}`);
    const data = await client.getProductInfo([appId], []);
    client.logOff();

    if (data.apps && data.apps[appId]) {
      logger.info(`Successfully retrieved app info for appId ${appId}`);
      return data.apps[appId];
    } else {
      logger.warning(`No app info found for appId ${appId}`);
      return null;
    }
  } catch (err) {
    logger.error(`Error fetching app info: ${err}`);
    client.logOff();
    throw err;
  }
}
