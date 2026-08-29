// src/helpers
import type {
  Outcome,
  Difficulty,
  TagProblemCounts,
  SubmissionEntry,
} from "./types.js";

// ─── Spaced repetition ───────────────────────────────────────────────────────

export const BOX_INTERVALS_DAYS: number[] = [1, 2, 4, 7, 14, 30];
export function computeNextBox(
  currentBox: number | null,
  outcome: Outcome,
): number {
  switch (outcome) {
    case "FAILED":
      return 0;
    case "STRUGGLED":
      return 1;
    case "SOLVED_WITH_HELP":
      return 2;
    case "SOLVED_CONFIDENT":
      // if the first time we solved this confidently, then we start at 3
      // if this not the first time, we climb up one
      return currentBox === null ? 3 : Math.min(currentBox + 1, 5);
    // if we already mastered, we dont want to go beyond 5, keep range same as index of outcomes array
    default:
      // TypeScript's exhaustiveness check: if a 5th Outcome is ever added
      // without a case here, this line fails to compile — the argument
      // passed to `never` won't be assignable, catching the gap at build time
      const _exhaustive: never = outcome;
      throw new Error(`Unknown outcome: ${_exhaustive}`);
  }
}

export function computeAgedBox(currentBox: number): number {
  return Math.max(currentBox - 1, 0);
}

export function computeNextReviewDue(box: number): string {
  const days = BOX_INTERVALS_DAYS[box];
  const due = new Date();
  due.setDate(due.getDate() + days);
  return due.toISOString();
}

export function convertToUnixTimestamp(isoString: string): number {
  return Math.floor(new Date(isoString).getTime() / 1000);
}

export function daysOverdue(nextReviewDue: string): number {
  const dueSeconds = convertToUnixTimestamp(nextReviewDue);
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.floor((nowSeconds - dueSeconds) / 86400);
}

const HTML_ENTITY_MAP: Record<string, string> = {
  "&nbsp;": " ",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&amp;": "&",
};

export function cleanHtmlContent(uncleanedContent: string): string {
  return uncleanedContent
    .replace(/<\/p>|<br\s*\/?>|<\/pre>/g, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&nbsp;|&lt;|&gt;|&quot;|&amp;/g,
      (match) => HTML_ENTITY_MAP[match],
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

// ─── Mock interview ──────────────────────────────────────────────────────────
const TIME_LIMITS: Record<Difficulty, number> = {
  EASY: 20,
  MEDIUM: 30,
  HARD: 45,
};

export function difficultyBasedTimeLimit(difficulty: Difficulty): number {
  return TIME_LIMITS[difficulty];
}

// ─── Topic coverage ──────────────────────────────────────────────────────────

export function coverageStatus(solved: number): string {
  if (solved <= 7) return "🔴 Critical Gap";
  if (solved <= 15) return "🟡 Developing";
  return "🟢 Strong";
}

export const CORE_FAANG_TAGS: string[] = [
  "Array",
  "Hash Table",
  "Two Pointers",
  "Sliding Window",
  "String",
  "Binary Search",
  "Dynamic Programming",
  "Backtracking",
  "Stack",
  "Queue",
  "Heap (Priority Queue)",
  "Greedy",
  "Bit Manipulation",
  "Tree",
  "Binary Tree",
  "Depth-First Search",
  "Breadth-First Search",
  "Graph Theory",
  "Linked List",
  "Sorting",
  "Matrix",
  "Prefix Sum",
  "Recursion",
  "Union-Find",
  "Trie",
  "Topological Sort",
  "Monotonic Stack",
];

export const EXPLORE_TAGS: string[] = [
  "Binary Search Tree",
  "Divide and Conquer",
  "Memoization",
  "Math",
  "Simulation",
  "Ordered Map",
  "Ordered Set",
  "Bitmask",
  "Shortest Path",
  "Dijkstra's Algorithm",
  "Minimum Spanning Tree",
  "Segment Tree",
  "Binary Indexed Tree",
  "Counting",
  "Enumeration",
  "Number Theory",
  "Combinatorics",
  "Game Theory",
  "Rolling Hash",
  "Sweep Line",
  "Doubly-Linked List",
  "Monotonic Queue",
  "Quickselect",
  "Lowest Common Ancestor",
  "Design",
  "Concurrency",
  "Database",
];

// ─── Weak area / submission analysis ────────────────────────────────────────

interface WeakStrongTag {
  tag: string;
  solved: number;
}

export function analyzeWeakAreas(tagStats: TagProblemCounts): {
  weak: WeakStrongTag[];
  strong: WeakStrongTag[];
  total: number;
} {
  const allTags = [
    ...tagStats.advanced,
    ...tagStats.intermediate,
    ...tagStats.fundamental,
  ];
  const sorted = [...allTags].sort(
    (a, b) => a.problemsSolved - b.problemsSolved,
  );

  const weak = sorted
    .slice(0, 8)
    .map((t) => ({ tag: t.tagName, solved: t.problemsSolved }));
  const strong = sorted
    .slice(-5)
    .reverse()
    .map((t) => ({ tag: t.tagName, solved: t.problemsSolved }));

  return { weak, strong, total: allTags.length };
}

export function categorizeSubmissions(submissions: SubmissionEntry[]): {
  byStatus: Record<string, number>;
  byLang: Record<string, number>;
  multipleAttempts: string[];
} {
  const byStatus: Record<string, number> = {};
  const byLang: Record<string, number> = {};
  const byProblem: Record<
    string,
    { title: string; attempts: number; accepted: boolean }
  > = {};

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
