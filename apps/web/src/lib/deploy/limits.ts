/**
 * Deploy limits shared by the browser and the server.
 *
 * Kept apart from `slots.ts`, which reaches for `node:fs` to read the local
 * slot registry: importing that from a client component drags the Node
 * built-ins into the browser bundle and the build fails outright.
 */

/**
 * Hard ceiling on concurrent slots on one GPU_HOST.
 *
 * The real limit is free VRAM - Measure sizes each slot from what is left. This
 * number only bounds ports, units, firewall rules, and catalog probes so a
 * runaway "Add slot" cannot invent an unbounded set of endpoints.
 */
export const MAX_DEPLOY_SLOTS = 8;
