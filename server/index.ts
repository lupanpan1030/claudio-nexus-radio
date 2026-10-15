import { createServices } from "./composition.js";
import { createApp } from "./http/app.js";

// Bootstrap only: assembly lives in composition.ts, routes in http/.
const services = await createServices();
for (const notice of services.settings.notices) console.warn(`Playback settings: ${notice}`);
const { app, close } = createApp(services.appDeps);
const { recovered } = services.playback;
if (recovered.preparations || recovered.cues) {
  console.log(`Marked ${recovered.preparations} preparations and ${recovered.cues} cues interrupted after restart`);
}

const server = app.listen(services.listen.port, services.listen.host, async () => {
  console.log(
    `AI radio server listening on http://${services.listen.host}:${services.listen.port} (playback protocol ${services.settings.protocol})`
  );
  try {
    const scanned = await services.scanIfEmpty();
    if (scanned) console.log(scanned);
  } catch (error) {
    console.warn(`Initial library scan skipped: ${error instanceof Error ? error.message : error}`);
  }
});

const gcTimer = setInterval(() => {
  try {
    services.playback.gc.run();
  } catch (error) {
    console.warn(`Playback GC failed: ${error instanceof Error ? error.message : error}`);
  }
}, services.settings.gcIntervalMs);
gcTimer.unref();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  clearInterval(gcTimer);
  server.close();
  await close();
  services.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
