// src/notifier.ts

import twilio from "twilio";

export interface Notifier{
    send(to: string, message: string): Promise<{ ok: boolean, error?: string}>;
}

export class TwilioNotifier implements Notifier{
    private client: ReturnType<typeof twilio>;
    private fromNumber: string;

    constructor() {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const apiKeySid = process.env.TWILIO_API_KEY_SID;
        const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
        
        const from = process.env.TWILIO_FROM_NUMBER;

        if(!accountSid ||  !apiKeySid || !apiKeySecret || !from){
            throw new Error(
                "Missing TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, or TWILIO_FROM_NUMBER"  
            );
        }
        // API Key auth: the first two args are the API Key SID/Secret (the actual
        // credential pair being used to authenticate); accountSid just tells
        // Twilio which account this key is allowed to act on.
        this.client = twilio(apiKeySid, apiKeySecret, { accountSid });
        this.fromNumber = from;
    }

    async send(to: string, message: string): Promise<{ok: boolean, error?: string}>{
        try{
            await this.client.messages.create({
                to,
                from: this.fromNumber,
                body: message
            })

            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err)}
        }
    }
}

// Lets everything upstream (OTP flow, daily-check worker) be built and tested
// before Twilio is fully wired up (toll-free verification pending, etc.), or
// run locally without spending SMS credits.
export class ConsoleNotifier implements Notifier{
    async send(to: string, message: string): Promise<{ok: boolean}>{
        console.log(`[ConsoleNotifier] -> ${to}: ${message}`)
        return {ok: true};
    }
}

let cachedNotifier: Notifier | null = null;

export function getNotifier(): Notifier{
    if(cachedNotifier){ return cachedNotifier }

    const hasTwilio = 
        process.env.TWILIO_ACCOUNT_SID && 
        process.env.TWILIO_API_KEY_SID && 
        process.env.TWILIO_API_KEY_SECRET && 
        process.env.TWILIO_FROM_NUMBER;

    cachedNotifier = hasTwilio ? new TwilioNotifier() : new ConsoleNotifier()
    return cachedNotifier;  
}