import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import {
  ArrowsInLineVerticalIcon,
  ArrowsOutLineVerticalIcon,
  EyeIcon,
  EyeSlashIcon,
  PencilSimpleIcon,
  PlusIcon,
} from '@phosphor-icons/react';
import { type ReactNode, useCallback, useId, useMemo, useState } from 'react';
import type { DepthOperator, FilterCondition, FilterGroup } from '../lib/filter-groups';
import { createFilterGroupId, validateConditionsForSave } from '../lib/filter-groups';
import { cx } from '../lib/viewer';

type FilterGroupBarProps = {
  groups: FilterGroup[];
  onGroupsChange: (groups: FilterGroup[]) => void;
};

type DraftRow = {
  id: string;
  condition: FilterCondition;
};

const depthOperators: { value: DepthOperator; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
];

function emptyCondition(): FilterCondition {
  return { kind: 'spanType', value: '' };
}

function makeDraftRow(): DraftRow {
  return { id: createFilterGroupId(), condition: emptyCondition() };
}

function conditionsToDraftRows(conditions: FilterCondition[]): DraftRow[] {
  if (conditions.length === 0) return [makeDraftRow()];
  return conditions.map((condition) => ({ id: createFilterGroupId(), condition }));
}

type FilterGroupFormProps = {
  formInstanceId: string;
  initialName: string;
  initialConditions: FilterCondition[];
  submitLabel: string;
  onSubmit: (name: string, conditions: FilterCondition[]) => void;
  close: () => void;
};

