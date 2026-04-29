// ─── AI SERVICE ───────────────────────────────────────────────────────────────
// All AI logic lives here: client management, tool definitions, prompt
// construction, and output post-processing. Nothing in this file is
// ever sent to the client. Routes receive only finished, sanitized text.

import { TRIAL_PLAN }            from "../middleware/trialGuard.js";
import { getOutputWordLimit }     from "../config/plans.js";

// ── Client ────────────────────────────────────────────────────────────────────
let _ai = null;
async function client() {
  if (!_ai) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    _ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _ai;
}

import { z } from "zod";

// ── SERMON SECTION BUDGETS ────────────────────────────────────────────────────
// These are the canonical word limits for each section.
// They are used BOTH in the prompt and by the backend section trimmer.
// The trimmer enforces what the prompt only requests.
//
// Target total:  1000-1200 words
// Protected:     STRONG CLOSE + ALTAR CALL STARTER are never trimmed
// Trimmed first: MAIN MOVEMENTS (largest, least essential per word)
// Trimmed second: LIFE APPLICATION POINTS

const SERMON_SECTION_BUDGETS = {
  "SCRIPTURE FOUNDATION":    { min: 45,  max: 65 },
  "SERMON INTRODUCTION":     { min: 120, max: 160 },
  "MAIN MOVEMENTS":          { min: 360, max: 460 },
  "LIFE APPLICATION POINTS": { min: 120, max: 160 },
  "PROPHETIC PIVOT":         { min: 90,  max: 120 },
  "STRONG CLOSE":            { min: 140, max: 180 },
  "ALTAR CALL STARTER":      { min: 90,  max: 120 },
};

// Total max if every section hits its ceiling
const SERMON_MAX_WORDS = Object.values(SERMON_SECTION_BUDGETS).reduce((s, b) => s + b.max, 0);
// = 65+160+460+160+120+180+120 = 1265 words

// ── Tool registry ─────────────────────────────────────────────────────────────

