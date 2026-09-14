import { redactKnownSecrets } from "./secrets.js";

const MAX_PROGRESS_CHARS = 220;

const SAFE_FALLBACK_FIELDS = ["path", "file_path", "filePath", "query", "pattern", "glob", "url", "name", "title"];

function isSensitiveName(name: string): boolean {
  const normalized = name.replace(/[-_]/g, "").toLowerCase();
  return normalized === "key"
    || normalized === "apikey"
    || normalized.endsWith("apikey")
    || normalized === "pass"
    || normalized.includes("token")
    || normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("auth");
}

function sanitizeUrlText(text: string): string {
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveName(key)) url.searchParams.set(key, "redacted");
    }
    return url.toString();
  } catch {
    return text;
  }
}

function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrlText(url));
}

export function redact(text: string): string {
  return redactUrls(redactKnownSecrets(text))
    .replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer [redacted]")
    .replace(/(--(?:token|api-key|apikey|key|secret|password|pass|auth)(?:\s+|=))\S+/gi, "$1[redacted]")
    .replace(/(^|[\s"'`])([A-Z0-9_.-]+)\s*([=:])\s*(\S+)/gi, (match, prefix: string, name: string, separator: string) => {
      if (name.toLowerCase() === "authorization") return match;
      return isSensitiveName(name) ? `${prefix}${name}${separator}[redacted]` : match;
    })
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[redacted]")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "ghp_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]");
}

export function truncate(text: string, maxChars = MAX_PROGRESS_CHARS): string {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const clean = value.replace(/\s+/g, " ").trim();
    return clean || undefined;
  }
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const clean = firstString(item);
    if (clean) return clean;
  }
  return undefined;
}

function summarizeString(value: unknown): string | undefined {
  const clean = firstString(value);
  return clean ? truncate(clean) : undefined;
}

function summarizeSearch(pattern: unknown, scope: unknown): string | undefined {
  const safePattern = summarizeString(pattern);
  const safeScope = summarizeString(scope);
  if (safePattern && safeScope) return `${safePattern} in ${safeScope}`;
  return safePattern ?? (safeScope ? `in ${safeScope}` : undefined);
}

function summarizeUrl(value: unknown): string | undefined {
  const clean = firstString(value);
  return clean ? truncate(sanitizeUrlText(clean)) : undefined;
}

function summarizeToolTarget(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;

  switch (toolName.toLowerCase()) {
    case "bash":
      return summarizeString(record.command ?? record.cmd);
    case "read":
    case "write":
    case "edit":
      return summarizeString(record.path ?? record.file_path ?? record.filePath);
    case "ls":
      return summarizeString(record.path) ?? ".";
    case "grep":
    case "rg":
      return summarizeSearch(record.pattern ?? record.query ?? record.regex, record.path ?? record.glob);
    case "find":
      return summarizeSearch(record.pattern ?? record.query ?? record.name, record.path);
    case "search":
    case "web_search":
      return summarizeString(record.query ?? record.queries);
    case "fetch_content":
      return summarizeUrl(record.url ?? record.urls);
  }

  for (const field of SAFE_FALLBACK_FIELDS) {
    const summary = field === "url" ? summarizeUrl(record[field]) : summarizeString(record[field]);
    if (summary) return summary;
  }
  return undefined;
}

export function toolDisplayText(toolName: string, args: unknown): string {
  const safeToolName = truncate(toolName, 80);
  const detail = summarizeToolTarget(toolName, args);
  return truncate(detail ? `${safeToolName}: ${detail}` : safeToolName);
}

export function toolProgressText(toolName: string, args: unknown): string {
  return truncate(`Running ${toolDisplayText(toolName, args)}`);
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function toolCompletionText(display: string, elapsedMs: number): string {
  const suffix = ` after ${formatElapsed(elapsedMs)}.`;
  const prefix = "Finished ";
  const maxDisplayChars = MAX_PROGRESS_CHARS - prefix.length - suffix.length;
  const safeDisplay = truncate(display, Math.max(1, maxDisplayChars));
  return truncate(`${prefix}${safeDisplay}${suffix}`);
}
