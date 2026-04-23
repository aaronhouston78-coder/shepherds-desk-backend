// ─── REQUEST VALIDATION MIDDLEWARE ───────────────────────────────────────────
// Schema-based input validation. Applied per-route.
// Validated data is attached to req.validated — routes only read from there.

import { getTool, validateToolInput } from "../services/aiService.js";

// Validate and parse the body for a generation request.
// Attaches req.validated.toolInput on success.
export function validateGenerationRequest(req, res, next) {
  const { toolId } = req.params;
  const result = validateToolInput(toolId, req.body);

  if (result.notFound) {
    return res.status(404).json({ error: "Tool not found." });
  }
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  req.validated = { toolId, toolInput: result.data };
  next();
}

// Validate saving a generation — output + formData must be present.
export function validateSaveRequest(req, res, next) {
  const { toolId, output, formData } = req.body;
  if (!toolId || !output || !formData) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  if (!getTool(toolId)) {
    return res.status(400).json({ error: "Invalid tool." });
  }
  // Sanitize: truncate output at a safe limit
  req.validated = {
    toolId,
    output:   String(output).slice(0, 20000),
    formData: formData,
  };
  next();
}

// Validate saving a template.
export function validateTemplateRequest(req, res, next) {
  const { toolId, name, formData, description } = req.body;
  if (!toolId || !name || !formData) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  if (!getTool(toolId)) {
    return res.status(400).json({ error: "Invalid tool." });
  }
  req.validated = {
    toolId,
    name:        String(name).trim().slice(0, 100),
    description: description ? String(description).slice(0, 300) : "",
    formData,
  };
  next();
}
