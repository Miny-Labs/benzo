/**
 * @benzo/proving-artifacts — client-side proving-artifact delivery: a
 * cache-once manifest + integrity-checked fetch + the on-device-vs-delegated
 * routing policy. Turns the "huge zkey download" problem into a one-time
 * background prefetch (or zero download via the TEE delegate).
 */
export * from "./manifest.js";
export * from "./cache.js";
export * from "./router.js";
