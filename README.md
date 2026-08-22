# Tether — LeetCode MCP + Spaced Repetition Coach

A remote MCP server that connects Claude to your LeetCode data, tracks your
practice with a spaced-repetition system, and (optionally) sends scheduled
check-in texts so you actually keep up with review.

## Tools provided

| Tool | Description |
|---|---|
| `get_submission_history` | Recent submissions with status, language, multi-attempt detection |
| `analyze_weak_areas` | Topic-by-topic weak vs. strong breakdown |
| `get_user_stats` | Accepted/submission counts, streaks, ranking percentile |
| `get_daily_challenge` | Today's daily challenge problem |
| `search_problems_by_topic` | Filter problems by tag and/or difficulty |
| `get_problem_details` | Full statement, constraints, hints, examples for one problem |
| `get_similar_problems` | Problems LeetCode tags as related |
| `recommend_next_problem` | LeetCode's own "what to try next" suggestions |
| `start_mock_interview` | Random problem by difficulty/topic/company, framed as a timed interview |
| `log_attempt` | Record an attempt's outcome, updating its review schedule |
| `get_due_for_review` | What's due or overdue for spaced-repetition review |
| `set_review_intensity` | Configure check-in frequency (GRIND / MODERATE / BUSY / MINIMAL) and phone number |
| `compare_topic_coverage` | Your tag coverage vs. core FAANG interview topics |

## Setup

### 1. Environment variables

UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
LEETCODE_SESSION= # your LeetCode session cookie, for Premium-gated data
CSRF_TOKEN= # your LeetCode csrftoken cookie
DAILY_CHECK_SECRET= # shared secret protecting /internal/daily-check
TETHER_USERNAME= # your LeetCode username (solo-phase, hardcoded)

### 2. Local development
npm install
npm run build
npm start


### 3. Deploy (required for Claude.ai)

Push to GitHub, then deploy on [Render](https://render.com):
- **Runtime:** Docker (Dockerfile is included)
- Add all env vars above under the Environment tab

### 4. Add to Claude.ai

**Settings → Connectors → Add custom connector** → enter
`https://your-deployment-url.com/mcp`

### 5. Set up the daily check-in cron (optional)

Using a free service like [cron-job.org](https://cron-job.org), schedule a
daily `POST` to `https://your-deployment-url.com/internal/daily-check` with
header `x-daily-check-secret: <your DAILY_CHECK_SECRET>`.

## Notes on LeetCode's API

LeetCode has no official public API. This server uses the same GraphQL
endpoint LeetCode's own frontend uses — it may break if LeetCode changes
their API structure. Authenticated queries (Premium data, company tags)
require a valid `LEETCODE_SESSION` + `CSRF_TOKEN` pair from your browser.