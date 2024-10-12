import { Application, Router, Context } from "./deps.ts";
import { getAppInfo } from "./steamClient.ts";
import { cacheRead, cacheWrite } from "./cache.ts";

const router = new Router();

router.get("/v1/info/:appId", async (ctx: Context) => {
  const { appId } = ctx.params;

  // Check cache
  let info = await cacheRead(Number(appId));
  if (!info) {
    info = await getAppInfo(Number(appId));
    await cacheWrite(Number(appId), info);
  }

  ctx.response.body = { data: info, status: "success" };
});

const app = new Application();
app.use(router.routes());
app.use(router.allowedMethods());

console.log("Server running on port 8000");
await app.listen({ port: 8000 });
