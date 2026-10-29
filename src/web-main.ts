// Inbox without the Slack bot: `npm run web` (`make web`).
import "./bootstrap.js";
import { startWebServer } from "./web/server.js";

if (!process.env.WEB_ACCESS_PASSWORD) {
  console.error("Set WEB_ACCESS_PASSWORD to enable the inbox.");
  process.exit(1);
}
startWebServer(Number(process.env.PORT) || 3000);
