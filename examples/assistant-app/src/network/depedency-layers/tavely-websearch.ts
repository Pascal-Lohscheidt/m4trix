import { DepedencyLayer, S } from '@m4trix/core';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';

export type TavilySearchHit = {
  title: string;
  url: string;
  content: string;
  score?: number;
};

export type TavilyExtractedPage = {
  url: string;
  content: string;
};

export type TavilyExtractFailure = {
  url: string;
  error: string;
};

type TavilySearchRequest = {
  query: string;
  auto_parameters: boolean;
  topic: 'general' | 'news' | 'finance';
  search_depth: 'basic' | 'advanced';
  chunks_per_source: number;
  max_results: number;
  time_range: string | null;
  start_date: string | null;
  end_date: string | null;
  include_answer: boolean;
  include_raw_content: boolean;
  include_images: boolean;
  include_image_descriptions: boolean;
  include_favicon: boolean;
  include_domains: string[];
  exclude_domains: string[];
  country: string | null;
  include_usage: boolean;
};

type TavilySearchResult = {
  title: string;
  url: string;
  content?: string;
  score?: number;
};

type TavilySearchResponse = {
  results?: TavilySearchResult[];
};

type TavilyExtractRequest = {
  urls: string[];
  extract_depth: 'basic' | 'advanced';
  format: 'markdown' | 'text';
  query?: string;
  chunks_per_source?: number;
  include_images: boolean;
  include_usage: boolean;
};

type TavilyExtractResult = {
  url: string;
  raw_content?: string;
};

type TavilyExtractFailedResult = {
  url: string;
  error: string;
};

type TavilyExtractResponse = {
  results?: TavilyExtractResult[];
  failed_results?: TavilyExtractFailedResult[];
};

const defaultSearchBody: Omit<TavilySearchRequest, 'query'> = {
  auto_parameters: false,
  topic: 'general',
  search_depth: 'basic',
  chunks_per_source: 3,
  max_results: 5,
  time_range: null,
  start_date: null,
  end_date: null,
  include_answer: false,
  include_raw_content: false,
  include_images: false,
  include_image_descriptions: false,
  include_favicon: false,
  include_domains: [],
  exclude_domains: [],
  country: null,
  include_usage: false,
};

const defaultExtractBody: Omit<TavilyExtractRequest, 'urls'> = {
  extract_depth: 'basic',
  format: 'markdown',
  chunks_per_source: 3,
  include_images: false,
  include_usage: false,
};

function requireApiKey(apiKey: string): void {
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is required for WithTavelyWebsearchLayer');
  }
}

async function tavilyRequest<T>(apiKey: string, url: string, body: unknown): Promise<T> {
  requireApiKey(apiKey);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Tavily request failed (${response.status}): ${detail || response.statusText}`,
    );
  }

  return (await response.json()) as T;
}

type TavilyErrorResponse = {
  detail?: { error?: string };
};

async function tavilySearch(apiKey: string, query: string): Promise<TavilySearchHit[]> {
  const data = await tavilyRequest<TavilySearchResponse & TavilyErrorResponse>(
    apiKey,
    TAVILY_SEARCH_URL,
    {
      query,
      ...defaultSearchBody,
    },
  );

  const apiError = data.detail?.error;
  if (apiError) {
    throw new Error(`Tavily search error: ${apiError}`);
  }

  const results = data.results ?? [];

  return results.map(({ title, url, content, score }) => ({
    title,
    url,
    content: content ?? '',
    score,
  }));
}

async function tavilyExtract(
  apiKey: string,
  urls: readonly string[],
  options?: { query?: string },
): Promise<{ pages: TavilyExtractedPage[]; failed: TavilyExtractFailure[] }> {
  if (urls.length === 0) {
    return { pages: [], failed: [] };
  }

  const body: TavilyExtractRequest = {
    urls: [...urls],
    ...defaultExtractBody,
    ...(options?.query ? { query: options.query } : {}),
  };

  const data = await tavilyRequest<TavilyExtractResponse>(apiKey, TAVILY_EXTRACT_URL, body);

  const pages = (data.results ?? []).map(({ url, raw_content }) => ({
    url,
    content: raw_content ?? '',
  }));

  const failed = (data.failed_results ?? []).map(({ url, error }) => ({
    url,
    error,
  }));

  return { pages, failed };
}

export const WithTavelyWebsearchLayer = DepedencyLayer.of({
  name: 'WithTavelyWebsearchLayer',
  config: S.Struct({ apiKey: S.String }),
}).define<{
  search: (query: string) => Promise<TavilySearchHit[]>;
  extract: (
    urls: readonly string[],
    options?: { query?: string },
  ) => Promise<{ pages: TavilyExtractedPage[]; failed: TavilyExtractFailure[] }>;
}>();

function resolveTavilyApiKey(configApiKey: string): string {
  const apiKey = configApiKey || process.env.TAVILY_API_KEY || '';
  requireApiKey(apiKey);
  return apiKey;
}

export const withTavelyWebsearch = WithTavelyWebsearchLayer.make({
  config: { apiKey: process.env.TAVILY_API_KEY ?? '' },
  search: async (query) => {
    const apiKey = resolveTavilyApiKey(process.env.TAVILY_API_KEY ?? '');
    return tavilySearch(apiKey, query);
  },
  extract: async (urls, options) => {
    const apiKey = resolveTavilyApiKey(process.env.TAVILY_API_KEY ?? '');
    return tavilyExtract(apiKey, urls, options);
  },
});
