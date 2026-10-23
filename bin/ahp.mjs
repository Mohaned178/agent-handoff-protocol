#!/usr/bin/env node
// Checks the Node version before loading anything else, so an old Node gets a clear message
// instead of an obscure syntax or API error. Keep this file to syntax that old Node versions parse.

var MINIMUM_MAJOR = 24;
var current = process.versions.node;

if (Number(current.split(".")[0]) < MINIMUM_MAJOR) {
  process.stderr.write(
    "ahp requires Node.js " + MINIMUM_MAJOR + " or newer; this is Node.js " + current + ".\n" +
    "Install a current Node.js from https://nodejs.org/ and try again.\n"
  );
  process.exit(1);
}

import("../dist/cli/bin.js");
