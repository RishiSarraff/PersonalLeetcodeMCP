// src/redis
import { Redis } from "@upstash/redis";
export const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
// ─── Key builders ────────────────────────────────────────────────────────────
// Single source of truth for key format. Every caller uses these — nobody
// hand-builds a template literal key string anywhere else in the codebase.
export function recordKey(username, titleSlug) {
    return `user:${username}:problem:${titleSlug}`;
}
export function queueKey(username) {
    return `user:${username}:review_queue`;
}
export function settingsKey(username) {
    return `user:${username}:settings`;
}
// ─── Typed record access ─────────────────────────────────────────────────────
export async function getProblemRecord(username, titleSlug) {
    return redis.get(recordKey(username, titleSlug));
}
export async function setProblemRecord(username, titleSlug, record, dueTimestamp) {
    await redis
        .multi()
        .set(recordKey(username, titleSlug), record)
        .zadd(queueKey(username), { score: dueTimestamp, member: titleSlug })
        .exec();
}
export async function getUserSettings(username) {
    return redis.get(settingsKey(username));
}
export async function setUserSettings(username, settings) {
    await redis.set(settingsKey(username), settings);
}
// ─── Batch reads for the review queue ────────────────────────────────────────
export async function getDueTitleSlugs(username, maxScore) {
    return redis.zrange(queueKey(username), 0, maxScore, { byScore: true });
}
export async function getProblemRecordsBatch(username, titleSlugs) {
    const keys = titleSlugs.map((slug) => recordKey(username, slug));
    return redis.mget(...keys);
}
