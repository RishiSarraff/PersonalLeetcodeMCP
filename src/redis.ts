// src/redis

import { Redis } from "@upstash/redis";
import type { ProblemRecord, UserSettings } from "./types.js";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ─── Key builders ────────────────────────────────────────────────────────────
// Single source of truth for key format. Every caller uses these — nobody
// hand-builds a template literal key string anywhere else in the codebase.

export function recordKey(username: string, titleSlug: string): string {
    return `user:${username}:problem:${titleSlug}`;
}

export function queueKey(username: string): string {
    return `user:${username}:review_queue`;
}

export function settingsKey(username: string): string {
    return `user:${username}:settings`;
}

// ─── Typed record access ─────────────────────────────────────────────────────

export async function getProblemRecord(
    username: string,
    titleSlug: string
  ): Promise<ProblemRecord | null> {
    return redis.get<ProblemRecord>(recordKey(username, titleSlug));
  }
  
  export async function setProblemRecord(
    username: string,
    titleSlug: string,
    record: ProblemRecord,
    dueTimestamp: number
  ): Promise<void> {
    await redis
      .multi()
      .set(recordKey(username, titleSlug), record)
      .zadd(queueKey(username), { score: dueTimestamp, member: titleSlug })
      .exec();
  }

  export async function getUserSettings(username: string): Promise<UserSettings | null> {
    return redis.get<UserSettings>(settingsKey(username));
  }
  
  export async function setUserSettings(username: string, settings: UserSettings): Promise<void> {
    await redis.set(settingsKey(username), settings);
  }

  // ─── Batch reads for the review queue ────────────────────────────────────────

export async function getDueTitleSlugs(username: string, maxScore: number): Promise<string[]> {
    return redis.zrange<string[]>(queueKey(username), 0, maxScore, { byScore: true });
}
  
export async function getProblemRecordsBatch(
    username: string,
    titleSlugs: string[]
): Promise<(ProblemRecord | null)[]> {
    const keys = titleSlugs.map((slug) => recordKey(username, slug));
    return redis.mget<ProblemRecord[]>(...keys);
}