export const TOOLS = {
  sermon: {
    label:      "Sermon Builder",
    titleField: "title",
    // maxTokens rationale:
    //   Target output: 1000-1200 words
    //   Worst case if model ignores word count: ~900 words × 1.35 tokens = 1215 tokens
    //   Ending sections budget: ~185 words × 1.35 = 250 tokens
    //   Total needed: 1215 + 250 = 1465 + safety buffer = 1800
    //   Target output: 600-1500 words (paid product range)
    //   1500 words × 1.35 = 2025 tokens + 200 overhead = 2225 needed
    //   maxTokens=2000 gives 175 token buffer above max
    maxTokens:  2000,
    schema: z.object({
      scripture: z.string().min(2).max(300),
      title:     z.string().min(2).max(200),
      topic:     z.string().min(2).max(300),
      tone:      z.enum(["Prophetic","Pastoral","Teaching","Evangelistic","Revivalist","Exhortative"]),
      audience:  z.enum(["General congregation","Men's ministry","Women's ministry","Youth","New believers","Leaders"]),
      style:     z.enum(["3-point expository","Narrative","Topical","Textual","Verse-by-verse"]),
    }),
    buildPrompt: (f) => `You are a sermon preparation assistant. Your job is to produce a full working sermon framework that reads like it was built to be preached — not like a classroom outline or a writing exercise.

TRANSLATION REQUIREMENT: You must quote all scripture in the King James Version (KJV). This is a hard requirement. Do not use NIV, ESV, NLT, NASB, or any other version. KJV only.

VOICE AND STYLE REQUIREMENTS:
Blend these qualities without imitating any specific preacher — the output should feel original, not derivative:
- 60% pastoral clarity, biblical weight, and genuine warmth — grounded, shepherding, authoritative
- 20% Tony Evans-style: punchy biblical explanation, structured clarity, practical punch
- 20% T.D. Jakes-style: emotional build, rhythmic phrasing, pulpit energy and forward movement
The result should feel like its own voice — alive, preachable, and not a clone of anyone.

GLOBAL VOICE RULES:
- Write as if this will be preached, not read from a podium as notes
- Use strong transitions that carry momentum, not mechanical connectors like "moving on to point two"
- Keep structure but do not let the structure sound stiff or academic
- Use natural repetition, forceful phrasing, and cadence that builds
- Reduce academic language, generic commentary, and writing-coach phrases
- The opening must hit with force — not warm up slowly
- The middle must build, not plateau
- Application must feel pastoral and usable, not theoretical
- The close must feel like a real preaching close — not a summary paragraph

TONE DEFINITIONS — apply the selected tone throughout the entire output:

Prophetic: Bold, weighty, urgent, spiritually confrontational. Carry a sense of divine summons and kingdom authority. Strong declarations. A sense of holy burden pressing the hearer toward response. Not chaotic — piercing and purposeful. The ending should naturally intensify.

Revivalist: Fiery, awakening, faith-stirring, altar-driving. Pull people out of coldness, compromise, and passivity. Build momentum and expectancy. Feel like something that could move a room toward repentance, worship, and surrender. The ending should intensify and press for response.

Pastoral: Warm, steady, shepherding, compassionate, restorative — but still strong. Care for people while telling the truth. Sound like a shepherd with conviction, not a lecturer with notes. Clear, practical, healing, and full of concern for the soul. The ending should carry weight with warmth and clarity.

Teaching: Clear, structured, illuminating, grounded in the biblical text. Help people understand the passage, but make it sound like preaching — not classroom instruction. Strong explanation with strong application. Intelligent but not dry. The ending should carry weight with warmth and clarity.

Evangelistic: Direct, convicting, Christ-centered, salvation-driven. Speak to sinners, the undecided, the backslider, and the spiritually numb. Call for repentance, faith, and surrender. Invitational but pressing. The ending must drive clearly toward repentance and response.

Exhortative: Motivating, challenging, strengthening, momentum-building. Push the hearer toward obedience, faithfulness, courage, and action. Stir and charge without becoming shallow hype. The ending should leave the hearer stirred toward action.

STRUCTURE RULES:
- If the style is 3-point expository, preserve the 3-point framework but make it sound preached, not merely outlined. Do not label points as "Movement One" or "Application One" — integrate them with natural flow and strong transitions.
- Do not use labels like "this sermon is about" or "in this message we will cover"
- Altar call language should match the tone — Prophetic and Revivalist should press hard; Pastoral and Teaching should close warmly; Evangelistic should make a clear call to repentance; Exhortative should leave the hearer charged to act.

OUTPUT LENGTH — HARD SECTION WORD LIMITS:
Target: 1000 to 1200 words total. Every section has a strict word ceiling. Stay within these limits:

SCRIPTURE FOUNDATION: 45 to 65 words
SERMON INTRODUCTION: 120 to 160 words
MAIN MOVEMENTS: 360 to 460 words total — if running long, cut this section first
LIFE APPLICATION POINTS: 120 to 160 words — if still running long, cut this section second
PROPHETIC PIVOT: 90 to 120 words
STRONG CLOSE: 140 to 180 words — write this section completely, no shortcuts
ALTAR CALL STARTER: 90 to 120 words — write this section completely, end on a full sentence

COMPLETION RULE — NON-NEGOTIABLE:
STRONG CLOSE and ALTAR CALL STARTER must always be written completely. Never cut them short. A 1000-word sermon that ends with a complete altar call is better than a 1200-word sermon that stops mid-invitation. If the body sections run long, trim them — never the ending. The final word of ALTAR CALL STARTER must be the last word of a complete sentence. Do not stop mid-sentence under any circumstance.

LANGUAGE: Avoid these overused phrases — do not use them anywhere in the output: tension, journey, unpack, unpacking, dive in, dive deep, explore, narrative, resonate, let that sink in, in today's world, transformative, transformational, liminal, seamlessly, it is worth noting, at the end of the day. Use direct, specific, varied language. Never repeat the same word or phrase in consecutive sentences.

Return using these exact plain section headers with no asterisks, bullets, or markdown formatting:

SCRIPTURE FOUNDATION
SERMON INTRODUCTION
MAIN MOVEMENTS
LIFE APPLICATION POINTS
PROPHETIC PIVOT
STRONG CLOSE
ALTAR CALL STARTER`,
  },

  "bible-study": {
    label:      "Bible Study Builder",
    titleField: "topic",
    // Target: 650-800 words. Output hard cap: 1000 words.
    // 1000 words × 1.35 = 1350 tokens + 100 overhead = 1450.
    // maxTokens=1600 gives 150 token completion buffer.
    maxTokens:  1600,
    schema: z.object({
      scripture: z.string().min(2).max(300),
      topic:     z.string().min(2).max(300),
      audience:  z.enum(["General adult group","Men's group","Women's group","Youth group","New believers class","Leadership class"]),
      tone:      z.enum(["Practical","Devotional","Academic","Conversational","Expository"]),
      depth:     z.enum(["Introductory","Moderate","In-depth","Advanced"]),
    }),
buildPrompt: (f) => `You are a ministry content assistant helping prepare a Bible study lesson. All content must be biblically accurate and teachable.

TRANSLATION REQUIREMENT: You must quote all scripture in the King James Version (KJV). This is a hard requirement. Do not use NIV, ESV, NLT, NASB, or any other version. KJV only.

Scripture: ${f.scripture}
Topic: ${f.topic}
Audience: ${f.audience}
Teaching Tone: ${f.tone}
Depth Level: ${f.depth}

OUTPUT LENGTH — HARD SECTION WORD LIMITS:
Target: 650 to 800 words total. Stay within these section ceilings:

LESSON OVERVIEW: 50 to 70 words
SCRIPTURE CONTEXT: 80 to 100 words
CORE TEACHING POINTS: 220 to 260 words total — cut here if running long
DISCUSSION PROMPTS: 80 to 100 words (5 questions)
LIFE TAKEAWAYS: 75 to 90 words
CLOSING REFLECTION: 70 to 85 words — always write this section completely

CLOSING REFLECTION is protected. Never shorten or omit it. If running long, cut CORE TEACHING POINTS first. The final sentence of CLOSING REFLECTION must be complete.

LANGUAGE: Avoid: tension, journey, unpack, unpacking, dive in, dive deep, explore, narrative, resonate, let that sink in, in today's world, transformative, transformational. Use direct, specific, varied language.

LESSON OVERVIEW
SCRIPTURE CONTEXT
CORE TEACHING POINTS
DISCUSSION PROMPTS
LIFE TAKEAWAYS
CLOSING REFLECTION`,
  },
  announcement: {
    label:      "Announcement Builder",
    titleField: "eventName",
    maxTokens:  700,
    schema: z.object({
      eventName: z.string().min(2).max(200),
      date:      z.string().min(2).max(100),
      time:      z.string().min(2).max(100),
      location:  z.string().min(2).max(200),
      emphasis:  z.string().min(2).max(300),
      speaker:   z.string().max(200).optional(),
      attire:    z.string().max(200).optional(),
    }),
    buildPrompt: (f) => `You are a ministry communications assistant helping create polished church announcements. TRANSLATION REQUIREMENT: Quote all scripture in the King James Version (KJV) only.

Event: ${f.eventName}
Date: ${f.date}
Time: ${f.time}
Location: ${f.location}
Speaker: ${f.speaker || "Not listed"}
Key Emphasis: ${f.emphasis}
Attire: ${f.attire || "Not specified"}

OUTPUT LENGTH: Keep each section tight and usable. Short Announcement: 2-3 sentences. Expanded Announcement: 1 solid paragraph. Flyer-Ready Wording: 4-6 lines. Social-Ready Wording: 3-5 lines. Finish all four sections completely.

Return using these exact plain section headers:

SHORT ANNOUNCEMENT
EXPANDED ANNOUNCEMENT
FLYER-READY WORDING
SOCIAL-READY WORDING`,
  },

  caption: {
    label:      "Caption Builder",
    titleField: "subject",
    maxTokens:  700,
    schema: z.object({
      subject:  z.string().min(2).max(300),
      audience: z.enum(["General church audience","Unbelievers / seekers","Youth","Women","Men","Leaders"]),
      platform: z.enum(["Instagram","Facebook","X (Twitter)","TikTok / Reels","All platforms"]),
      tone:     z.enum(["Encouraging","Prophetic declaration","Conversational","Challenge-based","Devotional","Promotional"]),
      goal:     z.enum(["Drive Sunday attendance","Share a truth / insight","Promote an event","Encourage engagement","Inspire sharing"]),
    }),
    buildPrompt: (f) => `You are a ministry communications assistant helping create church social media captions. All content must be clear and church-appropriate. TRANSLATION REQUIREMENT: Quote all scripture in the King James Version (KJV) only.

Subject: ${f.subject}
Target Audience: ${f.audience}
Platform: ${f.platform}
Tone: ${f.tone}
Goal: ${f.goal}

OUTPUT LENGTH: Each caption option should be 2-4 sentences. Short Promo Version: 1-2 sentences. Engagement Prompt: 1 sentence or question. Finish all five sections completely.

Return using these exact plain section headers:

CAPTION OPTION 1
CAPTION OPTION 2
CAPTION OPTION 3
SHORT PROMO VERSION
ENGAGEMENT PROMPT`,
  },

  "follow-up": {
    label:      "Follow-Up Builder",
    titleField: "occasion",
    maxTokens:  700,
    schema: z.object({
      recipient: z.enum(["First-time church guest","Returning guest","New member","Volunteer","Prayer request response","Event attendee","Absent member"]),
      occasion:  z.string().min(2).max(300),
      tone:      z.enum(["Warm and welcoming","Pastoral and caring","Encouraging","Inviting","Official but kind"]),
      church:    z.string().min(2).max(200),
      pastor:    z.string().min(2).max(200),
    }),
    buildPrompt: (f) => `You are a ministry communications assistant helping a pastor write follow-up messages. All messages must be genuine, warm, and respectful. TRANSLATION REQUIREMENT: Quote all scripture in the King James Version (KJV) only.

Recipient Type: ${f.recipient}
Occasion/Context: ${f.occasion}
Tone: ${f.tone}
Church: ${f.church}
From: ${f.pastor}

OUTPUT LENGTH: Text Message Version: 2-4 sentences. Email Version: 3-5 short paragraphs with subject line. Short Reminder Version: 1-2 sentences. Finish all three sections completely.

Return using these exact plain section headers:

TEXT MESSAGE VERSION
EMAIL VERSION
SHORT REMINDER VERSION`,
  },
};

