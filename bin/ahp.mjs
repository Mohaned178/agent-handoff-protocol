#!/usr/bin/env node
// Checks the Node version before loading anything else, so an old Node gets a clear message
// instead of an obscure syntax or API error. Keep this file to syntax that old Node versions parse.

import { existsSync } from "node:fs";

var MINIMUM_MAJOR = 24;
var current = process.versions.node;

if (Number(current.split(".")[0]) < MINIMUM_MAJOR) {
  process.stderr.write(
    "ahp requires Node.js " + MINIMUM_MAJOR + " or newer; this is Node.js " + current + ".\n" +
    "Install a current Node.js from https://nodejs.org/ and try again.\n"
  );
  process.exit(1);
}

// In a checkout (`npm link`), run the source: dist/ is only as new as the last build, and a stale one looked like a
// change that did nothing. The published package has no src/, so it runs dist/.
var source = new URL("../src/cli/bin.ts", import.meta.url);
import(existsSync(source) ? source.href : "../dist/cli/bin.js");
