#!/usr/bin/env node
// Deliberately exceeds pipe buffer so interrupted receipt requires real stdout drain.
process.stdout.write("Earned CLI answer " + "x".repeat(256 * 1024));
