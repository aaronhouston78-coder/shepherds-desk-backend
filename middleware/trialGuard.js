// ─── TRIAL GUARD MIDDLEWARE ───────────────────────────────────────────────────
// Enforces a lifetime trial credit limit tied to a device fingerprint,
// not just the user account. This prevents repeated free-trial abuse.
//
// What it does:
//   1. On registration, auth.js stores a combined server fingerprint
//      (from browser fingerprint + IP + UA) on the user row and in
//      fingerprint_registry.
//   2. On generation requests, this middleware checks the user's stored
//      reg_fingerprint.
//   3. If the fingerprint has consumed >= TRIAL_CREDIT_LIMIT across all
//      accounts, generation is blocked.
//   4. If under the limit, request proceeds and generators.js increments
//      usage after success.
//
// Environment:
//   TRIAL_CREDIT_LIMIT  — default 5.
//
// Notes:
//   - This only applies to accounts whose plan is exactly "trial".
//   - Pending accounts are handled by planEnforcement instead.
//   - Paid accounts bypass this middleware.

import { getDb } from "../db/database.js";

export const TRIAL_CREDIT_LIMIT = parseInt(process.env.TRIAL_CREDIT_LIMIT ?? "5", 10);
export const TRIAL_PLAN = "trial";

// Middleware — enforce trial limit for 'trial' plan users.
export function enforceTrialLimit(req, res, next) {
  // Only applies to legacy trial accounts (pending accounts are handled by planEnforcement)
  if (req.userPlan !== TRIAL_PLAN) return next();

  const db = getDb();
  const user = db.prepare("SELECT reg_fingerprint FROM users WHERE id = ?").get(req.userId);
  const fp = user?.reg_fingerprint;

  if (!fp) {
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
