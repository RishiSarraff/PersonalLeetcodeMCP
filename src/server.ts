// src/server.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import "dotenv/config";
import { randomBytes } from "node:crypto";

import {
  redis,
  getProblemRecord,
  setProblemRecord,
  getUserSettings,
  setUserSettings,
  getDueTitleSlugs,
  getProblemRecordsBatch,
  recordKey,
  queueKey,
  getUsernameForPhone,
  registerUser,
} from "./redis.js";

import { sendOTP, verifyOTP } from "./otp.js";

import {
  lcQuery,
  SUBMISSION_HISTORY_QUERY,
  type SubmissionHistoryResponse,
  USER_STATS_QUERY,
  type UserStatsResponse,
  PROBLEM_TAGS_QUERY,
  type ProblemTagsResponse,
  DAILY_CHALLENGE_QUERY,
  type DailyChallengeResponse,
  PROBLEMSET_QUERY_V2,
  type ProblemsetResponse,
  QUESTION_DETAIL_QUERY,
  type QuestionDetailResponse,
  SIMILAR_QUESTIONS_QUERY,
  type SimilarQuestionsResponse,
  NEXT_CHALLENGES_QUERY,
  type NextChallengesResponse,
} from "./queries.js";

import {
  computeNextBox,
  computeAgedBox,
  computeNextReviewDue,
  convertToUnixTimestamp,
  daysOverdue,
  cleanHtmlContent,
  difficultyBasedTimeLimit,
  coverageStatus,
  CORE_FAANG_TAGS,
  EXPLORE_TAGS,
  analyzeWeakAreas,
  categorizeSubmissions,
} from "./helpers.js";

import { OUTCOMES, DAYS, type Outcome, type DayOfWeek } from "./types.js";
import type {
  ProblemRecord,
  HistoryEntry,
  UserSettings,
  Difficulty,
} from "./types.js";

// ─── Fail-fast startup check ─────────────────────────────────────────────────
// Better than scattering `!` assertions everywhere and hoping — if something
// required is missing, the server refuses to boot, with a clear reason why,
// instead of crashing mysteriously on the third tool call someone makes.

const REQUIRED_ENV_VARS = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "LEETCODE_SESSION",
  "CSRF_TOKEN",
  "DAILY_CHECK_SECRET",
] as const;

