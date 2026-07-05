import crypto from "node:crypto";

function base32Decode(encoded) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const result = [];

  const normalized = String(encoded)
    .trim()
    .replaceAll(/\s|-/g, "")
    .replaceAll(/=+$/g, "")
    .toUpperCase();

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const index = alphabet.indexOf(char);

    if (index === -1) {
      throw new Error(`Invalid base32 character: ${char}`);
    }

    bits += 5;
    value = (value << 5) | index;

    if (bits >= 8) {
      bits -= 8;
      result.push((value >> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }

  return Buffer.from(result);
}

export function generateTOTP(secretKey, timeStep = 30) {
  if (!secretKey || secretKey.trim().length === 0) {
    return null;
  }

  try {
    const buffer = base32Decode(secretKey.trim());
    const now = Math.floor(Date.now() / 1000);
    let movingCounter = Math.floor(now / timeStep);
    const counterBuffer = Buffer.alloc(8);

    for (let i = 7; i >= 0; i -= 1) {
      counterBuffer[i] = movingCounter & 0xff;
      movingCounter >>>= 8;
    }

    const hmac = crypto.createHmac("sha1", buffer);
    hmac.update(counterBuffer);
    const hash = hmac.digest();

    const offset = hash[hash.length - 1] & 0x0f;
    const code =
      ((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff);

    const totp = code % 1000000;
    return String(totp).padStart(6, "0");
  } catch (error) {
    console.error(`TOTP generation error: ${error.message}`);
    return null;
  }
}
