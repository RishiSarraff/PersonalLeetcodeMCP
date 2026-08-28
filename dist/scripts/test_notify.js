import "dotenv/config";
import { getNotifier } from '../notifier.js';
const to = process.argv[2];
if (!to) {
    console.error("Usage: node dist/scripts/test_notify.js \"+1XXXXXXXXXX\"");
    process.exit(1);
}
const notifier = getNotifier();
const result = await notifier.send(to, "Tether notifier test - if you got this, notification works");
console.log(result);
if (!result.ok)
    process.exit(1);
