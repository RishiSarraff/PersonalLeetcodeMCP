// src/otp.ts

// This file orchestrates OTP logic:
// Steps:
// 1) normalize phone number (cleaning)
// 2) Generate code with real CSPRNG (not Math.random)
// 3) Wraps the Redis primitives in redis.ts with actual send-a-text step using Notifier Abstraction

import { randomInt } from "node:crypto";
import { tryStartOTPCooldown, storeOTP, verifyStoredOTP } from "./redis.js";
import { getNotifier } from "./notifier.js";

// Basic Normalization centered around US,
// assumes a bare 10 digit code/number is given if a country code not given
// TODO: use a phone-parsing library when Tether grows

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");

  if (digits.startsWith("+")) {
    return digits;
  }

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return null; // every other case fails
}

function generateOTPCode(): string {
  // randomInt(0, 1_000_000) is uniform over [0, 999999]
  // pad to always by 6 digits: so 482 becomes 000482
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export type SendOTPResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: "invalid_phone" | "cooldown" | "send_failed";
      error?: string;
    };

export async function sendOTP(rawPhone: string): Promise<SendOTPResult> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ok: false, reason: "invalid_phone" };

  const allowed = await tryStartOTPCooldown(phone);
  if (!allowed) return { ok: false, reason: "cooldown" };

  const code = generateOTPCode();
  await storeOTP(phone, code);

  // set TTL for 5 minutes
  const result = await getNotifier().send(
    phone,
    `Your Tether Verification code is ${code}. It expires in 5 minutes.`,
  );

  if (!result.ok) {
    return { ok: false, reason: "send_failed" };
  }

  return { ok: true };
}

export type VerifyOTPResult =
  "ok" | "invalid_phone" | "invalid" | "expired" | "too_many_attempts";

export async function verifyOTP(
  rawPhone: string,
  code: string,
): Promise<VerifyOTPResult> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return "invalid_phone";
  return verifyStoredOTP(phone, code.trim());
}