// ── Validation ────────────────────────────────────────────────────────────────

export function getTool(toolId) {
  return TOOLS[toolId] ?? null;
}

export function validateToolInput(toolId, body) {
  const tool = getTool(toolId);
  if (!tool) return { success: false, error: "Tool not found.", notFound: true };
  const result = tool.schema.safeParse(body);
  if (!result.success) return { success: false, error: result.error.issues[0].message };
  return { success: true, data: result.data };
}

// ── Generation ────────────────────────────────────────────────────────────────

export async function generate(toolId, validatedInput) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new GenerationError("service_unavailable", "API key not configured");
  }
  const tool = TOOLS[toolId];
  const ai   = await client();
  const msg  = await ai.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: tool.maxTokens,
    messages:   [{ role: "user", content: tool.buildPrompt(validatedInput) }],
  });
  const raw = msg.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();

  if (toolId === "sermon") {
    return processSermonOutput(raw, msg.stop_reason);
  }
  if (toolId === "bible-study") {
    return processBibleStudyOutput(raw, msg.stop_reason);
  }
  // All tools: enforce output word limit
  return enforceWordLimit(raw, toolId);
}

// ── Sermon output processor ───────────────────────────────────────────────────
// Two responsibilities:
//   1. COMPLETION CHECK — if stop_reason=max_tokens, detect and handle truncation
//   2. LENGTH TRIMMER — if total word count > 1500, trim overlong sections
//      while never touching STRONG CLOSE or ALTAR CALL STARTER

