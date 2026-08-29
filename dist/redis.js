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
export function otpKey(phone) {
    return `auth:otp:${phone}`;
}
export function otpAttemptsKey(phone) {
    return `auth:otp:${phone}:attempts`;
}
export function otpCooldownKey(phone) {
    return `auth:otp:${phone}:cooldown`;
}
export function phoneUserKey(phone) {
    return `auth:phone:${phone}`;
}
export function allUsersKey() {
    return `tether:all_users`;
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
// ─── OTP Storage/Verification ─────────────────────────────────────────────────────
// Constants:
const OTP_TTL_SECONDS = 300;
const OTP_COOLDOWN_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;
// Primary Function: returns false if a code is already sent to this phone in the last OTP_COOLDOWN_SECONDS
// do current time - OTPCOOLDOWNSECONDS after finding the number from redis
// Enforced via Redis' NX (only-set if absent) --> not a simple client side check
// nx means only set if it doesnt exist
// ex gives our key the cooldown time (1 minute)
// we set the first request here into redis and any other requests made within the next 1 minute return false
// This is to avoid spamming requests for codes
export async function tryStartOTPCooldown(phone) {
    const result = await redis.set(otpCooldownKey(phone), "1", {
        nx: true,
        ex: OTP_COOLDOWN_SECONDS,
    });
    return result === "OK";
}
// we have to do multiple actions:
// set the otpkeys value to a new code along with the TTL (5 minutes)
// delete any old number of attempts --> refresh/restart to 0
// execute these two actions
export async function storeOTP(phone, code) {
    await redis
        .multi()
        .set(otpKey(phone), code, { ex: OTP_TTL_SECONDS })
        .del(otpAttemptsKey(phone))
        .exec();
}
//export type VerifyOTPResult = "ok" | "invalid_phone" | "invalid" | "expired" | "too_many_attempts";
// given the phone and string
// we need to verify a few things:
// 1) Check if the phone exists in our redis using the key
// 2) Check if the key itself has expired
// 3) Check if the code itself is valid
// 4) Check if the Number of attempts is greater than the maxamount of attempts
export async function verifyStoredOTP(phone, submittedCode) {
    const numAttempts = await redis.incr(otpAttemptsKey(phone));
    // first attempt = we start tracking attempts from 1
    if (numAttempts === 1) {
        await redis.expire(otpAttemptsKey(phone), OTP_TTL_SECONDS);
    }
    // if we exceeded maximum number of attempts, we return too many attempts
    if (numAttempts > OTP_MAX_ATTEMPTS) {
        return "too_many_attempts";
    }
    // get the key from redis, if the key itself doesnt exist: return expired
    // if the value is not the same as our code its an invalid code, we return invalid
    const stored = await redis.get(otpKey(phone));
    if (!stored)
        return "expired";
    if (stored !== submittedCode)
        return "invalid";
    // if the verification was successful
    // delete the OTP and its associated attempts key
    await redis.del(otpKey(phone));
    await redis.del(otpAttemptsKey(phone));
    return "ok";
}
// ─── AUTH/IDENTITY ─────────────────────────────────────────────────────
export async function getUsernameForPhone(phone) {
    return redis.get(phoneUserKey(phone));
}
export async function registerUser(phone, username) {
    await redis
        .multi()
        .set(phoneUserKey(phone), username)
        .sadd(allUsersKey(), username)
        .exec();
}
export async function getAllUsernames() {
    return redis.smembers(allUsersKey());
}
// ─── Batch reads for the review queue ────────────────────────────────────────
export async function getDueTitleSlugs(username, maxScore) {
    return redis.zrange(queueKey(username), 0, maxScore, {
        byScore: true,
    });
}
export async function getProblemRecordsBatch(username, titleSlugs) {
    const keys = titleSlugs.map((slug) => recordKey(username, slug));
    return redis.mget(...keys);
}
