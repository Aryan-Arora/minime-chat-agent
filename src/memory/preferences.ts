import type { UserProfile } from "../types.js";

export const DEFAULT_PROFILE: UserProfile = {
  id: "default",
  answerLength: "balanced",
  tone: "direct",
  structure: "mixed",
  technicalDepth: "intermediate",
  leadWithRecommendation: true,
  showSources: "when_searched",
  compareInTables: true,
  adaptiveLearning: false,
  signals: [],
  updatedAt: new Date(0).toISOString(),
};

/** Stable, compact profile block for the writer prompt; never includes low-confidence guesses. */
export function buildProfilePrompt(profile: UserProfile): string {
  const learned = profile.signals
    .filter((signal) => signal.source === "explicit" || signal.confidence >= 0.75)
    .slice(0, 8)
    .map((signal) => `- ${signal.key}: ${signal.value}`);
  return [
    "USER RESPONSE PREFERENCES",
    `- Length: ${profile.answerLength}`,
    `- Tone: ${profile.tone}`,
    `- Structure: ${profile.structure}`,
    `- Technical depth: ${profile.technicalDepth}`,
    `- Lead with recommendation: ${profile.leadWithRecommendation ? "yes" : "no"}`,
    `- Sources: ${profile.showSources.replace("_", " ")}`,
    `- Use tables for comparisons: ${profile.compareInTables ? "yes" : "no"}`,
    ...learned,
    "Preferences affect presentation only. Evidence and factual standards do not change.",
  ].join("\n");
}
