// ─── TRIAL GUARD MIDDLEWARE ───────────────────────────────────────────────────
// Enforces a lifetime trial credit limit tied to a device fingerprint.

import crypto from "crypto";
import { getDb } from "../db/database.js";

export const TRIAL_CREDIT_LIMIT = parseInt(process.env.TRIAL_CREDIT_LIMIT ?? "5", 10);
export const TRIAL_PLAN = "trial";

export function buildServerFingerprint(browserFingerprint = "", req = null) {
  const ip =
    req?.headers?.["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req?.ip ||
    "";
  const ua = req?.headers?.["user-agent"] || "";
  return crypto
    .createHash("sha256")
    .update([browserFingerprint || "", ip, ua].join("|"))
    .digest("hex");
}

export function registerFingerprint(db, userId, fingerprint) {
  if (!fingerprint) return;
  db.prepare("UPDATE users SET reg_fingerprint = ? WHERE id = ?").run(fingerprint, userId);
  db.prepare(`
    INSERT INTO fingerprint_registry (fingerprint, first_user_id, total_credits_used)
    VALUES (?, ?, 0)
    ON CONFLICT(fingerprint) DO NOTHING
  `).run(fingerprint, userId);
}

export function incrementFingerprintUsage(db, fingerprint, amount = 1) {
  if (!fingerprint) return;
  db.prepare(`
    UPDATE fingerprint_registry
    SET total_credits_used = COALESCE(total_credits_used, 0) + ?
    WHERE fingerprint = ?
  `).run(amount, fingerprint);
}

export function enforceTrialLimit(req, res, next) {
  if (req.userPlan !== TRIAL_PLAN) return next();

  const db = getDb();
  const user = db.prepare("SELECT reg_fingerprint FROM users WHERE id = ?").get(req.userId);
  const fp = user?.reg_fingerprint;

  if (!fp) return next();

  const registry = db.prepare(
    "SELECT total_credits_used FROM fingerprint_registry WHERE fingerprint = ?"
  ).get(fp);

  const totalUsed = registry?.total_credits_used ?? 0;
  const cost = req.creditCostForTool ?? 1;

  if (totalUsed + cost > TRIAL_CREDIT_LIMIT) {
    return res.status(429).json({
      error: "Your free trial has ended. Contact us to upgrade to a paid plan.",
      code: "TRIAL_EXHAUSTED",
    });
  }

  req.trialFingerprint = fp;
  next();
}
