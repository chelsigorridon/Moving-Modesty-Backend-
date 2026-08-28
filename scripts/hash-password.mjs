import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline/promises";

const terminal = createInterface({ input: process.stdin, output: process.stdout });
const password = await terminal.question("Password to hash: ");
terminal.close();

if (password.length < 12) {
  console.error("Use a password with at least 12 characters.");
  process.exitCode = 1;
} else {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(password, salt, 64).toString("hex");
  console.log(`\nADMIN_PASSWORD_HASH=${salt}:${derivedKey}`);
}
