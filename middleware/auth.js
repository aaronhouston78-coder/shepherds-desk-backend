import jwt from "jsonwebtoken";
import { getDb } from "../db/database.js";

const JWT_SECRET =
  process.env.JWT_SECRET || "ShepherdsDeskJWT2026SecureAccessKeyX9p4Lm7QzM7v2K8rL5";

function getEffectiveAccess(db, userId) {
  const user = db.prepare(`
    SELECT id, email, plan, is_owner
    FROM users
    WHERE id = ?
    LIMIT 1
  `).get(userId);

  if (!user) return null;

  if (user.is_owner) {
    return {
      user,
      effectivePlan: "owner",
      isOwner: true,
      workspaceId: null,
      teamRole: null,
    };
  }

  if (["starter", "growth", "team"].includes(user.plan)) {
    return {
      user,
      effectivePlan: user.plan,
      isOwner: false,
      workspaceId: null,
      teamRole: null,
    };
  }

  const membership = db.prepare(`
    SELECT
      tm.workspace_id,
      tm.role,
      owner.plan AS owner_plan
    FROM team_members tm
    JOIN team_workspaces tw ON tw.id = tm.workspace_id
    JOIN users owner ON owner.id = tw.owner_user_id
    WHERE tm.user_id = ?
      AND tm.status = 'active'
    LIMIT 1
  `).get(userId);

  if (membership && membership.owner_plan === "team") {
    return {
      user,
      effectivePlan: "team",
      isOwner: false,
      workspaceId: membership.workspace_id,
      teamRole: membership.role,
    };
  }

  return {
    user,
    effectivePlan: user.plan,
    isOwner: false,
    workspaceId: null,
    teamRole: null,
  };
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required." });
  }

  const token = header.slice(7);

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    const access = getEffectiveAccess(db, payload.sub);

    if (!access) {
      return res.status(401).json({ error: "No account found with that email address." });
    }

    req.userId = access.user.id;
    req.userEmail = access.user.email;
    req.userPlan = access.effectivePlan;
    req.isOwner = access.isOwner;
    req.workspaceId = access.workspaceId;
    req.teamRole = access.teamRole;

    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Please sign in again." });
  }
}

export function generateToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      plan: user.plan,
      isOwner: !!user.is_owner,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

export function requireOwner(req, res, next) {
  if (!req.isOwner) {
    return res.status(403).json({ error: "Owner access required." });
  }
  next();
}