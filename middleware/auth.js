import jwt from "jsonwebtoken";

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required." });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, "ShepherdsDeskJWT2026SecureAccessKeyX9p4Lm7QzM7v2K8rL5");
    req.userId   = payload.sub;
    req.userPlan = payload.plan;
    req.isOwner  = payload.isOwner ?? false;
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Please sign in again." });
  }
}

export function generateToken(user) {
  return jwt.sign(
    {
      sub:     user.id,
      email:   user.email,
      plan:    user.plan,
      isOwner: !!user.is_owner,
    },
    "ShepherdsDeskJWT2026SecureAccessKeyX9p4Lm7QzM7v2K8rL5",
    { expiresIn: "7d" }
  );
}

export function requireOwner(req, res, next) {
  if (!req.isOwner) {
    return res.status(403).json({ error: "Owner access required." });
  }
  next();
}
