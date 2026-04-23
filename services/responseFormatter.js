// ─── RESPONSE FORMATTER ───────────────────────────────────────────────────────
// All client-facing data shaping happens here.
// No internal IDs, plan names, credit logic, or provider details ever leak.
// Every function returns a plain object safe to serialize to the client.

// ── Generation response ───────────────────────────────────────────────────────
// Returns only what the UI needs. Internal cost/plan fields are not included.

export function formatGenerationResponse(output, creditsUsed, planCredits, creditCost) {
  const newUsed    = creditsUsed + creditCost;
  const remaining  = Math.max(0, planCredits - newUsed);
  return {
    output,
    usage: {
      remaining,
      used:    newUsed,
      allowed: planCredits,
    },
  };
}

// ── Usage response ────────────────────────────────────────────────────────────

export function formatUsageResponse(creditsUsed, planCredits, allTime, byTool) {
  return {
    creditsUsed:    creditsUsed,
    creditsAllowed: planCredits,
    remaining:      Math.max(0, planCredits - creditsUsed),
    allTimeCredits: allTime,
    byTool,
  };
}

// ── Saved generation ──────────────────────────────────────────────────────────

export function formatSavedRow(row) {
  return {
    id:        row.id,
    toolId:    row.tool_id,
    toolLabel: row.tool_label,
    title:     row.title,
    formData:  JSON.parse(row.form_data),
    output:    row.output,
    createdAt: row.created_at,
  };
}

// ── Template ──────────────────────────────────────────────────────────────────

export function formatTemplate(row) {
  return {
    id:          row.id,
    toolId:      row.tool_id,
    toolLabel:   row.tool_label,
    name:        row.name,
    description: row.description,
    formData:    JSON.parse(row.form_data),
    createdAt:   row.created_at,
  };
}

// ── Error responses ───────────────────────────────────────────────────────────
// Uniform safe error format. Never includes stack traces or internal messages.

export function generationErrorResponse(errType) {
  const messages = {
    service_unavailable: "Content generation is temporarily unavailable. Please contact support.",
    busy:                "The content service is temporarily busy. Please wait a moment and try again.",
    unavailable:         "The content service is temporarily unavailable. Please try again shortly.",
    unknown:             "Content could not be generated. Please try again.",
  };
  return { error: messages[errType] ?? messages.unknown };
}
