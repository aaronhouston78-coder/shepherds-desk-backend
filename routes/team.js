import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getDb } from "../db/database.js";
import { getSeatLimit, hasTeamAccess } from "../config/plans.js";

const router = Router();
router.use(requireAuth);

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getWorkspaceForOwner(db, userId) {
  return db.prepare(`
    SELECT tw.*
    FROM team_workspaces tw
    WHERE tw.owner_user_id = ?
    LIMIT 1
  `).get(userId);
}

function getWorkspaceForMember(db, userId) {
  return db.prepare(`
    SELECT tw.*
    FROM team_members tm
    JOIN team_workspaces tw ON tw.id = tm.workspace_id
    WHERE tm.user_id = ?
      AND tm.status = 'active'
    LIMIT 1
  `).get(userId);
}

function getWorkspaceMembers(db, workspaceId) {
  return db.prepare(`
    SELECT
      tm.id,
      tm.workspace_id,
      tm.user_id,
      tm.role,
      tm.status,
      tm.created_at,
      u.name,
      u.email,
      u.plan,
      u.is_owner
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.workspace_id = ?
    ORDER BY tm.created_at ASC
  `).all(workspaceId);
}

router.get("/workspace", (req, res) => {
  const db = getDb();

  let workspace = getWorkspaceForOwner(db, req.userId);
  let owner = true;

  if (!workspace) {
    workspace = getWorkspaceForMember(db, req.userId);
    owner = false;
  }

  if (!workspace) {
    return res.json({
      workspace: null,
      members: [],
      owner: false,
      seatLimit: getSeatLimit(req.userPlan),
      canManageTeam: false,
    });
  }

  const members = getWorkspaceMembers(db, workspace.id);

  return res.json({
    workspace,
    members,
    owner,
    seatLimit: workspace.seat_limit ?? getSeatLimit(req.userPlan),
    canManageTeam: owner && hasTeamAccess(req.userPlan),
  });
});

router.post("/workspace", (req, res) => {
  const db = getDb();

  if (!hasTeamAccess(req.userPlan)) {
    return res.status(403).json({ error: "Team access required." });
  }

  let workspace = getWorkspaceForOwner(db, req.userId);
  if (workspace) {
    return res.json({ workspace });
  }

  const seatLimit = getSeatLimit(req.userPlan);
  const name =
    String(req.body?.name || "My Team Workspace").trim().slice(0, 120) ||
    "My Team Workspace";

  const id = makeId();

  db.prepare(`
    INSERT INTO team_workspaces (id, owner_user_id, name, seat_limit, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(id, req.userId, name, seatLimit);

  workspace = db.prepare(`
    SELECT *
    FROM team_workspaces
    WHERE id = ?
    LIMIT 1
  `).get(id);

  return res.status(201).json({ workspace });
});

router.post("/members", (req, res) => {
  const db = getDb();

  if (!hasTeamAccess(req.userPlan)) {
    return res.status(403).json({ error: "Team access required." });
  }

  const workspace = getWorkspaceForOwner(db, req.userId);
  if (!workspace) {
    return res.status(400).json({ error: "Create your team workspace first." });
  }

  const email = String(req.body?.email || "").trim().toLowerCase();
  const role = String(req.body?.role || "member").trim().toLowerCase();

  if (!email) {
    return res.status(400).json({ error: "Member email is required." });
  }

  if (!["member", "admin"].includes(role)) {
    return res.status(400).json({ error: "Role must be member or admin." });
  }

  const user = db.prepare(`
    SELECT id, name, email, plan, is_owner
    FROM users
    WHERE lower(email) = lower(?)
    LIMIT 1
  `).get(email);

  if (!user) {
    return res.status(404).json({ error: "No account found with that email address." });
  }

  if (user.id === req.userId) {
    return res.status(400).json({ error: "You already own this team workspace." });
  }

  if (user.is_owner) {
    return res.status(400).json({ error: "Owner accounts cannot be added as team members." });
  }

  const existingMemberOfAnotherTeam = db.prepare(`
    SELECT tm.id
    FROM team_members tm
    WHERE tm.user_id = ?
      AND tm.status = 'active'
    LIMIT 1
  `).get(user.id);

  if (existingMemberOfAnotherTeam) {
    return res.status(400).json({ error: "That user already belongs to a team workspace." });
  }

  const existing = db.prepare(`
    SELECT id
    FROM team_members
    WHERE workspace_id = ?
      AND user_id = ?
    LIMIT 1
  `).get(workspace.id, user.id);

  if (existing) {
    return res.status(400).json({ error: "That user is already on your team." });
  }

  const currentCount = db.prepare(`
    SELECT COUNT(*) AS total
    FROM team_members
    WHERE workspace_id = ?
      AND status = 'active'
  `).get(workspace.id).total;

  if (currentCount >= workspace.seat_limit) {
    return res.status(400).json({
      error: `Seat limit reached. This team allows ${workspace.seat_limit} members.`,
    });
  }

  const memberId = makeId();

  db.prepare(`
    INSERT INTO team_members (id, workspace_id, user_id, role, status)
    VALUES (?, ?, ?, ?, 'active')
  `).run(memberId, workspace.id, user.id, role);

  db.prepare(`
    UPDATE team_workspaces
    SET updated_at = datetime('now')
    WHERE id = ?
  `).run(workspace.id);

  const members = getWorkspaceMembers(db, workspace.id);
  return res.status(201).json({ members });
});

router.delete("/members/:memberId", (req, res) => {
  const db = getDb();

  if (!hasTeamAccess(req.userPlan)) {
    return res.status(403).json({ error: "Team access required." });
  }

  const workspace = getWorkspaceForOwner(db, req.userId);
  if (!workspace) {
    return res.status(400).json({ error: "No team workspace found." });
  }

  const member = db.prepare(`
    SELECT id
    FROM team_members
    WHERE id = ?
      AND workspace_id = ?
    LIMIT 1
  `).get(req.params.memberId, workspace.id);

  if (!member) {
    return res.status(404).json({ error: "Member not found." });
  }

  db.prepare(`
    DELETE FROM team_members
    WHERE id = ?
  `).run(req.params.memberId);

  db.prepare(`
    UPDATE team_workspaces
    SET updated_at = datetime('now')
    WHERE id = ?
  `).run(workspace.id);

  const members = getWorkspaceMembers(db, workspace.id);
  return res.json({ deleted: true, members });
});

export default router;