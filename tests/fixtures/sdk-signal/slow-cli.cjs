#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const timer = setInterval(() => {}, 1000);
/** Record descendant cleanup before allowing parent invocation to finish. Marker written only after the SIGTERM handler is armed, so the test can gate interrupts on registration. */
process.on("SIGTERM", () => { setTimeout(() => { fs.writeFileSync(path.join(process.env.SDK_SIGNAL_DIRECTORY, "cli-cleaned"), "done"); clearInterval(timer); process.exit(0); }, 100); });
fs.writeFileSync(path.join(process.env.SDK_SIGNAL_DIRECTORY, "cli-armed"), "1");
process.stderr.write("fixture-cli-running\n");
