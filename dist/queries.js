// src/queries.ts
const LEETCODE_GRAPHQL = "https://leetcode.com/graphql";
const csrftoken = process.env.CSRF_TOKEN;
const leetcodeSession = process.env.LEETCODE_SESSION;
export async function lcQuery(query, variables = {}, session = leetcodeSession) {
    const headers = {
        "Content-Type": "application/json",
        Referer: "https://leetcode.com",
        Origin: "https://leetcode.com",
    };
    if (session) {
        headers["Cookie"] = `LEETCODE_SESSION=${session}; csrftoken=${csrftoken}`;
        headers["X-CSRFToken"] = csrftoken ?? "";
    }
    const res = await fetch(LEETCODE_GRAPHQL, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok)
        throw new Error(`LeetCode API error: ${res.status}`);
    const json = (await res.json());
    if (json.errors)
        throw new Error(json.errors.map((e) => e.message).join(", "));
    // TypeScript can't prove `data` exists just because `errors` doesn't —
    // that's a runtime contract from LeetCode's API, not something the type
    // system can verify. This is an honest, deliberate assertion, not a gap.
    return json.data;
}
// ─── Query strings + their response envelopes ───────────────────────────────
export const SUBMISSION_HISTORY_QUERY = `
    query submissionList($username: String!, $limit: Int, $offset: Int) {
      recentSubmissionList(username: $username, limit: $limit) {
        title titleSlug timestamp statusDisplay lang id
      }
    }
  `;
export const USER_STATS_QUERY = `
    query userPublicProfile($username: String!) {
      matchedUser(username: $username) {
        submitStats: submitStatsGlobal { acSubmissionNum { difficulty count submissions } }
        problemsSolvedBeatsStats { difficulty percentage }
        userCalendar { streak totalActiveDays }
      }
    }
  `;
export const PROBLEM_TAGS_QUERY = `
    query getUserTagStats($username: String!) {
      matchedUser(username: $username) {
        tagProblemCounts {
          advanced { tagName problemsSolved }
          intermediate { tagName problemsSolved }
          fundamental { tagName problemsSolved }
        }
      }
    }
  `;
export const DAILY_CHALLENGE_QUERY = `
    query questionOfToday {
      activeDailyCodingChallengeQuestion {
        date link
        question { title difficulty topicTags { name } acRate }
      }
    }
  `;
export const PROBLEMSET_QUERY_V2 = `
    query problemsetQuestionListV2($filters: QuestionFilterInput, $limit: Int, $searchKeyword: String, $skip: Int, $sortBy: QuestionSortByInput, $categorySlug: String) {
      problemsetQuestionListV2(
        filters: $filters limit: $limit searchKeyword: $searchKeyword
        skip: $skip sortBy: $sortBy categorySlug: $categorySlug
      ) {
        questions {
          titleSlug title questionFrontendId paidOnly difficulty
          topicTags { name slug } acRate frequency
        }
        totalLength hasMore
      }
    }
  `;
export const QUESTION_DETAIL_QUERY = `
    query questionDetail($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        title titleSlug questionFrontendId content difficulty stats
        topicTags { name slug }
        similarQuestionList { title titleSlug difficulty isPaidOnly }
        nextChallenges { title titleSlug difficulty questionFrontendId }
        isPaidOnly hints exampleTestcaseList
      }
    }
  `;
export const SIMILAR_QUESTIONS_QUERY = `
    query similarQuestions($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        title
        similarQuestionList { title titleSlug difficulty isPaidOnly }
      }
    }
  `;
export const NEXT_CHALLENGES_QUERY = `
    query nextChallenges($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        title
        nextChallenges { title titleSlug difficulty questionFrontendId }
      }
    }
  `;
