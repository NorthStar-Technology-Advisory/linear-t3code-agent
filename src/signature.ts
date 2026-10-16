import { createHmac, timingSafeEqual } from "node:crypto";

export const sign = (secret: string, body: Buffer): string => createHmac("sha256", secret).update(body).digest("hex");
export const verifySignature = (secret: string, body: Buffer, signature: string | undefined): boolean => {
  if (!signature || !/^[a-f\d]{64}$/i.test(signature)) return false;
  return timingSafeEqual(Buffer.from(sign(secret, body), "hex"), Buffer.from(signature, "hex"));
};
export const isFresh = (timestamp: unknown, now: number, maxAge: number): boolean =>
  typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp <= now + 60000 && now - timestamp <= maxAge;
