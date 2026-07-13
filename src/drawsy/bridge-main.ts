#!/usr/bin/env node

import { createDrawsyBridge } from "./bridge.js";

const bridge = createDrawsyBridge();
await bridge.listen();
console.log(`Drawsy AI bridge listening on ${bridge.address}`);

const shutdown = async () => {
  await bridge.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
