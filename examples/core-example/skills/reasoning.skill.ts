import { Skill, S } from '@m4trix/core';
import OpenAI from 'openai';
import { filter, from, lastValueFrom, map, reduce, tap } from 'rxjs';

const REACT_SYSTEM_PROMPT = `You are a reasoning agent. Think through problems step by step.

Structure your response as follows:
- Use "Thought:" for each reasoning step. Be thorough but concise.
- When you reach a conclusion, write "Final Answer:" followed by your answer on the same line or the next.
- Do not add anything after the Final Answer.

Example:
Thought: First I need to understand what is being asked...
Thought: The key factors are...
Final Answer: The answer is X.`;

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
      model: 'o4-mini',
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