function FilterGroupForm({
  formInstanceId,
  initialName,
  initialConditions,
  submitLabel,
  onSubmit,
  close,
}: FilterGroupFormProps): ReactNode {
  const nameFieldId = `${formInstanceId}-name`;
  const [draftName, setDraftName] = useState(initialName);
  const [draftRows, setDraftRows] = useState<DraftRow[]>(() => conditionsToDraftRows(initialConditions));
  const [formError, setFormError] = useState<string | null>(null);

  const conditionsFromRows = useMemo(() => draftRows.map((r) => r.condition), [draftRows]);

  const updateRowCondition = useCallback((rowId: string, next: FilterCondition) => {
    setDraftRows((prev) => prev.map((row) => (row.id === rowId ? { ...row, condition: next } : row)));
  }, []);

  const handleSave = () => {
    const name = draftName.trim();
    if (!name) {
      setFormError('Enter a group name.');
      return;
    }
    const err = validateConditionsForSave(conditionsFromRows);
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    onSubmit(name, conditionsFromRows);
    close();
  };

  const resetAndClose = () => {
    setDraftName(initialName);
    setDraftRows(conditionsToDraftRows(initialConditions));
    setFormError(null);
    close();
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <label
          htmlFor={nameFieldId}
          className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500"
        >
          Group name
        </label>
        <input
          id={nameFieldId}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          placeholder="e.g. Hide tools"
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-400"
        />
      </div>
      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Conditions (all must match)
        </div>
        <div className="max-h-48 space-y-2 overflow-y-auto">
          {draftRows.map((row) => {
            const cond = row.condition;
            return (
              <div
                key={row.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900/80 p-2 text-xs"
              >
                <select
                  value={cond.kind}
                  onChange={(e) => {
                    const kind = e.target.value as FilterCondition['kind'];
                    if (kind === 'regex') updateRowCondition(row.id, { kind: 'regex', pattern: '' });
                    else if (kind === 'spanType')
                      updateRowCondition(row.id, { kind: 'spanType', value: '' });
                    else updateRowCondition(row.id, { kind: 'depth', operator: 'eq', value: 0 });
                  }}
                  className="mb-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-200"
                >
                  <option value="regex">Regex (name or run id)</option>
                  <option value="spanType">Span type contains</option>
                  <option value="depth">Depth</option>
                </select>
                {cond.kind === 'regex' && (
                  <input
                    value={cond.pattern}
                    onChange={(e) =>
                      updateRowCondition(row.id, { kind: 'regex', pattern: e.target.value })
                    }
                    placeholder="Pattern (JS regex)"
                    className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-zinc-100"
                  />
                )}
                {cond.kind === 'spanType' && (
                  <input
                    value={cond.value}
                    onChange={(e) =>
                      updateRowCondition(row.id, { kind: 'spanType', value: e.target.value })
                    }
                    placeholder="e.g. tool, chain"
                    className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100"
                  />
                )}
                {cond.kind === 'depth' && (
                  <div className="flex gap-2">
                    <select
                      value={cond.operator}
                      onChange={(e) =>
                        updateRowCondition(row.id, {
                          kind: 'depth',
                          operator: e.target.value as DepthOperator,
                          value: cond.value,
                        })
                      }
                      className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-200"
                    >
                      {depthOperators.map((op) => (
                        <option key={op.value} value={op.value}>
                          {op.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      value={Number.isFinite(cond.value) ? String(cond.value) : '0'}
                      onChange={(e) => {
                        const v = Number.parseInt(e.target.value, 10);
                        updateRowCondition(row.id, {
                          kind: 'depth',
                          operator: cond.operator,
                          value: Number.isFinite(v) ? v : 0,
                        });
                      }}
                      className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100"
                    />
                  </div>
                )}
                {draftRows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setDraftRows((prev) => prev.filter((r) => r.id !== row.id))}
                    className="mt-2 text-red-400 hover:underline"
                  >
                    Remove condition
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setDraftRows((prev) => [...prev, makeDraftRow()])}
          className="mt-2 text-xs text-amber-400 hover:underline"
        >
          + Add condition
        </button>
      </div>
      {formError && <div className="text-[13px] text-red-400">{formError}</div>}
      <div className="flex justify-end gap-2 border-t border-zinc-800 pt-2">
        <button
          type="button"
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          onClick={resetAndClose}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          className="rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-1.5 text-sm font-medium text-amber-200 hover:bg-amber-500/25"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

export function FilterGroupBar({ groups, onGroupsChange }: FilterGroupBarProps): ReactNode {
  const addFormId = useId();

  const persist = useCallback(
    (next: FilterGroup[]) => {
      onGroupsChange(next);
    },
    [onGroupsChange],
  );

  const updateGroup = useCallback(
    (id: string, patch: Partial<FilterGroup>) => {
      persist(groups.map((g) => (g.id === id ? { ...g, ...patch } : g)));
    },
    [groups, persist],
  );

  const removeGroup = useCallback(
    (id: string) => {
      persist(groups.filter((g) => g.id !== id));
    },
    [groups, persist],
  );

  const handleCreateSubmit = useCallback(
    (name: string, conditions: FilterCondition[]) => {
      const next: FilterGroup = {
        id: createFilterGroupId(),
        name,
        conditions,
        hideEnabled: false,
        collapseEnabled: false,
      };
      persist([...groups, next]);
    },
    [groups, persist],
  );

  const handleEditSubmit = useCallback(
    (groupId: string, name: string, conditions: FilterCondition[]) => {
      persist(
        groups.map((g) =>
          g.id === groupId ? { ...g, name, conditions } : g,
        ),
      );
    },
    [groups, persist],
  );

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-zinc-800 pb-3">
      <Popover className="relative">
        <PopoverButton
          type="button"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-100"
          aria-label="Add filter group"
        >
          <PlusIcon aria-hidden="true" className="h-4 w-4" weight="bold" />
        </PopoverButton>
        <PopoverPanel
          anchor="bottom start"
          transition
          className="z-50 mt-1 w-[min(100vw-2rem,22rem)] rounded-xl border border-zinc-800 bg-zinc-950 p-3 shadow-xl [--anchor-gap:6px] data-closed:scale-95 data-closed:opacity-0 data-enter:duration-150 data-enter:ease-out data-leave:duration-100 data-leave:ease-in"
        >
          {({ close }) => (
            <FilterGroupForm
              key="create"
              formInstanceId={addFormId}
              initialName=""
              initialConditions={[]}
              submitLabel="Save group"
              close={close}
              onSubmit={(name, conditions) => handleCreateSubmit(name, conditions)}
            />
          )}
        </PopoverPanel>
      </Popover>

      {groups.map((group) => (
        <div
          key={group.id}
          className="flex max-w-full items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900/90 py-0.5 pl-2.5 pr-1 text-xs text-zinc-200"
        >
          <span className="max-w-[10rem] truncate font-medium" title={group.name}>
            {group.name}
          </span>
          <Popover className="relative inline-flex">
            <PopoverButton
              type="button"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              aria-label={`Edit filter group ${group.name}`}
            >
              <PencilSimpleIcon aria-hidden="true" className="h-4 w-4" weight="bold" />
            </PopoverButton>
            <PopoverPanel
              anchor="bottom start"
              transition
              className="z-50 mt-1 w-[min(100vw-2rem,22rem)] rounded-xl border border-zinc-800 bg-zinc-950 p-3 shadow-xl [--anchor-gap:6px] data-closed:scale-95 data-closed:opacity-0 data-enter:duration-150 data-enter:ease-out data-leave:duration-100 data-leave:ease-in"
            >
              {({ close }) => (
                <FilterGroupForm
                  key={group.id}
                  formInstanceId={`edit-${group.id}`}
                  initialName={group.name}
                  initialConditions={group.conditions}
                  submitLabel="Update group"
                  close={close}
                  onSubmit={(name, conditions) => handleEditSubmit(group.id, name, conditions)}
                />
              )}
            </PopoverPanel>
          </Popover>
          <button
            type="button"
            aria-label={group.hideEnabled ? 'Show matching spans' : 'Hide matching spans'}
            aria-pressed={group.hideEnabled}
            onClick={() => updateGroup(group.id, { hideEnabled: !group.hideEnabled })}
            className={cx(
              'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100',
              group.hideEnabled && 'text-amber-300',
            )}
          >
            {group.hideEnabled ? (
              <EyeSlashIcon aria-hidden="true" className="h-4 w-4" weight="bold" />
            ) : (
              <EyeIcon aria-hidden="true" className="h-4 w-4" weight="bold" />
            )}
          </button>
          <button
            type="button"
            aria-label={
              group.collapseEnabled ? 'Stop collapsing matching spans' : 'Collapse matching spans'
            }
            aria-pressed={group.collapseEnabled}
            onClick={() => updateGroup(group.id, { collapseEnabled: !group.collapseEnabled })}
            className={cx(
              'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100',
              group.collapseEnabled && 'text-violet-300',
            )}
          >
            {group.collapseEnabled ? (
              <ArrowsInLineVerticalIcon aria-hidden="true" className="h-4 w-4" weight="bold" />
            ) : (
              <ArrowsOutLineVerticalIcon aria-hidden="true" className="h-4 w-4" weight="bold" />
            )}
          </button>
          <button
            type="button"
            aria-label={`Remove group ${group.name}`}
            onClick={() => removeGroup(group.id)}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