function processSermonOutput(output, stopReason) {
  // Step 1: completion check
  const checked = ensureSermonComplete(output, stopReason);
  // Step 2: trim if still over target ceiling
  return trimSermonIfOverlength(checked);
}

// ── Step 1: Completion check ──────────────────────────────────────────────────

function ensureSermonComplete(output, stopReason) {
  if (stopReason === "end_turn") return output;

  const trimmed  = output.trimEnd();
  const lastChar = trimmed.slice(-1);
  const endsCleanly = lastChar === "." || lastChar === "!" || lastChar === "?" || lastChar === '"';

  if (endsCleanly) {
    console.warn("[sermon] stop_reason=max_tokens but ends cleanly — budget adequate");
    return trimmed;
  }

  // Truncated mid-sentence — use shared repair helper
  console.error("[sermon] TRUNCATION DETECTED: stop_reason=max_tokens, mid-sentence cut");
  const repaired = repairTruncation(trimmed);
  if (repaired.length < trimmed.length) {
    console.error(`[sermon] Repaired: ${repaired.split(/\s+/).length} words`);
  }
  return repaired;
}

// ── Step 2: Length trimmer ────────────────────────────────────────────────────
// If the total word count exceeds 1500, trim MAIN MOVEMENTS and then
// LIFE APPLICATION POINTS down to their hard maximums.
// PROPHETIC PIVOT, STRONG CLOSE, and ALTAR CALL STARTER are never touched.

const SECTION_ORDER = [
  "SCRIPTURE FOUNDATION",
  "SERMON INTRODUCTION",
  "MAIN MOVEMENTS",
  "LIFE APPLICATION POINTS",
  "PROPHETIC PIVOT",
  "STRONG CLOSE",
  "ALTAR CALL STARTER",
];

