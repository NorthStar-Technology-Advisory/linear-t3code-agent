import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type TokenRecord = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at: number;
  scope?: string | string[];
  viewer_app_user_id?: string;
};

export type StateRecord = {
  state: string;
  created_at: number;
  expires_at: number;
};

async function ensureParent(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writePrivateJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureParent(filePath);
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  const file = await fs.open(tmpPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally { await file.close(); }
  await fs.rename(tmpPath, filePath);
  await fs.chmod(filePath, 0o600);
}
