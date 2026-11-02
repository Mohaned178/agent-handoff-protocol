// The plain commands as an executable. Until ticket 09 switches `ahp` over, `src/cli/bin.ts` is the one that ships.
import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2));
