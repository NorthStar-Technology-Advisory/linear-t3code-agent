const secrets = new Set<string>();
export function registerSecrets(...values: Array<string | undefined>) {
  for (const value of values) if (value) secrets.add(value);
}
export function redactKnownSecrets(text: string) {
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join("[redacted]");
  return text;
}
