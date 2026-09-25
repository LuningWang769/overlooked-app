#!/usr/bin/env node
// Generates one new "Overlooked" issue via the Claude API, checks that its
// nonprofit link(s) actually resolve, and appends it to issues.json.
// Run daily by .github/workflows/daily-issue.yml — no human review in the loop,
// so the link check below is the only safety net against a broken/fabricated URL.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ISSUES_PATH = path.join(__dirname, "..", "issues.json");

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY environment variable.");
  process.exit(1);
}

const FOCUS_CATEGORIES = ["Women's rights", "Education rights", "Immigrant rights"];

async function loadIssues() {
  const raw = await fs.readFile(ISSUES_PATH, "utf-8");
  return JSON.parse(raw);
}

async function saveIssues(issues) {
  await fs.writeFile(ISSUES_PATH, JSON.stringify(issues, null, 2) + "\n");
}

// Keep roughly half the list in the three focus categories over time.
function pickTargetCategory(issues) {
  const focusCount = issues.filter((i) => FOCUS_CATEGORIES.includes(i.cat)).length;
  const wantFocus = focusCount <= issues.length / 2;
  return wantFocus ? FOCUS_CATEGORIES[Math.floor(Math.random() * FOCUS_CATEGORIES.length)] : null;
}

async function urlIsAlive(url) {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8000) });
    if (res.ok) return true;
    // Some sites block HEAD requests; retry with GET before giving up.
    if (res.status === 405 || res.status === 403) {
      const res2 = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(8000) });
      return res2.ok;
    }
    return false;
  } catch {
    return false;
  }
}

async function generateIssue(existingIssues, targetCategory) {
  const recentTitles = existingIssues
    .slice(-30)
    .map((i) => `- [${i.cat}] ${i.hook}`)
    .join("\n");

  const categoryInstruction = targetCategory
    ? `The "cat" field must be exactly "${targetCategory}".`
    : `Pick a "cat" that is NOT "Women's rights", "Education rights", or "Immigrant rights" — any other real, under-covered social, civil, or economic issue.`;

  const systemPrompt = `You write content for "Overlooked," an app that surfaces one under-covered
social/civil issue a day and links to real nonprofits working on it.

Rules:
- ${categoryInstruction}
- Across the full set of issues over time, alternate between ones that resonate more with
  progressive/Democratic-leaning readers and ones that resonate more with conservative/
  Republican-leaning readers, so the collection feels balanced overall even though any single
  issue doesn't have to be. Do not make every issue centrist or both-sides.
- "hook": one short, punchy sentence (occasionally two short ones) written in second person or
  as a provocative statement, meant to trigger an emotional reaction. NOT a neutral headline.
- "desc": 1–2 factual, neutral-toned sentences of context. No editorializing.
- Every organization in "orgs" MUST be a real, currently operating nonprofit with its correct
  official homepage URL. If you are not highly confident of an org's name and URL, do not
  include it — accuracy matters more than including two orgs.
- Do not reuse an issue, hook, or organization already used below.
- Output ONLY a raw JSON object, no markdown fences, no commentary, in exactly this shape:
  {"cat": "string", "hook": "string", "desc": "string", "orgs": [{"name": "string", "url": "https://...", "blurb": "one short sentence"}]}
  (1–2 entries in "orgs".)

Issues already used recently, do not repeat these or anything too similar:
${recentTitles}`;

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: "Generate one new issue now." }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 2000,
      },
    }),
  }
);

if (!res.ok) {
  throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
}

const data = await res.json();

const text = data.candidates?.[0]?.content?.parts
  ?.map((part) => part.text || "")
  .join("")
  .trim();

if (!text) {
  throw new Error("Gemini returned no text.");
}

return JSON.parse(text);
}
  
function looksValid(draft) {
  return (
    draft &&
    typeof draft.cat === "string" &&
    typeof draft.hook === "string" &&
    typeof draft.desc === "string" &&
    Array.isArray(draft.orgs) &&
    draft.orgs.length >= 1 &&
    draft.orgs.every((o) => o.name && o.url && o.url.startsWith("https://"))
  );
}

async function main() {
  const issues = await loadIssues();
  const targetCategory = pickTargetCategory(issues);

  let candidate = null;
  for (let attempt = 1; attempt <= 3 && !candidate; attempt++) {
    let draft;
    try {
      draft = await generateIssue(issues, targetCategory);
    } catch (err) {
      console.warn(`Attempt ${attempt}: generation failed (${err.message}), retrying...`);
      continue;
    }

    if (!looksValid(draft)) {
      console.warn(`Attempt ${attempt}: malformed response, retrying...`);
      continue;
    }

    const linkChecks = await Promise.all(draft.orgs.map((o) => urlIsAlive(o.url)));
    if (linkChecks.every(Boolean)) {
      candidate = draft;
    } else {
      console.warn(`Attempt ${attempt}: one or more org links did not resolve, retrying...`);
    }
  }

  if (!candidate) {
    console.error("Could not produce a valid issue with working links after 3 attempts. Skipping today — the app keeps running on its existing list.");
    process.exit(0); // don't fail the workflow over a skipped day
  }

  issues.push(candidate);
  await saveIssues(issues);
  console.log(`Added: [${candidate.cat}] ${candidate.hook}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
