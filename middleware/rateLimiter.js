// ─── RATE LIMITERS ────────────────────────────────────────────────────────────
// All rate limiters in one place.
// Per-IP limiters use express-rate-limit.
// Per-user limiter uses the database to prevent shared-NAT bypass.

import rateLimit from "express-rate-limit";
import { getDb } from "../db/database.js";

// Global: covers all routes — 200 requests per 15 minutes per IP
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment and try again." },
});

// Auth: tighter limit on registration — 5 per hour per IP
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many account registrations from this connection. Please try again later." },
  skipSuccessfulRequests: false,
});

// Generate (IP): 20 requests per 15 minutes per IP
export const generateIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Generation limit reached. Please wait a moment before trying again." },
});

// Generate (user): max 10 per hour per authenticated account.
// Enforced via DB so it works across multiple server instances and
// cannot be bypassed by rotating IPs or shared NAT environments.
export function generateUserLimiter(req, res, next) {
  const db         = getDb();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt FROM usage_events
    WHERE user_id = ? AND event_type = 'generation' AND created_at >= ?
  `).get(req.userId, oneHourAgo);

  if ((row?.cnt ?? 0) >= 10) {
    return res.status(429).json({
      error: "Hourly generation limit reached. Please wait before generating more content.",
    });
  }
  next();
}