for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ─── MCP Server setup ────────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "tether-connector", version: "1.0.0" });

  server.tool(
    "get_submission_history",
    "Fetch recent submission history for a LeetCode user",
    {
      username: z.string().describe("LeetCode username"),
      limit: z.number().int().min(1).max(50).default(20),
    },
    async ({ username, limit }) => {
      const data = await lcQuery<SubmissionHistoryResponse>(
        SUBMISSION_HISTORY_QUERY,
        {
          username,
          limit,
        },
      );
      const subs = data.recentSubmissionList;

      if (!subs || subs.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No submissions found for user "${username}".`,
            },
          ],
        };
      }

      const { byStatus, byLang, multipleAttempts } =
        categorizeSubmissions(subs);

      const lines: string[] = [
        `## Submission History for @${username}`,
        `Showing last ${subs.length} submissions\n`,
        "### Status Breakdown",
        ...Object.entries(byStatus).map(([s, n]) => `- ${s}: ${n}`),
        "\n### Language Usage",
        ...Object.entries(byLang).map(([l, n]) => `- ${l}: ${n}`),
      ];

      if (multipleAttempts.length > 0) {
        lines.push("\n### Problems with Multiple Failed Attempts");
        lines.push(...multipleAttempts.map((t) => `- ${t}`));
      }

      lines.push("\n### Recent Submissions");
      for (const s of subs.slice(0, 10)) {
        const date = new Date(
          parseInt(s.timestamp) * 1000,
        ).toLocaleDateString();
        lines.push(`- [${s.statusDisplay}] ${s.title} (${s.lang}) — ${date}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "analyze_weak_areas",
    "Analyze a LeetCode user's weak topic areas and provide recommendations",
    { username: z.string().describe("LeetCode username") },
    async ({ username }) => {
      const [tagData, statsData] = await Promise.all([
        lcQuery<ProblemTagsResponse>(PROBLEM_TAGS_QUERY, { username }),
        lcQuery<UserStatsResponse>(USER_STATS_QUERY, { username }),
      ]);

      const user = tagData.matchedUser;
      if (!user)
        return {
          content: [{ type: "text", text: `User "${username}" not found.` }],
        };

      const { weak, strong } = analyzeWeakAreas(user.tagProblemCounts);
      const stats = statsData.matchedUser?.submitStats?.acSubmissionNum || [];
      const calendar = statsData.matchedUser?.userCalendar;

      const lines: string[] = [
        `## Weak Area Analysis for @${username}\n`,
        "### Overall Progress",
        ...stats.map(
          (s) =>
            `- **${s.difficulty}**: ${s.count} solved (${s.submissions} total submissions)`,
        ),
      ];

      if (calendar) {
        lines.push(`- 🔥 Current streak: ${calendar.streak} days`);
        lines.push(`- 📅 Total active days: ${calendar.totalActiveDays}`);
      }

      lines.push(
        "\n### 🔴 Weak Areas (least solved topics)",
        ...weak.map((t) => `- **${t.tag}**: ${t.solved} problems solved`),
        "\n### 🟢 Strongest Topics",
        ...strong.map((t) => `- **${t.tag}**: ${t.solved} problems solved`),
      );

      lines.push("\n### 📚 Recommended Focus Areas");
      for (const t of weak.slice(0, 3)) {
        lines.push(
          `- **${t.tag}**: Practice 3–5 Easy problems, then 2–3 Medium problems to build intuition.`,
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "get_user_stats",
    "Get overall stats and progress for a LeetCode user",
    { username: z.string().describe("LeetCode username") },
    async ({ username }) => {
      const data = await lcQuery<UserStatsResponse>(USER_STATS_QUERY, {
        username,
      });
      const user = data.matchedUser;
      if (!user)
        return {
          content: [{ type: "text", text: `User "${username}" not found.` }],
        };

      const stats = user.submitStats?.acSubmissionNum || [];
      const beats = user.problemsSolvedBeatsStats || [];
      const calendar = user.userCalendar;

      const lines: string[] = [
        `## Stats for @${username}\n`,
        "### Problems Solved",
        ...stats.map(
          (s) =>
            `- **${s.difficulty}**: ${s.count} accepted / ${s.submissions} submissions (${
              s.submissions > 0
                ? Math.round((s.count / s.submissions) * 100)
                : 0
            }% acceptance)`,
        ),
      ];

      if (beats.length > 0) {
        lines.push("\n### Beats (better than X% of users)");
        lines.push(
          ...beats.map(
            (b) => `- ${b.difficulty}: top ${(100 - b.percentage).toFixed(1)}%`,
          ),
        );
      }

      if (calendar) {
        lines.push(
          `\n### Activity`,
          `- 🔥 Streak: ${calendar.streak} days`,
          `- 📅 Total active days: ${calendar.totalActiveDays}`,
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "get_daily_challenge",
    "Get today's LeetCode Daily Challenge problem",
    {},
    async () => {
      const data = await lcQuery<DailyChallengeResponse>(DAILY_CHALLENGE_QUERY);
      const q = data.activeDailyCodingChallengeQuestion;
      if (!q)
        return {
          content: [{ type: "text", text: "Could not fetch daily challenge." }],
        };

      const tags = q.question.topicTags.map((t) => t.name).join(", ");
      const text = [
        `## 📅 Daily Challenge — ${q.date}`,
        `**${q.question.title}**`,
        `Difficulty: ${q.question.difficulty}`,
        `Acceptance Rate: ${q.question.acRate.toFixed(1)}%`,
        `Topics: ${tags}`,
        `Link: https://leetcode.com${q.link}`,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "search_problems_by_topic",
    "Search LeetCode problems by topic tag and/or difficulty",
    {
      tag: z.string().optional().describe("Topic tag slug, e.g. 'union-find'"),
      difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).optional(),
      limit: z.number().int().min(1).max(50).default(15),
      excludePremium: z.boolean().default(false),
    },
    async ({ tag, difficulty, limit, excludePremium }) => {
      const filters = {
        filterCombineType: "ALL",
        difficultyFilter: {
          difficulties: difficulty ? [difficulty] : [],
          operator: "IS",
        },
        topicFilter: { topicSlugs: tag ? [tag] : [], operator: "IS" },
      };

      const data = await lcQuery<ProblemsetResponse>(PROBLEMSET_QUERY_V2, {
        categorySlug: "all-code-essentials",
        skip: 0,
        limit,
        searchKeyword: "",
        filters,
        sortBy: { sortField: "CUSTOM", sortOrder: "ASCENDING" },
      });

      let questions = data.problemsetQuestionListV2.questions;
      if (excludePremium) questions = questions.filter((q) => !q.paidOnly);
      if (!questions.length)
        return {
          content: [
            { type: "text", text: "No problems found for those filters." },
          ],
        };

      const lines: string[] = [
        `## Problems${tag ? ` — ${tag}` : ""}${difficulty ? ` (${difficulty})` : ""}\n`,
      ];
      for (const q of questions) {
        lines.push(
          `- **${q.questionFrontendId}. ${q.title}**${q.paidOnly ? " 🔒" : ""} (${q.difficulty}) — ${q.acRate.toFixed(1)}% acceptance${q.frequency ? `, freq: ${q.frequency.toFixed(1)}` : ""}`,
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "get_problem_details",
    "Get the full details of a specific LeetCode problem",
    { titleSlug: z.string().describe("URL slug, e.g. 'two-sum'") },
    async ({ titleSlug }) => {
      const data = await lcQuery<QuestionDetailResponse>(
        QUESTION_DETAIL_QUERY,
        { titleSlug },
      );
      const q = data.question;
      if (!q)
        return {
          content: [
            { type: "text", text: `Question "${titleSlug}" not found.` },
          ],
        };

      const cleanedContent = cleanHtmlContent(q.content);
      const stats = JSON.parse(q.stats);

      const lines: string[] = [
        `## ${q.questionFrontendId}. ${q.title}${q.isPaidOnly ? " 🔒" : ""}`,
        `**Difficulty:** ${q.difficulty}  |  **Acceptance:** ${stats.acRate} (${stats.totalAccepted}/${stats.totalSubmission})`,
        "",
        cleanedContent,
      ];

      if (q.topicTags.length > 0) {
        lines.push(
          "\n### Topic Tags",
          ...q.topicTags.map((t) => `- ${t.name}`),
        );
      }
      if (q.exampleTestcaseList?.length > 0) {
        lines.push(
          "\n### Example Testcases",
          "```",
          ...q.exampleTestcaseList,
          "```",
        );
      }
      if (q.hints?.length > 0) {
        lines.push("\n### Hints", ...q.hints.map((h, i) => `${i + 1}. ${h}`));
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "get_similar_problems",
    "Get similar problems for a specific LeetCode problem",
    { titleSlug: z.string().describe("URL slug, e.g. 'two-sum'") },
    async ({ titleSlug }) => {
      const data = await lcQuery<SimilarQuestionsResponse>(
        SIMILAR_QUESTIONS_QUERY,
        { titleSlug },
      );
      const q = data.question;
      if (!q)
        return {
          content: [
            { type: "text", text: `Question "${titleSlug}" not found.` },
          ],
        };
      if (q.similarQuestionList.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No similar questions found for "${titleSlug}".`,
            },
          ],
        };
      }

      const lines: string[] = [`Similar Problems for ${q.title}:\n`];
      for (const sq of q.similarQuestionList) {
        lines.push(
          `- **${sq.title}**${sq.isPaidOnly ? " 🔒" : ""} (${sq.difficulty})`,
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "recommend_next_problem",
    "LeetCode's suggested next challenges after a specific problem",
    { titleSlug: z.string().describe("URL slug, e.g. 'two-sum'") },
    async ({ titleSlug }) => {
      const data = await lcQuery<NextChallengesResponse>(
        NEXT_CHALLENGES_QUERY,
        { titleSlug },
      );
      const q = data.question;
      if (!q)
        return {
          content: [
            { type: "text", text: `Question "${titleSlug}" not found.` },
          ],
        };
      if (q.nextChallenges.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No next challenges found for "${titleSlug}".`,
            },
          ],
        };
      }

      const lines: string[] = [`Next Challenges for ${q.title}:\n`];
      for (const nc of q.nextChallenges) {
        lines.push(
          `- **LC ${nc.questionFrontendId}: ${nc.title}** (${nc.difficulty})`,
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "start_mock_interview",
    "Get a random LeetCode problem matching a difficulty, topic, and/or company, framed as a mock interview",
    {
      difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).optional(),
      tag: z.string().optional(),
      companies: z.array(z.string()).optional(),
    },
    async ({ difficulty, tag, companies }) => {
      if (!difficulty && !tag && (!companies || companies.length === 0)) {
        return {
          content: [
            {
              type: "text",
              text: "Please provide at least a difficulty, tag, or company.",
            },
          ],
        };
      }

      const filters = {
        filterCombineType: "ALL",
        difficultyFilter: {
          difficulties: difficulty ? [difficulty] : [],
          operator: "IS",
        },
        topicFilter: { topicSlugs: tag ? [tag] : [], operator: "IS" },
        companyFilter: companies?.length
          ? { companySlugs: companies, operator: "IS" }
          : undefined,
      };

      const data = await lcQuery<ProblemsetResponse>(PROBLEMSET_QUERY_V2, {
        categorySlug: "all-code-essentials",
        skip: 0,
        limit: 50,
        searchKeyword: "",
        filters,
        sortBy: { sortField: "CUSTOM", sortOrder: "ASCENDING" },
      });

      const questions = data.problemsetQuestionListV2.questions;
      if (!questions.length)
        return {
          content: [
            { type: "text", text: "No problems found for those filters." },
          ],
        };

      const chosen = questions[Math.floor(Math.random() * questions.length)];
      const detailData = await lcQuery<QuestionDetailResponse>(
        QUESTION_DETAIL_QUERY,
        {
          titleSlug: chosen.titleSlug,
        },
      );
      const q = detailData.question;
      if (!q)
        return {
          content: [
            {
              type: "text",
              text: "Selected a problem but couldn't load its details.",
            },
          ],
        };

      const cleanedContent = cleanHtmlContent(q.content);
      const timeLimit =
        difficultyBasedTimeLimit(q.difficulty as Difficulty) ?? 30;

      const lines: string[] = [
        `## Mock Interview${companies?.length ? ` — targeting: ${companies.join(", ")}` : ""}`,
        `**Recommended time limit:** ${timeLimit} minutes`,
        "",
        "**Before you start:** clarify constraints and edge cases out loud, talk through your approach before writing code, and state time/space complexity before you submit.",
        "",
        `### ${q.questionFrontendId}. ${q.title}${q.isPaidOnly ? " 🔒" : ""}`,
        `**Difficulty:** ${q.difficulty}`,
        "",
        cleanedContent,
      ];

      if (q.topicTags.length > 0)
        lines.push(
          "\n### Topic Tags",
          ...q.topicTags.map((t) => `- ${t.name}`),
        );
      if (q.exampleTestcaseList?.length > 0) {
        lines.push(
          "\n### Example Testcases",
          "```",
          ...q.exampleTestcaseList,
          "```",
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "log_attempt",
    "Log an attempt at a LeetCode problem, updating its spaced-repetition schedule",
    {
      username: z.string(),
      titleSlug: z.string(),
      title: z.string(),
      difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
      tags: z.array(z.string()).optional(),
      outcome: z.enum(OUTCOMES),
      notes: z.string().optional(),
    },
    async ({
      username,
      titleSlug,
      title,
      difficulty,
      tags,
      outcome,
      notes,
    }) => {
      const existing = await getProblemRecord(username, titleSlug);

      const currentBox = existing ? existing.box : null;
      const newBox = computeNextBox(currentBox, outcome);
      const nextReviewDue = computeNextReviewDue(newBox);
      const now = new Date().toISOString();

      const updatedRecord: ProblemRecord = {
        title,
        titleSlug,
        difficulty,
        tags: tags ?? [],
        box: newBox,
        attemptCount: existing ? existing.attemptCount + 1 : 1,
        lastOutcome: outcome,
        lastReviewed: now,
        nextReviewDue,
        history: [
          ...(existing?.history ?? []),
          { timestamp: now, outcome, notes: notes ?? null },
        ],
      };

      await setProblemRecord(
        username,
        titleSlug,
        updatedRecord,
        convertToUnixTimestamp(nextReviewDue),
      );

      const readableDate = new Date(nextReviewDue).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      });

      const lines = [
        `Logged attempt for **${title}**`,
        `Outcome: ${outcome}`,
        `Box: ${newBox} → next review on **${readableDate}**`,
        notes ? `Notes: ${notes}` : null,
      ].filter((l): l is string => l !== null);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "get_due_for_review",
    "Get LeetCode problems due for spaced-repetition review, split into overdue and due today",
    { username: z.string() },
    async ({ username }) => {
      const { overdue, dueToday } = await getDueAndOverdue(username);

      if (overdue.length === 0 && dueToday.length === 0) {
        return {
          content: [{ type: "text", text: "Nothing is due right now!" }],
        };
      }

      const lines: string[] = [`## Review Queue for @${username}`];

      if (overdue.length > 0) {
        lines.push(`\n**${overdue.length} overdue**`);
        for (const record of overdue) {
          const days = daysOverdue(record.nextReviewDue);
          lines.push(
            `- ${record.title} (box ${record.box}) — ${days} day${days === 1 ? "" : "s"} overdue`,
          );
        }
      }

      if (dueToday.length > 0) {
        lines.push(`\n**${dueToday.length} due today**`);
        for (const record of dueToday) {
          lines.push(`- ${record.title} (box ${record.box})`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "set_review_intensity",
    "Configure how often Tether checks in with you and on which days",
    {
      username: z.string(),
      intensity: z.enum(["GRIND", "MODERATE", "BUSY", "MINIMAL"]),
      activeDays: z.array(z.enum(DAYS)).optional(),
      phoneNumber: z.string().optional(),
    },
    async ({ username, intensity, activeDays, phoneNumber }) => {
      if (
        intensity === "MODERATE" &&
        (!activeDays || (activeDays.length !== 3 && activeDays.length !== 4))
      ) {
        return {
          content: [
            {
              type: "text",
              text: "MODERATE intensity needs exactly 3 or 4 active days.",
            },
          ],
        };
      }
      if (intensity === "BUSY" && (!activeDays || activeDays.length !== 2)) {
        return {
          content: [
            {
              type: "text",
              text: "BUSY intensity needs exactly 2 active days.",
            },
          ],
        };
      }

      const existing = await getUserSettings(username);
      const resolvedPhoneNumber = phoneNumber ?? existing?.phoneNumber;

      if (!resolvedPhoneNumber) {
        return {
          content: [
            {
              type: "text",
              text: "No phone number on file — please provide one.",
            },
          ],
        };
      }

      const updatedSettings: UserSettings = {
        username,
        intensity,
        activeDays:
          intensity === "GRIND" || intensity === "MINIMAL"
            ? null
            : (activeDays as DayOfWeek[]),
        phoneNumber: resolvedPhoneNumber,
      };

      await setUserSettings(username, updatedSettings);

      const dayLabel = updatedSettings.activeDays
        ? updatedSettings.activeDays.join(", ")
        : intensity === "GRIND"
          ? "every day"
          : "Sundays only";

      const lines = [
        `Tether intensity set to **${intensity}**`,
        `Check-in days: ${dayLabel}`,
        `Phone on file: ${resolvedPhoneNumber}`,
        `Note: every tier also gets the weekly Sunday digest.`,
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "compare_topic_coverage",
    "Compare a user's LeetCode tag coverage against core FAANG interview topics",
    { username: z.string() },
    async ({ username }) => {
      const data = await lcQuery<ProblemTagsResponse>(PROBLEM_TAGS_QUERY, {
        username,
      });
      const user = data.matchedUser;
      if (!user)
        return {
          content: [{ type: "text", text: `User "${username}" not found.` }],
        };

      const allTags = [
        ...user.tagProblemCounts.advanced,
        ...user.tagProblemCounts.intermediate,
        ...user.tagProblemCounts.fundamental,
      ];
      const solvedMap = new Map(
        allTags.map((t) => [t.tagName, t.problemsSolved]),
      );

      const resultArray = CORE_FAANG_TAGS.map((tag) => {
        const solved = solvedMap.get(tag) ?? 0;
        return { tag, solved, status: coverageStatus(solved) };
      }).sort((a, b) => a.solved - b.solved);

      const criticalCount = resultArray.filter((r) =>
        r.status.includes("Critical"),
      ).length;

      const lines: string[] = [
        `## Topic Coverage vs. Core FAANG Interview Tags\n`,
        `**${criticalCount} of ${resultArray.length} core topics are Critical Gaps**\n`,
        "| Topic | Solved | Status |",
        "|---|---|---|",
        ...resultArray.map((r) => `| ${r.tag} | ${r.solved} | ${r.status} |`),
      ];

      const exploreArray = EXPLORE_TAGS.map((tag) => ({
        tag,
        solved: solvedMap.get(tag) ?? 0,
      })).sort((a, b) => a.solved - b.solved);

      lines.push(
        "\n### Explore Later (situational / company-dependent)",
        "| Topic | Solved |",
        "|---|---|",
        ...exploreArray.map((r) => `| ${r.tag} | ${r.solved} |`),
      );

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  return server;
}

// ─── Shared logic used by both get_due_for_review AND daily_check ───────────

async function getDueAndOverdue(
  username: string,
): Promise<{ overdue: ProblemRecord[]; dueToday: ProblemRecord[] }> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodaySeconds = Math.floor(startOfToday.getTime() / 1000);

  const dueSlugs = await getDueTitleSlugs(username, nowSeconds);
  if (dueSlugs.length === 0) return { overdue: [], dueToday: [] };

  const records = await getProblemRecordsBatch(username, dueSlugs);
  const validRecords = records.filter((r): r is ProblemRecord => r !== null);

  const overdue = validRecords
    .filter(
      (r) => convertToUnixTimestamp(r.nextReviewDue) < startOfTodaySeconds,
    )
    .sort(
      (a, b) => daysOverdue(b.nextReviewDue) - daysOverdue(a.nextReviewDue),
    );

  const dueToday = validRecords.filter(
    (r) => convertToUnixTimestamp(r.nextReviewDue) >= startOfTodaySeconds,
  );

  return { overdue, dueToday };
}

// ─── Aging sweep ─────────────────────────────────────────────────────────────

const AGING_THRESHOLD_DAYS = 3;

async function runAgingSweep(username: string): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - AGING_THRESHOLD_DAYS * 86400;

  const staleSlugs = await getDueTitleSlugs(username, cutoff);
  if (staleSlugs.length === 0) return;

  const records = await getProblemRecordsBatch(username, staleSlugs);

  for (let i = 0; i < staleSlugs.length; i++) {
    const record = records[i];
    if (!record) continue;

    const newBox = computeAgedBox(record.box);
    const nextReviewDue = computeNextReviewDue(newBox);
    const now = new Date().toISOString();

    const updatedRecord: ProblemRecord = {
      ...record,
      box: newBox,
      nextReviewDue,
      history: [
        ...record.history,
        { timestamp: now, outcome: "AUTO_AGED", notes: null },
      ],
    };

    await setProblemRecord(
      username,
      staleSlugs[i],
      updatedRecord,
      convertToUnixTimestamp(nextReviewDue),
    );
  }
}

// ─── Day-of-week check ────────────────────────────────────────────────────────

const DAY_NAMES: DayOfWeek[] = [
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
];

function isActiveToday(settings: UserSettings): boolean {
  const today = DAY_NAMES[new Date().getDay()];
  if (settings.intensity === "GRIND") return true;
  if (settings.intensity === "MINIMAL") return today === "SUN";
  return settings.activeDays?.includes(today) ?? false;
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// (OAuth stub section — unchanged in behavior, lightly typed)

interface OAuthClient {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
}

const clients = new Map<string, OAuthClient>();
const authCodes = new Map<
  string,
  { client_id: string; redirect_uri: string; username: string; expires: number }
>();
// `username` living in this in-memory map is the same that the JWT step replaces
// instead of a server-side lookup table, the token itself will carry
// `sub: username`, signed, so that it survives a server restart and doesn't leak across
// instances if this ever runs on more than one dyno.
const tokens = new Map<
  string,
  { client_id: string; username: string; expires: number }
>();

function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("hex")}`;
}

function baseUrl(req: Request): string {
  return (
    process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`
  );
}

app.get(
  "/.well-known/oauth-authorization-server",
  (req: Request, res: Response) => {
    const b = baseUrl(req);
    res.json({
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  },
);

app.get(
  "/.well-known/oauth-protected-resource",
  (req: Request, res: Response) => {
    const b = baseUrl(req);
    res.json({ resource: `${b}/mcp`, authorization_servers: [b] });
  },
);

app.post("/oauth/register", (req: Request, res: Response) => {
  const client_id = randomToken("client");
  const client: OAuthClient = {
    client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: req.body?.redirect_uris || [],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
  clients.set(client_id, client);
  res.status(201).json(client);
});

// ─── Phone + OTP login ────────────────────────────────────────────────────
// Replaces the old instant-issue stub. This is the actual point where a
// human proves who they are before Claude gets a token and, according to Twilio's
// toll-free verification requirements, the actual consent-capturing UI that
// the "opt-in policy proof" screenshot points at.

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

function hiddenFields(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`,
    )
    .join("\n");
}

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
  <html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 420px; margin: 60px auto; padding: 0 20px; }
    input { width: 100%; padding: 10px; margin: 8px 0 16px; font-size: 16px; box-sizing: border-box; }
    button { width: 100%; padding: 10px; font-size: 16px; cursor: pointer; }
    .disclosure { font-size: 12px; color: #666; margin-top: -8px; margin-bottom: 16px; }
    .error { color: #b00020; margin-bottom: 12px; }
</style></head><body>
<h2>${escapeHtml(title)}</h2>
${body}
</body></html>`;
}

app.get("/oauth/authorize", (req: Request, res: Response) => {
  const { redirect_uri, state, client_id } = req.query as {
    redirect_uri?: string;
    state?: string;
    client_id?: string;
  };
  if (!redirect_uri) return res.status(400).send("Missing redirect_uri");

  res.send(
    pageShell(
      "Sign in to Tether",
      `<form method="POST" action="/auth/otp/send">
        ${hiddenFields({ redirect_uri, state: state ?? "", client_id: client_id ?? "" })}
        <label for="phone">Phone number</label>
        <input type="tel" id="phone" name="phone" placeholder="+1 555 555 5555" required>
        <div class="disclosure">
          By entering your phone number, you agree to receive automated SMS
          messages from Tether for LeetCode review reminders. Message
          frequency varies. Msg &amp; data rates may apply. Reply STOP to
          unsubscribe, HELP for help.
        </div>
        <button type="submit">Send code</button>
      </form>`,
    ),
  );
});

function errorPage(hidden: string, retryAction: string, message: string) {
  return pageShell(
    "Sign in to Tether",
    `<div class="error">${escapeHtml(message)}</div>
        <form method="POST" action="${retryAction}">
          ${hidden}
          <button type="submit">Try again</button>
        </form>`,
  );
}

app.post(
  "/auth/otp/send",
  express.urlencoded({ extended: true }),
  async (req: Request, res: Response) => {
    const { phone, redirect_uri, state, client_id } = req.body as Record<
      string,
      string
    >;

    if (!phone || !redirect_uri)
      return res.status(400).send("Missing a Phone Number or Redirect_URI.");

    const hidden = hiddenFields({
      phone,
      redirect_uri,
      state: state ?? "",
      client_id: client_id ?? "",
    });

    let result;

    try {
      result = await sendOTP(phone);
    } catch (err) {
      console.log("sendOTP Failed", err);
      return res
        .status(502)
        .send(
          errorPage(
            hidden,
            "/auth/otp/send",
            "Something went wrong on our end. Please try again later.",
          ),
        );
    }

    if (!result.ok) {
      const messages: Record<string, string> = {
        invalid_phone: "That doesn't look like a phone number.",
        cooldown:
          "A code was already sent, please check your phone or wait a minute before requesting another.",
        send_failed:
          "Couldn't send that text right now. Please try again shortly.",
      };

      return res.send(
        pageShell(
          "Sign into Tether",
          `<div class="error">${escapeHtml(messages[result.reason] ?? "Something went wrong.")}</div>
                    <form method="POST" action="/auth/otp/send">
                    ${hidden}
                    <button type="submit">Try again</button>
                    </form>`,
        ),
      );
    }

    let existingUsername: string | null;
    try {
      existingUsername = await getUsernameForPhone(
        phone.replace(/[^\d+]/g, ""),
      );
    } catch (err) {
      console.error("getUsernameForPhone failed: ", err);
      return res
        .status(502)
        .send(
          errorPage(
            hidden,
            "/auth/otp/send",
            "Something went wrong on our end. Please try again later.",
          ),
        );
    }

    res.send(
      pageShell(
        "Enter your code",
        `<form method="POST" action="/auth/otp/verify">
                    ${hidden}
                    <label for="code">6-digit code</label>
                    <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" required autofocus>
                    ${
                      existingUsername
                        ? ""
                        : `<label for="leetcodeUsername">LeetCode username (first time only)</label>
                        <input type="text" id="leetcodeUsername" name="leetcodeUsername" required>`
                    }
                    <button type="submit">Verify</button>
                </form>`,
      ),
    );
  },
);

app.post(
  "/auth/otp/verify",
  express.urlencoded({ extended: true }),
  async (req: Request, res: Response) => {
    const { phone, code, leetcodeUsername, redirect_uri, state, client_id } =
      req.body as Record<string, string>;

    if (!phone || !code || !redirect_uri) {
      return res.status(400).send("Missing required fields");
    }

    const hidden = hiddenFields({
      phone,
      redirect_uri,
      state: state ?? "",
      client_id: client_id ?? "",
    });

    let result;

    try {
      result = await verifyOTP(phone, code);
    } catch (err) {
      console.error("verifyOTP failed: ", err);
      return res
        .status(502)
        .send(
          errorPage(
            hidden,
            "/auth/otp/verify",
            "Something went wrong on our end. Please try again later.",
          ),
        );
    }

    if (result !== "ok") {
      const messages: Record<string, string> = {
        invalid_phone: "That doesn't look like a phone number.",
        expired: "This code expired, please request a new code.",
        too_many_attempts: "Too many wrong attempts, please try a new code.",
        invalid: "That code doesn't match. Double check and try again.",
      };

      return res.send(
        pageShell(
          "Enter your code",
          `<div class="error">${escapeHtml(messages[result])}</div>
                    <form method="POST" action="/auth/otp/send">
                        ${hiddenFields({ phone, redirect_uri, state: state ?? "", client_id: client_id ?? "" })}
                        <button type="submit">Send a new code</button>
                    </form>`,
        ),
      );
    }

    const normalizedPhone = phone.replace(/[^\d+]/g, "");

    try {
      let username = await getUsernameForPhone(normalizedPhone);
      if (!username) {
        if (!leetcodeUsername?.trim()) {
          return res.send(
            pageShell(
              "Almost done",
              `<div class="error">First-time sign-in needs your LeetCode username.</div>
                                <form method="POST" action="/auth/otp/verify">
                                ${hidden}
                                <label for="leetcodeUsername">LeetCode Username</label>
                                <input type="text" id="leetcodeUsername" name="leetcodeUsername" required>
                                <button type="submit">Finish signing in</button>
                            </form>`,
            ),
          );
        }
        username = leetcodeUsername.trim();

        await registerUser(normalizedPhone, username);

        const existingSettings = await getUserSettings(username);

        if (!existingSettings) {
          // MINIMAL needs no activeDays (see set_review_intensity's validation),
          // so this is a safe default until the person tunes it via the tool.
          await setUserSettings(username, {
            username,
            intensity: "MINIMAL",
            activeDays: null,
            phoneNumber: normalizedPhone,
          });
        }
      }

      const authCode = randomToken("code");
      authCodes.set(authCode, {
        client_id: client_id ?? "",
        redirect_uri,
        username,
        expires: Date.now() + 60_000,
      });

      const url = new URL(redirect_uri);

      url.searchParams.set("code", authCode);

      if (state) {
        url.searchParams.set("state", state);
      }

      res.redirect(url.toString());
    } catch (err) {
      console.error("otp/verify user-creation step failed: ", err);
      res
        .status(502)
        .send(
          errorPage(
            hidden,
            "/auth/otp/send",
            "Something went wrong. Please try again later.",
          ),
        );
    }
  },
);

app.post(
  "/oauth/token",
  express.urlencoded({ extended: true }),
  (req: Request, res: Response) => {
    const { code, grant_type } = req.body;
    if (grant_type !== "authorization_code") {
      return res.status(400).json({ error: "unsupported_grant_type" });
    }

    const entry = authCodes.get(code);
    if (!entry || entry.expires < Date.now()) {
      return res.status(400).json({ error: "invalid_grant" });
    }

    authCodes.delete(code);

    const access_token = randomToken("token");

    tokens.set(access_token, {
      client_id: entry.client_id,
      username: entry.username,
      expires: Date.now() + 3_600_000,
    });

    res.json({ access_token, token_type: "Bearer", expires_in: 3600 });
  },
);

app.get("/health", (_req: Request, res: Response) =>
  res.json({ status: "ok", server: "tether-connector" }),
);

app.post("/mcp", async (req: Request, res: Response) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ error: "Method not allowed. Use POST." });
});

// ─── daily_check — plain HTTP route, not an MCP tool ────────────────────────

app.post("/internal/daily-check", async (req: Request, res: Response) => {
  const secret = req.headers["x-daily-check-secret"];
  if (secret !== process.env.DAILY_CHECK_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const username = process.env.TETHER_USERNAME as string; // solo phase — one hardcoded user

  const settings = await getUserSettings(username);
  if (!settings) {
    return res.json({ sent: 0, note: "no settings configured yet" });
  }

  await runAgingSweep(username); // every day when this endpoint hit ==> run aging sweep

  const today = DAY_NAMES[new Date().getDay()];
  const messages: string[] = [];

  if (isActiveToday(settings)) {
    const { overdue, dueToday } = await getDueAndOverdue(username);
    if (overdue.length > 0 || dueToday.length > 0) {
      const parts: string[] = [];
      if (overdue.length > 0) parts.push(`${overdue.length} problems overdue`);
      if (dueToday.length > 0)
        parts.push(`${dueToday.length} problems due today`);
      messages.push(parts.join(" · "));
      // TODO: send via Twilio
    }
  }

  if (today === "SUN") {
    // TODO: query a wider window, build weekly digest, push into messages[]
  }

  res.json({ sent: messages.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Tether MCP server running on port ${PORT}`);
});
