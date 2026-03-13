import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

const LEETCODE_GRAPHQL = "https://leetcode.com/graphql";

// ─── LeetCode GraphQL helpers ───────────────────────────────────────────────

async function lcQuery(query, variables = {}, session = null) {
  const headers = {
    "Content-Type": "application/json",
    Referer: "https://leetcode.com",
    Origin: "https://leetcode.com",
  };
  if (session) {
    headers["Cookie"] = `LEETCODE_SESSION=${session}`;
    headers["X-CSRFToken"] = "csrftoken"; // LeetCode requires this header
  }

  const res = await fetch(LEETCODE_GRAPHQL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`LeetCode API error: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join(", "));
  return json.data;
}

// ─── GraphQL queries ─────────────────────────────────────────────────────────

const SUBMISSION_HISTORY_QUERY = `
  query submissionList($username: String!, $limit: Int, $offset: Int) {
    recentSubmissionList(username: $username, limit: $limit) {
      title
      titleSlug
      timestamp
      statusDisplay
      lang
      id
    }
  }
`;

const USER_STATS_QUERY = `
  query userPublicProfile($username: String!) {
    matchedUser(username: $username) {
      submitStats: submitStatsGlobal {
        acSubmissionNum {
          difficulty
          count
          submissions
        }
      }
      problemsSolvedBeatsStats {
        difficulty
        percentage
      }
      userCalendar {
        streak
        totalActiveDays
      }
    }
  }
`;

const PROBLEM_TAGS_QUERY = `
  query getUserTagStats($username: String!) {
    matchedUser(username: $username) {
      tagProblemCounts {
        advanced {
          tagName
          problemsSolved
        }
        intermediate {
          tagName
          problemsSolved
        }
        fundamental {
          tagName
          problemsSolved
        }
      }
    }
  }
`;

const CONTEST_HISTORY_QUERY = `
  query userContestRankingInfo($username: String!) {
    userContestRanking(username: $username) {
      attendedContestsCount
      rating
      globalRanking
      totalParticipants
      topPercentage
    }
    userContestRankingHistory(username: $username) {
      attended
      rating
      ranking
      contest {
        title
        startTime
      }
    }
  }
`;

const DAILY_CHALLENGE_QUERY = `
  query questionOfToday {
    activeDailyCodingChallengeQuestion {
      date
      link
      question {
        title
        difficulty
        topicTags { name }
        acRate
      }
    }
  }
`;

// ─── Analysis helpers ────────────────────────────────────────────────────────

function analyzeWeakAreas(tagStats) {
  const allTags = [
    ...tagStats.advanced,
    ...tagStats.intermediate,
    ...tagStats.fundamental,
  ];

  // Sort by problems solved ascending → weakest first
  const sorted = [...allTags].sort((a, b) => a.problemsSolved - b.problemsSolved);

  const weak = sorted.slice(0, 8).map((t) => ({
    tag: t.tagName,
    solved: t.problemsSolved,
  }));

  const strong = sorted
    .slice(-5)
    .reverse()
    .map((t) => ({
      tag: t.tagName,
      solved: t.problemsSolved,
    }));

  return { weak, strong, total: allTags.length };
}

function categorizeSubmissions(submissions) {
  const byStatus = {};
  const byLang = {};
  const byProblem = {};

  for (const s of submissions) {
    byStatus[s.statusDisplay] = (byStatus[s.statusDisplay] || 0) + 1;
    byLang[s.lang] = (byLang[s.lang] || 0) + 1;
    byProblem[s.titleSlug] = byProblem[s.titleSlug] || {
      title: s.title,
      attempts: 0,
      accepted: false,
    };
    byProblem[s.titleSlug].attempts++;
    if (s.statusDisplay === "Accepted") byProblem[s.titleSlug].accepted = true;
  }

  const multipleAttempts = Object.values(byProblem)
    .filter((p) => p.attempts > 1 && !p.accepted)
    .map((p) => p.title);

  return { byStatus, byLang, multipleAttempts };
}

// ─── MCP Server setup ────────────────────────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({
    name: "leetcode-connector",
    version: "1.0.0",
  });

  // Tool: get_submission_history
  server.tool(
    "get_submission_history",
    "Fetch recent submission history for a LeetCode user",
    {
      username: z.string().describe("LeetCode username"),
      limit: z.number().int().min(1).max(50).default(20).describe("Number of submissions to fetch"),
    },
    async ({ username, limit }) => {
      const data = await lcQuery(SUBMISSION_HISTORY_QUERY, { username, limit });
      const subs = data.recentSubmissionList;

      if (!subs || subs.length === 0) {
        return {
          content: [{ type: "text", text: `No submissions found for user "${username}".` }],
        };
      }

      const { byStatus, byLang, multipleAttempts } = categorizeSubmissions(subs);

      const lines = [
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
        const date = new Date(parseInt(s.timestamp) * 1000).toLocaleDateString();
        lines.push(`- [${s.statusDisplay}] ${s.title} (${s.lang}) — ${date}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // Tool: analyze_weak_areas
  server.tool(
    "analyze_weak_areas",
    "Analyze a LeetCode user's weak topic areas and provide recommendations",
    {
      username: z.string().describe("LeetCode username"),
    },
    async ({ username }) => {
      const [tagData, statsData] = await Promise.all([
        lcQuery(PROBLEM_TAGS_QUERY, { username }),
        lcQuery(USER_STATS_QUERY, { username }),
      ]);

      const user = tagData.matchedUser;
      if (!user) return { content: [{ type: "text", text: `User "${username}" not found.` }] };

      const { weak, strong } = analyzeWeakAreas(user.tagProblemCounts);
      const stats = statsData.matchedUser?.submitStats?.acSubmissionNum || [];
      const calendar = statsData.matchedUser?.userCalendar;

      const lines = [
        `## Weak Area Analysis for @${username}\n`,
        "### Overall Progress",
        ...stats.map(
          (s) => `- **${s.difficulty}**: ${s.count} solved (${s.submissions} total submissions)`
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
        ...strong.map((t) => `- **${t.tag}**: ${t.solved} problems solved`)
      );

      // Generate practice recommendations
      lines.push("\n### 📚 Recommended Focus Areas");
      for (const t of weak.slice(0, 3)) {
        lines.push(
          `- **${t.tag}**: Practice 3–5 Easy problems, then 2–3 Medium problems to build intuition.`
        );
      }

      lines.push(
        "\n### 💡 Tips",
        "- Focus on your top 3 weak areas one at a time",
        "- Aim for understanding patterns, not memorizing solutions",
        "- After solving, check editorial even if you got it right"
      );

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // Tool: get_user_stats
  server.tool(
    "get_user_stats",
    "Get overall stats and progress for a LeetCode user",
    {
      username: z.string().describe("LeetCode username"),
    },
    async ({ username }) => {
      const data = await lcQuery(USER_STATS_QUERY, { username });
      const user = data.matchedUser;
      if (!user) return { content: [{ type: "text", text: `User "${username}" not found.` }] };

      const stats = user.submitStats?.acSubmissionNum || [];
      const beats = user.problemsSolvedBeatsStats || [];
      const calendar = user.userCalendar;

      const lines = [
        `## Stats for @${username}\n`,
        "### Problems Solved",
        ...stats.map(
          (s) =>
            `- **${s.difficulty}**: ${s.count} accepted / ${s.submissions} submissions (${
              s.submissions > 0 ? Math.round((s.count / s.submissions) * 100) : 0
            }% acceptance)`
        ),
      ];

      if (beats.length > 0) {
        lines.push("\n### Beats (better than X% of users)");
        lines.push(...beats.map((b) => `- ${b.difficulty}: top ${(100 - b.percentage).toFixed(1)}%`));
      }

      if (calendar) {
        lines.push(`\n### Activity`);
        lines.push(`- 🔥 Streak: ${calendar.streak} days`);
        lines.push(`- 📅 Total active days: ${calendar.totalActiveDays}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // Tool: get_daily_challenge
  server.tool(
    "get_daily_challenge",
    "Get today's LeetCode Daily Challenge problem",
    {},
    async () => {
      const data = await lcQuery(DAILY_CHALLENGE_QUERY);
      const q = data.activeDailyCodingChallengeQuestion;
      if (!q) return { content: [{ type: "text", text: "Could not fetch daily challenge." }] };

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
    }
  );

  return server;
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check
app.get("/health", (_, res) => res.json({ status: "ok", server: "leetcode-mcp" }));

// MCP endpoint — stateless Streamable HTTP (one transport per request)
app.post("/mcp", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("close", () => transport.close());

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// MCP GET/DELETE for session management (required by spec)
app.get("/mcp", (req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ LeetCode MCP server running on port ${PORT}`);
  console.log(`   POST http://localhost:${PORT}/mcp`);
});
