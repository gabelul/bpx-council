#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const timer = setInterval(() => {}, 1000);
/** Record descendant cleanup before allowing parent invocation to finish. Marker is written on handler entry so a CPU-starved runner cannot lose it to the force-kill deadline; the delayed exit still leaves a lingering descendant for the parent to drain. */
process.on("SIGTERM", () => { fs.writeFileSync(path.join(process.env.SDK_SIGNAL_DIRECTORY, "cli-cleaned"), "done"); setTimeout(() => { clearInterval(timer); process.exit(0); }, 100); });
process.stderr.write("fixture-cli-running\n");
