import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages';

// Type for message filters
export type MessageFilter = (
  message: BaseMessage,
  tags?: Array<string>
) => boolean;
// Predefined filters
const humanAndAI: MessageFilter = (message) =>
  message instanceof HumanMessage || message instanceof AIMessage;
const humanOnly: MessageFilter = (message) => message instanceof HumanMessage;
const aiOnly: MessageFilter = (message) => message instanceof AIMessage;

const includingTags: MessageFilter = (message, tags) => {
  if (tags) {
    return tags.some((tag) =>
      Array.isArray(message.additional_kwargs?.tags)
        ? message.additional_kwargs?.tags.includes(tag)
        : false
    );
  }
  return true;
};

const excludingTags: MessageFilter = (message, tags) => {
  if (tags) {
    return !tags.some((tag) =>
      Array.isArray(message.additional_kwargs?.tags)
        ? message.additional_kwargs?.tags.includes(tag)
        : false
    );
  }
  return true;
};

export enum MessageFilterType {
  HumanAndAI = 'HumanAndAI',
  HumanOnly = 'HumanOnly',
  AIOnly = 'AIOnly',
  IncludingTags = 'IncludingTags',
  ExcludingTags = 'ExcludingTags',
}
export const typeOnFilter = {
  [MessageFilterType.HumanAndAI]: humanAndAI,
  [MessageFilterType.HumanOnly]: humanOnly,
  [MessageFilterType.AIOnly]: aiOnly,
  [MessageFilterType.IncludingTags]: includingTags,
  [MessageFilterType.ExcludingTags]: excludingTags,
};
