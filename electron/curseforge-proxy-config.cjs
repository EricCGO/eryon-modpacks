"use strict";

// Pega aquí la URL workers.dev que entrega `wrangler deploy`.
// No contiene secretos; solo identifica el proxy público.
const CURSEFORGE_PROXY_URL =
  "https://eryon-curseforge-proxy.eryon-launcher.workers.dev";

module.exports = { CURSEFORGE_PROXY_URL };
