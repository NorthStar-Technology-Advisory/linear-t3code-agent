import { z } from "zod";

export const Questions = z.array(z.object({
  id: z.string(), question: z.string(), multiSelect: z.boolean().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
})).min(1);
export type Question = z.infer<typeof Questions>[number];
export type Answers = Record<string, string | string[]>;
export type QuestionRequest = { questions?: Question[]; partialAnswers?: Answers; responseMode?: string; questionNumber?: number };
export function nextQuestion(request: QuestionRequest): Question | undefined {
  return request.questions?.find(q => !Object.hasOwn(request.partialAnswers ?? {}, q.id));
}
function optionLetter(index: number): string {
  let label = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
  return label;
}
export function questionText(request: QuestionRequest): string {
  const question = nextQuestion(request);
  if (!question) return "The agent needs clarification. Open the T3Code thread to inspect this request.";
  const number = (request.questionNumber ?? 1) + request.questions!.indexOf(question);
  const options = question.options?.map((option, i) => `**${optionLetter(i)}.** ${option.label}${option.description ? ` — ${option.description}` : ""}`).join("\n\n");
  const instruction = options ? question.multiSelect ? `Reply with choices such as ${number}A, ${number}B, or in your own words.` : `Reply with a choice such as ${number}A (or just A), or in your own words.` : "Reply here in your own words.";
  return `**Question ${number}**\n\n${question.question}${options ? `\n\n${options}` : ""}\n\n${instruction}`;
}
export function naturalAnswer(request: QuestionRequest, reply: string): string | string[] | undefined {
  const question = nextQuestion(request)!;
  const number = (request.questionNumber ?? 1) + request.questions!.indexOf(question);
  const choicePattern = /^(?:\d+)?[A-Za-z]{1,2}(?:\s*,\s*(?:\d+)?[A-Za-z]{1,2})*$/;
  if (!question.options?.length || !choicePattern.test(reply) || (!/\d|,/.test(reply) && reply.length > 1 && !question.options.some((_, i) => optionLetter(i) === reply.toUpperCase()))) return reply;
  const choices = reply.toUpperCase().split(",").map(part => /^(\d+)?([A-Z]+)$/.exec(part.trim())!);
  if (choices.some(choice => choice[1] && Number(choice[1]) !== number)) return undefined;
  const labels = choices.map(choice => question.options?.[[...choice[2]].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1]?.label);
  if (labels.some(label => label === undefined) || (!question.multiSelect && labels.length > 1)) return undefined;
  const selected = [...new Set(labels as string[])];
  return question.multiSelect && request.responseMode !== "message" ? selected : selected.join(", ");
}