const TRIM_TARGETS = {
  "MAIN MOVEMENTS":       SERMON_SECTION_BUDGETS["MAIN MOVEMENTS"].max,
  "LIFE APPLICATION POINTS": SERMON_SECTION_BUDGETS["LIFE APPLICATION POINTS"].max,
};

const SERMON_WORD_CEILING = 1200; // hard cap matching paid product spec

function trimSermonIfOverlength(output) {
  const wordCount = output.split(/\s+/).filter(Boolean).length;
  if (wordCount <= SERMON_WORD_CEILING) return output;

  console.warn(`[sermon] Word count ${wordCount} > ${SERMON_WORD_CEILING} — trimming body sections`);

  // Parse into sections
  const sections = parseSermonSections(output);
  if (!sections) {
    console.warn("[sermon] Could not parse sections for trimming — returning untrimmed");
    return output;
  }

  // Trim overlong body sections to their hard max
  let trimmed = false;
  for (const [sectionName, maxWords] of Object.entries(TRIM_TARGETS)) {
    if (sections[sectionName]) {
      const sectionWords = sections[sectionName].split(/\s+/).filter(Boolean);
      if (sectionWords.length > maxWords) {
        // Find the last sentence end within the word limit
        const target = sectionWords.slice(0, maxWords).join(" ");
        const lastPeriod = Math.max(
          target.lastIndexOf(". "),
          target.lastIndexOf("! "),
          target.lastIndexOf("? "),
          target.lastIndexOf(".\n"),
          target.lastIndexOf("!\n")
        );
        sections[sectionName] = lastPeriod > target.length * 0.6
          ? target.slice(0, lastPeriod + 1).trimEnd()
          : target.trimEnd();
        trimmed = true;
        console.warn(`[sermon] Trimmed ${sectionName} to ${sections[sectionName].split(/\s+/).length} words`);
      }
    }
  }

  if (!trimmed) return output;

  // Reassemble
  return reassembleSermon(sections);
}

function parseSermonSections(output) {
  return parseSections(output, SECTION_ORDER);
}

function reassembleSermon(sections) {
  return reassembleSections(sections, SECTION_ORDER);
}

// ── Bible study output processor ─────────────────────────────────────────────
// Mirrors the sermon processor: checks completion, enforces word ceiling.
// CLOSING REFLECTION is protected — never trimmed.

const BS_SECTION_ORDER = [
  "LESSON OVERVIEW",
  "SCRIPTURE CONTEXT",
  "CORE TEACHING POINTS",
  "DISCUSSION PROMPTS",
  "LIFE TAKEAWAYS",
  "CLOSING REFLECTION",
];

const BS_TRIM_SECTION = "CORE TEACHING POINTS"; // trim here first if over ceiling
const BS_WORD_CEILING = 1000;

function processBibleStudyOutput(output, stopReason) {
  const checked = ensureStudyComplete(output, stopReason);
  return trimBibleStudyIfOverlength(checked);
}

function ensureStudyComplete(output, stopReason) {
  if (stopReason === "end_turn") return output;

  const trimmed  = output.trimEnd();
  const lastChar = trimmed.slice(-1);
  if ([".", "!", "?", '"'].includes(lastChar)) {
    console.warn("[bible-study] stop_reason=max_tokens but ends cleanly");
    return trimmed;
  }

  console.error("[bible-study] TRUNCATION DETECTED — repairing");
  return repairTruncation(trimmed);
}

function trimBibleStudyIfOverlength(output) {
  const words = output.split(/\s+/).filter(Boolean).length;
  if (words <= BS_WORD_CEILING) return output;
  console.warn(`[bible-study] Word count \${words} > \${BS_WORD_CEILING} — trimming`);

  const sections = parseSections(output, BS_SECTION_ORDER);
  if (!sections) return output;

  const ctp = sections[BS_TRIM_SECTION];
  if (ctp) {
    const ctpWords = ctp.split(/\s+/).filter(Boolean);
    const excess = words - BS_WORD_CEILING;
    const targetLen = Math.max(ctpWords.length - excess, 180);
    const slice = ctpWords.slice(0, targetLen).join(" ");
    const lastEnd = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
    sections[BS_TRIM_SECTION] = lastEnd > slice.length * 0.5
      ? slice.slice(0, lastEnd + 1).trimEnd()
      : slice.trimEnd();
  }
  return reassembleSections(sections, BS_SECTION_ORDER);
}

