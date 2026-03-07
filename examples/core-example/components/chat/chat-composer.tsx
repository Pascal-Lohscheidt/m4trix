type ChatComposerProps = {
  input: string;
  loading: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
};

export function ChatComposer({ input, loading, onInputChange, onSend }: ChatComposerProps) {
  return (
    <div className="border-t border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mx-auto flex max-w-2xl gap-3">
        <textarea
          className="min-h-[44px] max-h-32 flex-1 resize-none rounded-xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-zinc-900 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-400"
          rows={1}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="Type a message..."
          disabled={loading}
        />
        <button
          onClick={onSend}
          disabled={loading || !input.trim()}
          className="flex h-11 shrink-0 items-center justify-center rounded-xl bg-zinc-900 px-5 font-medium text-white transition-opacity hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {loading ? (
            <span className="text-sm">Sending...</span>
          ) : (
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 19l9 2-9-18-9 2 9 18z"
              />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
