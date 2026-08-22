import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import "dotenv/config";
import { Redis } from '@upstash/redis'
const redis = new Redis({ 
  url: process.env.UPSTASH_REDIS_REST_URL, 
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const LEETCODE_GRAPHQL = "https://leetcode.com/graphql";

const csrftoken = process.env.CSRF_TOKEN;
const leetcode_session = process.env.LEETCODE_SESSION;

// ─── LeetCode GraphQL helpers ───────────────────────────────────────────────

async function lcQuery(query, variables = {}, session = leetcode_session) {
  const headers = {
    "Content-Type": "application/json",
    Referer: "https://leetcode.com",
    Origin: "https://leetcode.com",
  };
  if (session) {
    headers["Cookie"] = `LEETCODE_SESSION=${session}; csrftoken=${csrftoken}`;
    headers["X-CSRFToken"] = csrftoken;
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

const PROBLEMSET_QUERY_V2 = `
  query problemsetQuestionListV2($filters: QuestionFilterInput, $limit: Int, $searchKeyword: String, $skip: Int, $sortBy: QuestionSortByInput, $categorySlug: String) {
    problemsetQuestionListV2(
      filters: $filters
      limit: $limit
      searchKeyword: $searchKeyword
      skip: $skip
      sortBy: $sortBy
      categorySlug: $categorySlug
    ) {
      questions {
        titleSlug
        title
        questionFrontendId
        paidOnly
        difficulty
        topicTags { name slug }
        acRate
        frequency
      }
      totalLength
      hasMore
    }
  }
`;

// contains get_similar_problems information, so doesn't need extra query.
const QUESTION_DETAIL_QUERY = `
query questionDetail($titleSlug: String!) {
  languageList {
    id
    name
  }
  submittableLanguageList {
    id
    name
    verboseName
    isCompiledLang
  }
  statusList {
    id
    name
  }
  questionDiscussionTopic(questionSlug: $titleSlug) {
    id
    commentCount
    topLevelCommentCount
  }
  ugcArticleOfficialSolutionArticle(questionSlug: $titleSlug) {
    uuid
    chargeType
    canSee
    hasVideoArticle
  }
  question(titleSlug: $titleSlug) {
    title
    titleSlug
    questionId
    questionFrontendId
    questionTitle
    translatedTitle
    content
    translatedContent
    categoryTitle
    difficulty
    stats
    companyTagStatsV2
    topicTags {
      name
      slug
      translatedName
    }
    positionLevelTags {
      name
      nameTranslated
      slug
    }
    similarQuestionList {
      difficulty
      titleSlug
      title
      translatedTitle
      isPaidOnly
    }
    mysqlSchemas
    dataSchemas
    frontendPreviews
    likes
    dislikes
    isPaidOnly
    status
    canSeeQuestion
    enableTestMode
    metaData
    enableRunCode
    enableSubmit
    enableDebugger
    envInfo
    isLiked
    nextChallenges {
      difficulty
      title
      titleSlug
      questionFrontendId
    }
    libraryUrl
    adminUrl
    hints
    codeSnippets {
      code
      lang
      langSlug
    }
    exampleTestcaseList
    hasFrontendPreview
    featuredContests {
      titleSlug
      title
    }
    aiJudgingAvailable
  }
}
`

const SIMILAR_QUESTIONS_QUERY = `
  query similarQuestions($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      title
      similarQuestionList {
        title
        titleSlug
        difficulty
        isPaidOnly
      }
    }
  }
`;

const NEXT_CHALLENGES_QUERY = `
  query nextChallenges($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      title
      nextChallenges {
        title
        titleSlug
        difficulty
        questionFrontendId
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

const HTML_ENTITY_MAP = {
  "&nbsp;": " ",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&amp;": "&",
}

function cleanHtmlContent(uncleanedContent) {
  let cleanedContent = uncleanedContent
    .replace(/<\/p>|<br\s*\/?>|<\/pre>/g, "\n")           // preserve structure first
    .replace(/<[^>]*>/g, " ")                              // strip remaining tags
    .replace(/&nbsp;|&lt;|&gt;|&quot;|&amp;/g, (match) => HTML_ENTITY_MAP[match]) // decode entities
    .replace(/[ \t]+/g, " ")                               // collapse spaces/tabs only
    .replace(/\n\s*\n+/g, "\n\n")                          // collapse multiple blank lines
    .trim();

  return cleanedContent;
} 

function difficulty_based_time_limits(difficulty){
  const TIME_LIMITS = {EASY: 20, MEDIUM: 30, HARD: 45}
  return TIME_LIMITS[difficulty]
}

function coverageStatus(solved) {
  // TODO: tune these cutoffs once you see real numbers
  if (solved <= 7) return "🔴 Critical Gap";
  if (solved <= 15) return "🟡 Developing";
  return "🟢 Strong";
}

const CORE_FAANG_TAGS = [
  "Array", "Hash Table", "Two Pointers", "Sliding Window", "String",
  "Binary Search", "Dynamic Programming", "Backtracking", "Stack", "Queue",
  "Heap (Priority Queue)", "Greedy", "Bit Manipulation", "Tree", "Binary Tree",
  "Depth-First Search", "Breadth-First Search", "Graph Theory", "Linked List",
  "Sorting", "Matrix", "Prefix Sum", "Recursion", "Union-Find", "Trie",
  "Topological Sort", "Monotonic Stack",
];

const EXPLORE_TAGS = [
  "Binary Search Tree", "Divide and Conquer", "Memoization", "Math",
  "Simulation", "Ordered Map", "Ordered Set", "Bitmask", "Shortest Path",
  "Dijkstra's Algorithm", "Minimum Spanning Tree", "Segment Tree",
  "Binary Indexed Tree", "Counting", "Enumeration", "Number Theory",
  "Combinatorics", "Game Theory", "Rolling Hash", "Sweep Line",
  "Doubly-Linked List", "Monotonic Queue", "Quickselect",
  "Lowest Common Ancestor", "Design", "Concurrency", "Database",
];

const BOX_INTERVALS_DAYS = [1, 2, 4, 7, 14, 30]; 
const OUTCOMES = ["FAILED", "STRUGGLED", "SOLVED_WITH_HELP", "SOLVED_CONFIDENT"];

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];


function computeNextBox(currentBox, outcome){
  switch(outcome){
    case "FAILED":
      return 0
    case "STRUGGLED":
      return 1
    case "SOLVED_WITH_HELP":
      return 2
    case "SOLVED_CONFIDENT":
      // if the first time we solved this confidently, then we start at 3
      // if this not the first time, we climb up one
      return currentBox === null ? 3 : Math.min(currentBox+1, 5);
      // if we already mastered, we dont want to go beyond 5, keep range same as index of outcomes array
    default:
      throw new Error(`Unknown outcome: ${outcome}`)
  }
}

function computeNextReviewDue(box){
  const days = BOX_INTERVALS_DAYS[box]
  const due = new Date()
  due.setDate(due.getDate()+days)
  return due.toISOString()
}

function convertToUnixTimestamp(isoString){
  return Math.floor(new Date(isoString).getTime() / 1000);
}

function daysOverdue(nextReviewDue) {
  const dueSeconds = convertToUnixTimestamp(nextReviewDue);
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.floor((nowSeconds - dueSeconds) / 86400);
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

  // ------------- PROBLEM DISCOVERY AND TARGETING --------------

  // Tool: search problems by topic
  server.tool(
    "search_problems_by_topic",
    "Search Leetcode problems by Topic Tag and/or Difficulty",
    {
      tag: z.string().optional().describe("Topic tag slug, e.g. 'union-find', 'dynamic programming'"),
      difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).optional(),
      limit: z.number().int().min(1).max(50).default(15),
      excludePremium: z.boolean().default(false).describe("Exclude paid-only problems from results"),
    },
    async ({tag, difficulty, limit, excludePremium}) => {
      const filters = {
        filterCombineType: "ALL",
        difficultyFilter: {
          difficulties: difficulty ? [difficulty] : [],
          operator: "IS",
        },
        topicFilter: {
          topicSlugs: tag ? [tag] : [],
          operator: "IS",
        },
      }
      const data = await lcQuery(PROBLEMSET_QUERY_V2, {
        categorySlug: "all-code-essentials",
        skip: 0,
        limit,
        searchKeyword: "",
        filters,
        sortBy: { sortField: "CUSTOM", sortOrder: "ASCENDING" },
      });

      let questions = data.problemsetQuestionListV2.questions
      if (excludePremium) questions = questions.filter((q) => !q.paidOnly);
      
      if (!questions.length) {
        return { content: [{ type: "text", text: "No problems found for those filters." }] };
      }

      const lines = [`## Problems${tag ? ` — ${tag}` : ""}${difficulty ? ` (${difficulty})` : ""}\n`];
      for (const q of questions) {
        lines.push(
          `- **${q.questionFrontendId}. ${q.title}**${q.paidOnly ? " 🔒" : ""} (${q.difficulty}) — ${q.acRate.toFixed(1)}% acceptance${q.frequency ? `, freq: ${q.frequency.toFixed(1)}` : ""}`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // Tool: get_problem_details
  server.tool(
    "get_problem_details",
    "Get the full details of a specific LeetCode problem",
    {
      titleSlug: z.string().describe("URL slug of the problem (not the display title), e.g. 'two-sum'"),
    },
    async ({ titleSlug }) => {
      const data = await lcQuery(QUESTION_DETAIL_QUERY, { titleSlug });
      const q = data.question;

      if (!q) {
        return { content: [{ type: "text", text: `Question "${titleSlug}" not found.` }] };
      }

      const {
        title,
        questionFrontendId,
        difficulty,
        topicTags,
        hints,
        exampleTestcaseList,
        isPaidOnly,
      } = q;      

      const cleanedContent = cleanHtmlContent(q.content)

      // ── Parse stats ──────────────────────────────────────────────────────────
      const stats = JSON.parse(q.stats);

      // ── Build response ──────────────────────────────────────────────────────
      const lines = [
        `## ${questionFrontendId}. ${title}${isPaidOnly ? " 🔒" : ""}`,
        `**Difficulty:** ${difficulty}  |  **Acceptance:** ${stats.acRate} (${stats.totalAccepted}/${stats.totalSubmission})`,
        "",
        cleanedContent,
      ];

      if (topicTags.length > 0) {
        lines.push("\n### Topic Tags");
        lines.push(...topicTags.map((t) => `- ${t.name}`));
      }

      if (exampleTestcaseList && exampleTestcaseList.length > 0) {
        lines.push("\n### Example Testcases");
        lines.push("```");
        lines.push(...exampleTestcaseList);
        lines.push("```");
      }

      if (hints && hints.length > 0) {
        lines.push("\n### Hints");
        hints.forEach((h, i) => lines.push(`${i + 1}. ${h}`));
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // Tool: get_similar_problems
  server.tool(
    "get_similar_problems",
    "Get the Similar Problems of a specific LeetCode problem",
    {
      titleSlug: z.string().describe("URL slug of the problem (not the display title), e.g. 'two-sum'"),
    },
    async ({ titleSlug }) => {
      const data = await lcQuery(SIMILAR_QUESTIONS_QUERY, { titleSlug });
      const q = data.question;

      if (!q) {
        return { content: [{ type: "text", text: `Question "${titleSlug}" not found.` }] };
      }

      const similarQuestionList = q.similarQuestionList

      if(similarQuestionList.length === 0){
        // no similar questions we return a no result
        return { content: [{ type: "text", text: `No Similar questions found for "${titleSlug}".`}] };
      }

      // ── Build response ──────────────────────────────────────────────────────
      const lines = [`Similar Problems for ${q.title}:\n`];

      for (const similarQuestion of similarQuestionList) {
        lines.push(
          `- **${similarQuestion.title}**${similarQuestion.isPaidOnly ? " 🔒" : ""} (${similarQuestion.difficulty})`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // Tool: recommend_next_problem
  server.tool(
    "recommend_next_problem",
    "Leetcode's recommendation the Next Challenges after a specific LeetCode problem",
    {
      titleSlug: z.string().describe("URL slug of the problem (not the display title), e.g. 'two-sum'"),
    },
    async ({ titleSlug }) => {
      const data = await lcQuery(NEXT_CHALLENGES_QUERY, { titleSlug });
      const q = data.question;

      if (!q) {
        return { content: [{ type: "text", text: `Question "${titleSlug}" not found.` }] };
      }

      const nextChallengesList = q.nextChallenges

      if(nextChallengesList.length === 0){
        // no similar questions we return a no result
        return { content: [{ type: "text", text: `No Next Challenges were found for "${titleSlug}".`}] };
      }

      // ── Build response ──────────────────────────────────────────────────────
      const lines = [`Next Challenges for ${q.title}:\n`];

      for (const nextChallenge of nextChallengesList) {
        lines.push(
          `- **LC ${nextChallenge.questionFrontendId}: ${nextChallenge.title}** (${nextChallenge.difficulty})`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // -------------- MOCK INTERVIEW SIMULATION --------------

  // Tool: start_mock_interview
  server.tool(
    "start_mock_interview",
    "Get a random LeetCode problem matching a difficulty and/or topic, framed as a timed mock interview",
    {
      difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).optional().describe('Level/Range of Interview Question Difficulty'),
      tag: z.string().optional().describe('Topic Tag Slug'),
      companies: z.array(z.string()).optional().describe(
        "Company slugs to target, e.g ['amazon', 'google']. Verify exact slugs via Leetcode's company filter"
      )
    },
    async ({ difficulty, tag, companies }) => {
      if(!difficulty && !tag && (!companies || companies.length === 0)){
        // Notify user of missing content 
        return { content: [{ type: "text", text: "Difficulty, Tag, and/or Company is missing" }] };
      }
      
      const filters = {
        filterCombineType: "ALL",
        difficultyFilter: {
          difficulties: difficulty ? [difficulty] : [],
          operator: "IS",
        },
        topicFilter: {
          topicSlugs: tag ? [tag] : [],
          operator: "IS",
        },
        companyFilter: companies && companies.length ? {
          companySlugs: companies, operator: "IS"
        } : undefined
      }

      const BATCH_SIZE = 50;

      const data = await lcQuery(PROBLEMSET_QUERY_V2, {
        categorySlug: "all-code-essentials",
        skip: 0,
        limit: BATCH_SIZE,
        searchKeyword: "",
        filters,
        sortBy: { sortField: "CUSTOM", sortOrder: "ASCENDING" },
      });

      const questions = data.problemsetQuestionListV2.questions
      if (!questions.length) {
        return { content: [{ type: "text", text: "No problems found for those filters." }] };
      }

      // pick a random index from question list and random question
      const randomIndex = Math.floor(Math.random() * questions.length);
      const chosenQuestion = questions[randomIndex];

      const chosenQuestionTitleSlug = chosenQuestion.titleSlug

      const questionData = await lcQuery(QUESTION_DETAIL_QUERY, {
        titleSlug: chosenQuestionTitleSlug
      })

      const q = questionData.question;

      if(!q){
        return { content: [{ type: "text", text: "No question found with this title slug." }] };
      }

      const cleanedQuestionContent = cleanHtmlContent(q.content)

      const timeLimit = difficulty_based_time_limits(q.difficulty.toUpperCase()) || 30;

      const lines = [
        `## Mock Interview${companies && companies.length ? ` — targeting: ${companies.join(", ")}` : ""}`,
        `**Recommended time limit:** ${timeLimit} minutes`,
        "",
        "**Before you start:** clarify constraints and edge cases out loud, talk through your approach before writing code, and state time/space complexity before you submit.",
        "",
        `### ${q.questionFrontendId}. ${q.title}${q.isPaidOnly ? " 🔒" : ""}`,
        `**Difficulty:** ${q.difficulty}`,
        "",
        cleanedQuestionContent,
      ];

      if (q.topicTags.length > 0) {
        lines.push("\n### Topic Tags");
        lines.push(...q.topicTags.map((t) => `- ${t.name}`));
      }

      if (q.exampleTestcaseList && q.exampleTestcaseList.length > 0) {
        lines.push("\n### Example Testcases");
        lines.push("```");
        lines.push(...q.exampleTestcaseList);
        lines.push("```");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // -------------- PROGRESS TRACKING WITH REAL MEMORY --------------
  // We connect to Redis Uptash here
  // Tool: log_attempt
  server.tool(
    "log_attempt",
    "Log an attempt at a LeetCode problem, updating its spaced-repetition schedule",
    {
      username: z.string().describe("Leetcode username, used as the storage namespace"),
      titleSlug: z.string().describe("Problem's URL slug. i.e. 'two-sum'"),
      title: z.string().describe("Problem's Display Title"),
      difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
      tags: z.array(z.string()).optional().describe("Topic Tags for this problem"),
      outcome: z.enum(OUTCOMES).describe("What happened in this attempt"),
      notes: z.string().optional().describe("What you got stuck on, or anything worth remembering next time")
    },
    async({username, titleSlug, title, difficulty, tags, outcome, notes}) => {
      const recordKey = `user:${username}:problem:${titleSlug}`;
      const queueKey = `user:${username}:review_queue`

      // read the existing record — may be null if this is the first attempt
      const existingRecord = await redis.get(recordKey);

      // compute the new box
      const currentBox = existingRecord ? existingRecord.box : null
      const newBox = computeNextBox(currentBox, outcome);

      // compute the new due date
      const nextReviewDue = computeNextReviewDue(newBox);

      // Build the updated record object
      //   - spread existing history if present, append a new entry
      //   - increment attemptCount
      //   - set title/difficulty/tags/box/lastOutcome/lastReviewed/nextReviewDue
      const now = new Date().toISOString();

      const updatedRecord = {
        title,
        titleSlug,
        difficulty,
        tags,
        box:newBox,
        attemptCount: existingRecord ? existingRecord.attemptCount + 1 : 1,
        lastOutcome: outcome,
        lastReviewed:  now,
        nextReviewDue: nextReviewDue,
        history:[
          ...(existingRecord?.history || []),
          { timestamp: now, outcome, notes: notes || null }
        ]
      }

      // atomic write: both keys together
      // redis stores due dates as a unix timestamp in seconds
      const redisTimestamp = convertToUnixTimestamp(nextReviewDue);

      // uptash handles serialization of updatedRecord JS object, no need to worry about JSON.parse
      await redis.multi()
        .set(recordKey, updatedRecord)
        .zadd(queueKey, {
          score: redisTimestamp,
          member: titleSlug
        })
        .exec();

      // lets build a readable date:
      const readableDate = new Date(nextReviewDue).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric"
      })

      // build a confirmation message
      const lines = [
        `Logged attempt for **${title}**`,
        `Outcome: ${outcome}`,
        `Box: ${newBox} → next review on **${readableDate}**`,
        notes ? `Notes: ${notes}` : null,
      ].filter(Boolean); // drops the null entry if no notes were given

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  )

    server.tool(
    "get_due_for_review",
    "Get LeetCode problems due for spaced-repetition review, split into overdue and due today",
    {
      username: z.string().describe("LeetCode username, used as the storage namespace"),
    },
    async ({ username }) => {
      const queueKey = `user:${username}:review_queue`;
      const nowSeconds = Math.floor(Date.now() / 1000);

      // compute start-of-today as a unix timestamp (seconds) —
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const startOfTodaySecond = Math.floor(startOfToday.getTime()/1000);

      // ZRANGEBYSCORE — get every titleSlug due at or before right now
      const dueSlugs = await redis.zrange(queueKey, 0, nowSeconds, {byScore: true});

      // guard
      if(dueSlugs.length === 0){
        return { content: [{ type: "text", text: "Nothing is due right now!"}] };
      }

      // grab the batch of titleSlugs(identifiers) of all due problems
      const keysToFetch = dueSlugs.map((titleSlug) => `user:${username}:problem:${titleSlug}`)
      const recordsFetched = await redis.mget(...keysToFetch);
      // get those exact records from redis using the titleSlug.

      // split records into two buckets by comparing each record's  
      // everything that is less than start of today should be overdue
      // everything that is >= is due today
      const overdueSlugs = recordsFetched.filter(record => convertToUnixTimestamp(record.nextReviewDue) < startOfTodaySecond);
      const currentlyDueSlugs = recordsFetched.filter(record => convertToUnixTimestamp(record.nextReviewDue) >= startOfTodaySecond);

      // sort our overdue slugs based on the worst overdue
      overdueSlugs.sort((a, b) => {
        const daysA = daysOverdue(a.nextReviewDue);
        const daysB = daysOverdue(b.nextReviewDue);
        if(daysA != daysB){
          // return the smaller dau
          return daysA - daysB;
        }
        // return the seconds difference
        return convertToUnixTimestamp(a.nextReviewDue) - convertToUnixTimestamp(b.nextReviewDue);
      })

      // build lines[]
      const lines = [`## Review Queue for @${username}`];

      if (overdueSlugs.length > 0) {
        lines.push(`\n**${overdueSlugs.length} overdue**`);
        for (const record of overdueSlugs) {
          const days = daysOverdue(record.nextReviewDue);
          lines.push(`- ${record.title} (box ${record.box}) — ${days} day${days === 1 ? "" : "s"} overdue`);
        }
      }

      if (currentlyDueSlugs.length > 0) {
        lines.push(`\n**${currentlyDueSlugs.length} due today**`);
        for (const record of currentlyDueSlugs) {
          lines.push(`- ${record.title} (box ${record.box})`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // -------------- PROGRESS TRACKING WITH REAL MEMORY --------------
  server.tool(
    "set_review_intensity",
    "Configure how often Tether checks in with you and on which days",
    {
      username: z.string().describe("LeetCode username, used as the storage namespace"),
      intensity: z.enum(["GRIND", "MODERATE", "BUSY", "MINIMAL"]).describe(
        "GRIND = every day, MODERATE = 3-4 days/week, BUSY = 2 days/week, MINIMAL = Sunday only"
      ),
      activeDays: z.array(z.enum(DAYS)).optional().describe(
        "Required for MODERATE (3-4 days) and BUSY (exactly 2 days). Ignored for GRIND and MINIMAL."
      ),
      phoneNumber: z.string().optional().describe(
        "E.164 format, e.g. +15551234567. Only needed the first time, or to change it."
      ),
    },
    async ({ username, intensity, activeDays, phoneNumber }) => {
      // runtime validation based on intensity
      const settingsKey = `user:${username}:settings`;
      if(intensity === 'MODERATE'){
        // let the active days be chosen
        if (!activeDays || (activeDays.length !== 3 && activeDays.length !== 4)) {
          return {
            content: [{ type: "text", text: "MODERATE intensity needs exactly 3 or 4 active days." }],
          };
        }
      }
      else if(intensity === 'BUSY'){
        // let active days be chosen
        if (!activeDays || (activeDays.length !== 2)) {
          return {
            content: [{ type: "text", text: "BUSY intensity needs exactly 2 active days." }],
          };
        }
      }
      // we don't read grind or minimal:
      // why? --> Because activeDays is ignore even if it can be passed since we know its every day or 1 day a week
      
      // Read existing settings
      const existingSettings = await redis.get(settingsKey);

      const resolvedPhoneNumber = phoneNumber || existingSettings?.phoneNumber;

      if (!resolvedPhoneNumber) {
        return {
          content: [{ type: "text", text: "No phone number on file — please provide one the first time you set your intensity." }],
        };
      }

      const updatedSettings = {
        intensity,
        activeDays: intensity === "GRIND" || intensity === "MINIMAL" ? null : activeDays,
        phoneNumber: resolvedPhoneNumber
      }

      await redis.set(settingsKey, updatedSettings)
  
      // Build a confirmation message summarizing what was just set
      const dayLabel = updatedSettings.activeDays
      ? updatedSettings.activeDays.join(", ")
      : intensity === "GRIND"
        ? "every day"
        : "Sundays only";
    
      const lines = [
        `Tether intensity set to **${intensity}**`,
        `Check-in days: ${dayLabel}`,
        `Phone on file: ${resolvedPhoneNumber}`,
        `Note: every tier also gets the weekly Sunday digest, regardless of intensity.`,
      ];
    
      return { content: [{ type: "text", text: lines.join("\n") }] };  
    }
  );  


  // -------------- DEEPER ANALYSIS --------------
  // Tool: compare_topic_coverage
  server.tool(
    "compare_topic_coverage",
    "Compare a user's LeetCode tag coverage against core topics expected in FAANG-style interviews",
    {
      username: z.string().describe("Leetcode Username")
    },
    async ({ username }) => {
      const data = await lcQuery(PROBLEM_TAGS_QUERY, {username});
      const user = data.matchedUser
      
      // Guard clause — !user
      if(!user){
        return { content: [{ type: "text", text: `User ${username} is not found` }] };
      }

      const allTags = [
        ...user.tagProblemCounts.advanced,
        ...user.tagProblemCounts.intermediate,
        ...user.tagProblemCounts.fundamental,
      ];

      // Build a lookup map: tagName -> problemsSolved
      const solvedMap = new Map(allTags.map(t => [t.tagName, t.problemsSolved]))

      // For each tag in CORE_FAANG_TAGS, look up solvedMap.get(tag) ?? 0
      // (default to 0 if the tag never appears — means user hasn't solved any)
      // Build a result array: [{ tag, solved, status }]
      const resultArray = []
      for(const eachTag of CORE_FAANG_TAGS){
        const solvedCount =  solvedMap.get(eachTag) ?? 0;
        const status = coverageStatus(solvedCount);
        resultArray.push({tag: eachTag, solved: solvedCount, status});
      }

      // Sort so Critical Gaps show first
      resultArray.sort((a, b) => a.solved - b.solved )

      const criticalCount = resultArray.filter((r) => r.status.includes("Critical")).length;

      const lines = [
        `## Topic Coverage vs. Core FAANG Interview Tags\n`,
        `**${criticalCount} of ${resultArray.length} core topics are Critical Gaps**\n`,
        "| Topic | Solved | Status |",
        "|---|---|---|",
      ];

      for (const r of resultArray) {
        lines.push(`| ${r.tag} | ${r.solved} | ${r.status} |`);
      }

      const exploreArray = [];
      for (const eachTag of EXPLORE_TAGS) {
        const solvedCount = solvedMap.get(eachTag) ?? 0;
        exploreArray.push({ tag: eachTag, solved: solvedCount });
      }

      exploreArray.sort((a, b) => a.solved - b.solved);

      lines.push(
        "\n### Explore Later (situational / company-dependent)",
        "| Topic | Solved |",
        "|---|---|"
      );

      for (const r of exploreArray) {
        lines.push(`| ${r.tag} | ${r.solved} |`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  return server;
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ─── Stub OAuth (auto-approve, no real auth) ─────────────────────────────────
// This exists only to satisfy Claude's OAuth Dynamic Client Registration (DCR)
// handshake. It does not protect anything — every request is auto-approved.
// In-memory only; resets on server restart, which is fine since nothing here
// is meant to persist.
 
const clients = new Map();   // client_id -> client metadata
const authCodes = new Map(); // code -> { client_id, redirect_uri, expires }
const tokens = new Map();    // access_token -> { client_id, expires }
 
function randomToken(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
 
// Base URL Claude uses to reach this server. Render sets RENDER_EXTERNAL_URL;
// fall back to constructing from the request if that's not set.
function baseUrl(req) {
  return process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`;
}
 
// 1. OAuth server metadata (RFC 8414)
app.get("/.well-known/oauth-authorization-server", (req, res) => {
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
});
 
// 2. Protected resource metadata (RFC 9728) — some clients check this too
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const b = baseUrl(req);
  res.json({
    resource: `${b}/mcp`,
    authorization_servers: [b],
  });
});
 
// 3. Dynamic Client Registration (RFC 7591) — always succeeds
app.post("/oauth/register", (req, res) => {
  const client_id = randomToken("client");
  const client = {
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
 
// 4. Authorization endpoint — auto-approves, immediately redirects with a code
app.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state, client_id } = req.query;
  if (!redirect_uri) return res.status(400).send("Missing redirect_uri");
 
  const code = randomToken("code");
  authCodes.set(code, {
    client_id,
    redirect_uri,
    expires: Date.now() + 60_000,
  });
 
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});
 
// 5. Token endpoint — exchanges the code for a dummy access token
app.post("/oauth/token", express.urlencoded({ extended: true }), (req, res) => {
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
    expires: Date.now() + 3600_000,
  });
 
  res.json({
    access_token,
    token_type: "Bearer",
    expires_in: 3600,
  });
});
// ─── End stub OAuth ───────────────────────────────────────────────────────────

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
