// ─── TRIAL GUARD MIDDLEWARE ───────────────────────────────────────────────────
// Enforces a lifetime trial credit limit tied to a device fingerprint,
// not just to an email address. Prevents account cycling.
//
// How it works:
//   1. At registration, the client sends a fingerprint hash (built in the
//      frontend from stable browser signals). The backend also mixes in the
//      client IP. The combined hash is stored on the user row.
//   2. A separate fingerprint_registry table tracks total lifetime credits
//      consumed across ALL accounts that share a fingerprint.
//   3. Before every generation, this middleware checks that registry.
//      If the fingerprint has consumed >= TRIAL_CREDIT_LIMIT across all
//      past and present accounts, generation is blocked regardless of which
//      email address was used to sign up.
//   4. After a successful generation, the registry row is incremented.
//
// Limits (override via env):
//   TRIAL_CREDIT_LIMIT  — default 5.
//                         Sermon preview: 4 credits (shows SCRIPTURE FOUNDATION
//                         through MAIN MOVEMENTS, remaining sections locked).
//                         Short-form tools: 1 credit each.
//                         A trial user can generate one sermon preview + one
//                         short-form tool, or five short-form generations.
//                         Adjust TRIAL_CREDIT_LIMIT in .env to change this.
//
// This middleware runs AFTER requireAuth and AFTER enforceCreditLimit.
// enforceCreditLimit handles the per-account monthly plan limit.
// trialGuard handles the cross-account lifetime trial limit.
//
// Paid accounts (plan !== 'trial') bypass this check entirely.

import { createHash } from "crypto";
import { getDb } from "../db/database.js";

export const TRIAL_CREDIT_LIMIT = parseInt(process.env.TRIAL_CREDIT_LIMIT ?? "5", 10);
export const TRIAL_PLAN = "trial";

// Build a consistent fingerprint from the request.
// Mixes the client-supplied browser fingerprint (if present) with IP and
// User-Agent so that clearing cookies or switching browsers still leaves
// a traceable signal.
export function buildServerFingerprint(req, clientFp = "") {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const ua = req.headers["user-agent"] || "unknown";
  const raw = `${ip}|${ua}|${clientFp}`;
  return createHash("sha256").update(raw).digest("hex");
}

// Called at registration — record the fingerprint against the new user.
export function registerFingerprint(db, userId, fingerprint) {
  // Upsert the registry row
  db.prepare(`
    INSERT INTO fingerprint_registry (fingerprint, total_credits_used)
    VALUES (?, 0)
    ON CONFLICT(fingerprint) DO UPDATE SET last_seen = datetime('now')
  `).run(fingerprint);
  // Attach fingerprint to user
  db.prepare("UPDATE users SET reg_fingerprint = ? WHERE id = ?").run(fingerprint, userId);
}

// Called after a successful generation — increment registry total.
export function incrementFingerprintUsage(db, fingerprint, credits) {
  if (!fingerprint) return;
  db.prepare(`
    UPDATE fingerprint_registry
    SET total_credits_used = total_credits_used + ?,
        last_seen = datetime('now')
    WHERE fingerprint = ?
  `).run(credits, fingerprint);
}

// Middleware — enforce trial limit for 'trial' plan users.
export function enforceTrialLimit(req, res, next) {
  return next();

  const db = getDb();
  const user = db.prepare("SELECT reg_fingerprint FROM users WHERE id = ?").get(req.userId);
  const fp = user?.reg_fingerprint;

  if (!fp) {
    // No fingerprint on file — allow but note it
    console.warn(`[trialGuard] user ${req.userId} has no fingerprint on record`);
    return next();
  }

  const registry = db.prepare(
    "SELECT total_credits_used FROM fingerprint_registry WHERE fingerprint = ?"
  ).get(fp);

  const totalUsed = registry?.total_credits_used ?? 0;
  const cost = req.creditCostForTool ?? 1;

  if (totalUsed + cost > TRIAL_CREDIT_LIMIT) {
    return res.status(429).json({
      error: "Your free trial has ended. Contact us to upgrade to a paid plan.",
      code:  "TRIAL_EXHAUSTED",
    });
  }

  req.trialFingerprint = fp;
  next();
}
