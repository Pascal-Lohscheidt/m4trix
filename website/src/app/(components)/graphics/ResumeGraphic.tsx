/** A stream that drops after the plan and resumes with Last-Event-ID (registerSSEStream resume). */
const ROWS: { label: string; value: React.ReactNode }[] = [
  {
    label: 'received',
    value: (
      <>
        <span className="text-(--accent)">plan</span>{' '}
        <span className="text-text-4">id: chat-7/9b2e…/a41f…</span>
      </>
    ),
  },
  { label: 'dropped', value: <span className="text-(--red)">connection lost</span> },
  {
    label: 'reconnect',
    value: <span className="text-text-1">Last-Event-ID: chat-7/9b2e…/a41f…</span>,
  },
  {
    label: 'replayed',
    value: <span className="text-(--accent)">finding · finding · finding</span>,
  },
  {
    label: 'live',
    value: (
      <>
        <span className="text-(--accent)">approval-requested</span>{' '}
        <span className="text-text-4">…</span>{' '}
        <span className="text-success">m4trix:run.completed</span>
      </>
    ),
  },
];

export default function ResumeGraphic() {
  return (
    <div className="mono-panel grid min-w-0 gap-x-6 sm:grid-cols-[auto_1fr]">
      {ROWS.map((row) => (
        <div key={row.label} className="contents">
          <span className="text-text-3">{row.label}</span>
          <span className="mb-1.5 truncate sm:mb-0">{row.value}</span>
        </div>
      ))}
    </div>
  );
}
