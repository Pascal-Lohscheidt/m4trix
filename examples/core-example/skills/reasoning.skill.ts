import { Skill, S } from '@m4trix/core';
import OpenAI from 'openai';
import { filter, from, lastValueFrom, map, reduce, tap } from 'rxjs';

const REACT_SYSTEM_PROMPT = `You are a ReAct (Reasoning + Acting) agent. Solve problems step by step.

For each step, output your reasoning in this format:
Thought: [your reasoning about the current situation and next step]

When you have enough information to conclude, output:
Final Answer: [your conclusive answer to the problem]

Always end with "Final Answer:" when you are done. Do not output anything after the final answer.`;

function extractFinalAnswer(fullResponse: string): string {
  const match = fullResponse.match(/Final Answer:\s*([\s\S]+?)(?:\n\n|$)/);
  if (match) {
    return match[1].trim();
  }
  // Fallback: use last non-empty paragraph
  const paragraphs = fullResponse.split(/\n\n+/).filter(Boolean);
  return paragraphs[paragraphs.length - 1]?.trim() ?? fullResponse.trim();
}

function buildMessages(
  problemToSolve: string,
): OpenAI.ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: REACT_SYSTEM_PROMPT },
    { role: 'user', content: `Problem to solve:\n\n${problemToSolve}` },
  ];
}

export const reasoningSkill = Skill.of()
  .input(S.Struct({ problemToSolve: S.String }))
  .chunk(S.String)
  .done(S.String)
  .define(async ({ input, emit }) => {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const messages = buildMessages(input.problemToSolve);

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o',
      stream: true,
      messages,
    });

    const fullResponse = await lastValueFrom(
      from(stream).pipe(
        map((chunk) => chunk.choices[0]?.delta?.content),
        filter((content): content is string => content != null),
        tap(emit),
        reduce((acc, chunk) => acc + chunk, ''),
      ),
    );

    return extractFinalAnswer(fullResponse);
  });
