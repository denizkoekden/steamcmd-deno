import SteamUser from 'npm:steam-user';

const client = new SteamUser();

client.logOn({ anonymous: true });

client.on('loggedOn', async () => {
  console.log('Logged on to Steam!');

  try {
    // Fetch product info for appID 2089300
    const data = await client.getProductInfo([2089300], []);
    // Access the app info
    const appInfo = data.apps[2089300];
    const appUpdate = data.

    if (appInfo) {
      console.log('App Info:', appInfo);
    } else {
      console.log('No app info found for appID 2089300');
    }
  } catch (err) {
    console.error('Error getting product info:', err);
  }

  client.logOff();
  Deno.exit(0);
});

client.on('error', (err) => {
  console.error('Error logging in to Steam:', err);
  Deno.exit(1);
});
