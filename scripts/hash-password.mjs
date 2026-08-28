import { randomBytes, scryptSync } from "node:crypto";
import { stdin, stdout } from "node:process";

function readHidden(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Run this command in an interactive terminal.");
  }

  return new Promise((resolve) => {
    let value = "";
    const wasRaw = stdin.isRaw;

    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stdout.write("\n");
      resolve(value);
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          stdout.write("\n");
          process.exit(130);
        }

        if (character === "\r" || character === "\n") {
          finish();
          return;
        }

        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }

        value += character;
        stdout.write("*");
      }
    };

    stdout.write(prompt);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

const password = await readHidden("Password to hash: ");
const confirmation = await readHidden("Confirm password: ");

if (password.length < 12) {
  console.error("Use a password with at least 12 characters.");
  process.exitCode = 1;
} else if (password !== confirmation) {
  console.error("Passwords did not match. Run the command again.");
  process.exitCode = 1;
} else {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(password, salt, 64).toString("hex");
  console.log(`\nADMIN_PASSWORD_HASH=${salt}:${derivedKey}`);
}
