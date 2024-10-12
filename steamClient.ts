import SteamUser from "npm:steam-user";
import { STEAM_ACCOUNT, STEAM_PASSWORD } from "./config.ts";

export async function getAppInfo(appId: number) {
  const client = new SteamUser();
  
  if (STEAM_ACCOUNT && STEAM_PASSWORD) {
    console.log("Logging in with credentials...");
    await client.logOn({
      accountName: STEAM_ACCOUNT,
      password: STEAM_PASSWORD,
    });
  } else {
    console.log("Logging in anonymously...");
    await client.logOn();
  }

  return new Promise((resolve, reject) => {
    client.on("loggedOn", () => {
      console.log("Logged in!");
      client.getProductInfo([appId], [], (apps, packages) => {
        resolve(apps[appId]);
      });
    });
    
    client.on("error", (err) => {
      reject(err);
    });
  });
}
