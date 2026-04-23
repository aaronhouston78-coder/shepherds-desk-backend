// Deprecated shim — all limiters now live in rateLimiter.js
// Kept for backward compatibility if other code imports this file.
export { generateIpLimiter as generateLimiter } from "./rateLimiter.js";
