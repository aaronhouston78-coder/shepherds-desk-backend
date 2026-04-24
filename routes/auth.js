import { Router }        from "express";
import bcrypt            from "bcryptjs";
import { v4 as uuid }    from "uuid";
import { randomBytes }   from "crypto";
import { z }             from "zod";
import { registerLimiter } from "../middleware/rateLimiter.js";
import { getDb }         from "../db/database.js";
import { generateToken, requireAuth } from "../middleware/auth.js";
import { buildServerFingerprint, registerFingerprint, TRIAL_CREDIT_LIMIT } from "../middleware/trialGuard.js";
import { sendVerificationEmail } from "../services/emailService.js";

const router = Router();

const RegisterSchema = z.object({
  name:        z.string().min(2, "Name must be at least 2 characters.").max(80),
  email:       z.string().email("Please enter a valid email address."),
  password:    z.string().min(8, "Password must be at least 8 characters."),
  fingerprint: z.string().max(256).optional(),
});

const LoginSchema = z.object({
  email:    z.string().email("Please enter a valid email address."),
  password: z.string().min(1, "Password is required."),
});

// ── POST /register ────────────────────────────────────────────────────────────

router.post("/register", registerLimiter, async (req, res) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { name, email, password, fingerprint: clientFp = "" } = parsed.data;
  const db = getDb();

  // Reject duplicate email
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }

  // Build combined server fingerprint and block if trial already exhausted
  const fp       = buildServerFingerprint(req, clientFp);
  const registry = db.prepare(
    "SELECT total_credits_used FROM fingerprint_registry WHERE fingerprint = ?"
  ).get(fp);
  if (registry && registry.total_credits_used >= TRIAL_CREDIT_LIMIT) {
    return res.status(403).json({
      error: "An account from this device already exists. Contact us to access a paid plan.",
    });
  }

  const hash         = await bcrypt.hash(password, 12);
  const id           = uuid();
  // Generate a secure email verification token (32 random bytes = 64 hex chars)
  const verifyToken  = randomBytes(32).toString("hex");
  const verifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    "INSERT INTO users (id, name, email, password, plan, email_verified, verify_token, verify_expires) VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
  ).run(id, name, email.toLowerCase(), hash, "pending", verifyToken, verifyExpiry);

  registerFingerprint(db, id, fp);

  // Send verification email (non-blocking — do not fail registration if email send fails)
  sendVerificationEmail(email.toLowerCase(), name, verifyToken).catch(err =>
    console.error("[register] email send error:", err?.message)
  );

  const user  = db.prepare("SELECT id, name, email, church_name, role, plan, is_owner, email_verified FROM users WHERE id = ?").get(id);
  const token = generateToken(user);

  return res.status(201).json({
    token,
    user:               safeUser(user),
    requiresVerification: true,
  });
});

// ── GET /verify-email ─────────────────────────────────────────────────────────
// Called when user clicks the link in their verification email.
// The frontend routes /verify-email?token=xxx to the app, which calls this endpoint.

router.get("/verify-email", (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== "string" || token.length !== 64) {
    return res.status(400).json({ error: "Invalid or missing verification token." });
  }

  const db   = getDb();
  const user = db.prepare(
    "SELECT id, verify_expires FROM users WHERE verify_token = ? AND email_verified = 0"
  ).get(token);

  if (!user) {
    return res.status(400).json({ error: "This verification link is invalid or has already been used." });
  }

  if (new Date(user.verify_expires) < new Date()) {
    return res.status(400).json({ error: "This verification link has expired. Please request a new one." });
  }

  db.prepare(
    "UPDATE users SET email_verified = 1, verify_token = NULL, verify_expires = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(user.id);

  return res.json({ verified: true, message: "Your email has been verified. You can now sign in." });
});

// ── POST /resend-verification ─────────────────────────────────────────────────

router.post("/resend-verification", requireAuth, async (req, res) => {
  const db   = getDb();
  const user = db.prepare("SELECT id, name, email, email_verified FROM users WHERE id = ?").get(req.userId);

  if (!user) return res.status(404).json({ error: "User not found." });
  if (user.email_verified) return res.json({ message: "Your email is already verified." });

  const verifyToken  = randomBytes(32).toString("hex");
  const verifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    "UPDATE users SET verify_token = ?, verify_expires = ? WHERE id = ?"
  ).run(verifyToken, verifyExpiry, user.id);

  await sendVerificationEmail(user.email, user.name, verifyToken).catch(err =>
    console.error("[resend-verification] email error:", err?.message)
  );

  return res.json({ message: "Verification email sent. Please check your inbox." });
});

// ── POST /login ───────────────────────────────────────────────────────────────

router.post("/login", async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { email, password } = parsed.data;
  const db = getDb();
  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
  if (user && ["deskshepherd@gmail.com", "shepherdsdesk2.0@gmail.com"].includes(String(user.email || "").toLowerCase())) {
    user = { ...user, is_owner: 1, plan: "owner" };
  }
  if (!user) {
    return res.status(401).json({ error: "No account found with that email address." });
  }
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: "Incorrect password. Please try again." });
  }
  const token = generateToken(user);
  return res.json({
    token,
    user:               safeUser(user),
    requiresVerification: !user.email_verified,
  });
});

// ── GET /me ───────────────────────────────────────────────────────────────────

router.get("/me", requireAuth, (req, res) => {
  const db   = getDb();
  let user = db.prepare(
    "SELECT id, name, email, church_name, role, plan, is_owner, email_verified FROM users WHERE id = ?"
  ).get(req.userId);
  if (user && ["deskshepherd@gmail.com", "shepherdsdesk2.0@gmail.com"].includes(String(user.email || "").toLowerCase())) {
    user = { ...user, is_owner: 1, plan: "owner" };
  }
  if (!user) return res.status(404).json({ error: "User not found." });
  return res.json({ user: safeUser(user) });
});

// ── PATCH /me ─────────────────────────────────────────────────────────────────

router.patch("/me", requireAuth, (req, res) => {
  const { name, church_name, role } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Name is required." });
  }
  const db = getDb();
  db.prepare(
    "UPDATE users SET name = ?, church_name = ?, role = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(name.trim(), church_name || "", role || "", req.userId);
  const user = db.prepare(
    "SELECT id, name, email, church_name, role, plan, is_owner, email_verified FROM users WHERE id = ?"
  ).get(req.userId);
  return res.json({ user: safeUser(user) });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeUser(u) {
  const forcedOwner = ["deskshepherd@gmail.com", "shepherdsdesk2.0@gmail.com"].includes(String(u.email || "").toLowerCase());
  return {
    id:            u.id,
    name:          u.name,
    email:         u.email,
    churchName:    u.church_name,
    role:          u.role,
    plan:          forcedOwner ? "owner" : u.plan,
    isOwner:       forcedOwner || !!u.is_owner,
    emailVerified: !!u.email_verified,
  };
}

export default router;
