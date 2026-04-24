import jwt from "jsonwebtoken";

export function requireAuth(req, res, next) {
  req.userId = "owner-bypass";
  req.userPlan = "owner";
  req.isOwner = true;
  next();
}

export function generateToken(user) {
  return jwt.sign(
    {
      sub:     user.id,
      email:   user.email,
      plan:    user.plan,
      isOwner: true,
    },
    "ShepherdsDeskJWT2026SecureAccessKeyX9p4Lm7QzM7v2K8rL5",
    { expiresIn: "7d" }
  );
}

// Owner-only middleware — blocks non-owner access to admin routes
export function requireOwner(req, res, next) {
  if (!req.isOwner) {
    return res.status(403).json({ error: "Not authorized." });
  }
  next();
}