// ── Shared output word-limit enforcer ─────────────────────────────────────────
// Runs on all non-sermon/non-bible-study tools.
// Cuts at the nearest sentence boundary if over the tool's word limit.

function enforceWordLimit(output, toolId) {
  const limit = getOutputWordLimit(toolId);
  const words = output.split(/\s+/).filter(Boolean);
  if (words.length <= limit) return output;
  const sliced    = words.slice(0, limit).join(" ");
  const lastEnd   = Math.max(sliced.lastIndexOf(". "), sliced.lastIndexOf("! "), sliced.lastIndexOf("? "));
  return lastEnd > sliced.length * 0.6 ? sliced.slice(0, lastEnd + 1).trimEnd() : sliced.trimEnd();
}

// ── Shared truncation repair ───────────────────────────────────────────────────
// Finds the last complete sentence in the second half of the text and cuts there.

function repairTruncation(text) {
  const candidates = [". ", "! ", "? ", ".\n", "!\n", "?\n"];
  let lastEnd = -1;
  for (const c of candidates) {
    const idx = text.lastIndexOf(c);
    if (idx > lastEnd) lastEnd = idx;
  }
  if (lastEnd > text.length * 0.5) {
    console.error(`[repair] Cut at char \${lastEnd} (total was \${text.length})`);
    return text.slice(0, lastEnd + 1).trimEnd();
  }
  return text;
}

// ── Shared section parser ─────────────────────────────────────────────────────

function parseSections(output, sectionOrder) {
  const result = {};
  for (let i = 0; i < sectionOrder.length; i++) {
    const header = sectionOrder[i];
    const next   = sectionOrder[i + 1];
    const start  = output.indexOf(header);
    if (start === -1) continue;
    const contentStart = start + header.length;
    const end = next ? output.indexOf(next, contentStart) : output.length;
    result[header] = end === -1
      ? output.slice(contentStart).trim()
      : output.slice(contentStart, end).trim();
  }
  return sectionOrder.every(s => result[s]) ? result : null;
}

function reassembleSections(sections, order) {
  return order.map(s => `\${s}\n\${sections[s]}`).join("\n\n");
}

// ── Trial truncation ──────────────────────────────────────────────────────────
// Server-side only. The client never sees this logic.

const TRIAL_CUT_MARKERS = [
  "LIFE APPLICATION POINTS",
  "PROPHETIC PIVOT",
  "STRONG CLOSE",
  "ALTAR CALL STARTER",
];

const TRIAL_UPGRADE_NOTICE = [
  "",
  "────────────────────────────────────────",
  "LIFE APPLICATION POINTS",
  "Unlock the full sermon with a paid plan. A paid account delivers the complete",
  "framework — application points that connect scripture to real life, a prophetic",
  "pivot that sharpens the message, a close that lands with weight, and altar call",
  "language crafted to move people toward response.",
  "",
  "PROPHETIC PIVOT",
  "Available on paid plans — the moment where truth presses the hearer toward decision.",
  "",
  "STRONG CLOSE",
  "Available on paid plans — a complete preaching close, not a summary paragraph.",
  "",
  "ALTAR CALL STARTER",
  "Available on paid plans — pastoral invitation language matched to your selected tone.",
  "",
  "────────────────────────────────────────",
  "This is a trial preview. Your trial includes the Scripture Foundation, Sermon",
  "Introduction, and Main Movements. Upgrade to generate complete, ready-to-preach",
  "sermon frameworks across all tools without limits.",
].join("\n");

function truncateSermonForTrial(output) {
  let cutIndex = -1;
  for (const marker of TRIAL_CUT_MARKERS) {
    const idx = output.indexOf(marker);
    if (idx !== -1 && (cutIndex === -1 || idx < cutIndex)) cutIndex = idx;
  }
  if (cutIndex === -1) cutIndex = Math.min(400, output.length);
  return output.slice(0, cutIndex).trimEnd() + TRIAL_UPGRADE_NOTICE;
}

export function applyPlanGating(toolId, output, userPlan) {
  if (userPlan === TRIAL_PLAN && toolId === "sermon") {
    return truncateSermonForTrial(output);
  }
  return output;
}

// ── Error class ───────────────────────────────────────────────────────────────

export class GenerationError extends Error {
  constructor(type, internalMessage) {
    super(internalMessage);
    this.type = type;
  }
}
