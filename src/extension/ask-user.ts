import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AskAnswer, AskQuestion } from '../types/index.ts';

/** Render a structured question through Pi's single/multi-select UI. */
export async function askQuestion(
  ctx: ExtensionContext,
  question: AskQuestion,
): Promise<AskAnswer | undefined> {
  const selected: string[] = [];
  let customText: string | null = null;
  const optionLabel = (option: AskQuestion['options'][number]) =>
    `${option.label}${option.recommended ? ' (recommended)' : ''} — ${option.description}`;
  const byDisplay = new Map(question.options.map((option) => [optionLabel(option), option.label]));
  const customLabel = 'Type a custom answer…';
  const doneLabel = 'Done selecting';

  if (!question.multiSelect) {
    const choice = await ctx.ui.select(
      `${question.header}: ${question.question}`,
      [...byDisplay.keys(), customLabel],
    );
    if (choice === undefined) return undefined;
    const label = byDisplay.get(choice);
    if (label !== undefined) selected.push(label);
    else {
      const text = await ctx.ui.input(question.question, 'Type your answer');
      if (text === undefined) return undefined;
      customText = text;
    }
    return { id: question.id, selected, customText };
  }

  while (true) {
    const choice = await ctx.ui.select(
      `${question.header}: ${question.question}\nSelected: ${selected.join(', ') || 'none'}`,
      [...byDisplay.keys(), customLabel, doneLabel],
    );
    if (choice === undefined) return undefined;
    if (choice === doneLabel) break;
    const label = byDisplay.get(choice);
    if (label !== undefined) {
      const index = selected.indexOf(label);
      if (index >= 0) selected.splice(index, 1);
      else selected.push(label);
      continue;
    }
    const text = await ctx.ui.input(question.question, 'Type your answer');
    if (text === undefined) return undefined;
    if (text.trim()) customText = customText ? `${customText}\n${text.trim()}` : text.trim();
  }
  return { id: question.id, selected, customText };
}
