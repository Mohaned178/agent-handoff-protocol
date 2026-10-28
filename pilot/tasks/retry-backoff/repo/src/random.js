import { randomInt } from "node:crypto";

/** A number in [0, 1). */
export const defaultRandom = () => randomInt(0, 1_000_000) / 1_000_000;
