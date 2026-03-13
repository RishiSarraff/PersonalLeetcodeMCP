# LeetCode MCP Connector for Claude.ai

A remote MCP server that gives Claude access to your LeetCode submission history and weak area analysis.

## Tools provided

| Tool | Description |
|------|-------------|
| `get_submission_history` | Recent submissions with status, language, and multi-attempt detection |
| `analyze_weak_areas` | Topic-by-topic breakdown of weakest vs strongest areas with recommendations |
| `get_user_stats` | Overall accepted/submission counts, streaks, and ranking percentile |
| `get_daily_challenge` | Today's daily challenge problem |

## Setup

### 1. Install & run locally

```bash
npm install
npm start
# → Listening on http://localhost:3000
```

### 2. Deploy (required for Claude.ai)

Claude.ai requires a **publicly accessible HTTPS URL**. Choose one:

#### Option A — Railway (easiest, free tier)
1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Railway auto-detects Node.js and gives you a public URL like `https://leetcode-mcp-xxx.railway.app`

#### Option B — Render
1. Push to GitHub
2. [render.com](https://render.com) → New Web Service → connect repo
3. Build: `npm install`, Start: `node server.js`
4. Gets a URL like `https://leetcode-mcp.onrender.com`

#### Option C — Docker (any VPS/cloud)
```bash
docker build -t leetcode-mcp .
docker run -p 3000:3000 leetcode-mcp
# Then point a domain + SSL at port 3000
```

#### Option D — Cloudflare Workers (advanced)
Cloudflare has built-in MCP support. See: https://developers.cloudflare.com/mcp/

### 3. Add to Claude.ai

Once deployed:
1. Go to **Claude.ai → Settings → Connectors**
2. Click **"Add custom connector"**
3. Enter your server URL: `https://your-deployment-url.com/mcp`
4. Click **Add**

That's it — Claude will now have access to the LeetCode tools.

## Example prompts

After connecting, try asking Claude:

- *"Analyze my weak areas on LeetCode — my username is @john_doe"*
- *"Show me my last 20 submissions and tell me which problems I struggled with"*
- *"What are my LeetCode stats and what should I focus on next?"*
- *"What's today's daily challenge?"*

## Notes on LeetCode's API

- **Public data**: `get_submission_history`, `get_user_stats`, `analyze_weak_areas`, and `get_daily_challenge` all work with public profile data — no login required, as long as the target profile is public.
- **Private profiles**: If a user has a private profile, LeetCode will return empty data. The user must set their profile to public in LeetCode Settings → Privacy.
- LeetCode does not have an official public API. This server uses the same GraphQL endpoint that LeetCode's own frontend uses. It may break if LeetCode changes their API structure.

## Extending this server

To add more tools, follow the pattern in `server.js`:
```js
server.tool("tool_name", "description", { param: z.string() }, async ({ param }) => {
  // call lcQuery() and return results
  return { content: [{ type: "text", text: "..." }] };
});
```

Useful queries to add:
- Problem search by tag/difficulty (uses `problemsetQuestionList` query)
- Company-tagged problems (requires LeetCode Premium session cookie)
- Contest history (query is already in the file as `CONTEST_HISTORY_QUERY`)
