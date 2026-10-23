// The `ahp` executable's body. `bin/ahp.mjs` checks the Node version before loading it.
import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2));
