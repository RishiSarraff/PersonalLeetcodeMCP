// src/types

// internal Tether/Redis types
export type Difficulty = "EASY" | "MEDIUM" | "HARD";

export const OUTCOMES = [
  "FAILED",
  "STRUGGLED",
  "SOLVED_WITH_HELP",
  "SOLVED_CONFIDENT",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export type DayOfWeek = (typeof DAYS)[number];

export const INTENSITY = ["GRIND", "MODERATE", "BUSY", "MINIMAL"] as const;
export type Intensity = (typeof INTENSITY)[number];

export interface HistoryEntry {
  timestamp: string;
  outcome: Outcome | "AUTO_AGED";
  notes: string | null;
}

export interface ProblemRecord {
  title: string;
  titleSlug: string;
  difficulty: Difficulty;
  tags: string[];
  box: number;
  attemptCount: number;
  lastOutcome: Outcome | "AUTO_AGED";
  lastReviewed: string;
  nextReviewDue: string;
  history: HistoryEntry[];
}

export interface UserSettings {
  username: string;
  intensity: Intensity;
  activeDays: DayOfWeek[] | null;
  phoneNumber: string;
}

// ─── LeetCode GraphQL response shapes (only fields actually used) ───────────
export interface TopicTag {
  name: string;
  slug?: string;
}

export interface SubmissionEntry {
  title: string;
  titleSlug: string;
  timestamp: string;
  statusDisplay: string;
  lang: string;
  id: string;
}

export interface TagCount {
  tagName: string;
  problemsSolved: number;
}

export interface TagProblemCounts {
  advanced: TagCount[];
  intermediate: TagCount[];
  fundamental: TagCount[];
}

export interface AcSubmissionNum {
  difficulty: string;
  count: number;
  submissions: number;
}

export interface BeatsStat {
  difficulty: string;
  percentage: number;
}

export interface UserCalendar {
  streak: number;
  totalActiveDays: number;
}

export interface MatchedUserStats {
  submitStats?: { acSubmissionNum: AcSubmissionNum[] };
  problemsSolvedBeatsStats?: BeatsStat[];
  userCalendar?: UserCalendar;
  tagProblemCounts?: TagProblemCounts;
}

export interface ProblemsetQuestion {
  titleSlug: string;
  title: string;
  questionFrontendId: string;
  paidOnly: boolean;
  difficulty: string;
  topicTags: TopicTag[];
  acRate: number;
  frequency: number | null;
}

export interface SimilarQuestion {
  title: string;
  titleSlug: string;
  difficulty: string;
  isPaidOnly: boolean;
}

export interface NextChallenge {
  title: string;
  titleSlug: string;
  difficulty: string;
  questionFrontendId: string;
}

export interface QuestionDetail {
  title: string;
  titleSlug: string;
  questionFrontendId: string;
  content: string;
  difficulty: string;
  stats: string; // JSON string — parse before use
  topicTags: TopicTag[];
  similarQuestionList: SimilarQuestion[];
  nextChallenges: NextChallenge[];
  isPaidOnly: boolean;
  hints: string[];
  exampleTestcaseList: string[];
}

export interface QuestionStats {
  totalAccepted: string;
  totalSubmission: string;
  totalAcceptedRaw: number;
  totalSubmissionRaw: number;
  acRate: string;
}

export interface DailyChallengeQuestion {
  date: string;
  link: string;
  question: {
    title: string;
    difficulty: string;
    topicTags: TopicTag[];
    acRate: number;
  };
}
