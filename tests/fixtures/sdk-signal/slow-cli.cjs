#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const timer = setInterval(() => {}, 1000);
/** Record descendant cleanup before allowing parent invocation to finish. */
process.on("SIGTERM", () => { setTimeout(() => { fs.writeFileSync(path.join(process.env.SDK_SIGNAL_DIRECTORY, "cli-cleaned"), "done"); clearInterval(timer); process.exit(0); }, 100); });
process.stderr.write("fixture-cli-running\n");
