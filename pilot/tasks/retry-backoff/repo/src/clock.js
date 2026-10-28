/** Resolves after `ms` milliseconds. */
export const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
