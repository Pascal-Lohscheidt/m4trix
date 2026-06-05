#!/usr/bin/env node
/**
 * Generate Mintlify changelog pages from conventional commits.
 *
 * Commits are routed to Agents, Evals, or Tracing docs by commit scope
 * (or by changed package paths when scope is missing).
 *
 * Usage:
 *   jiti scripts/generate-changelogs.ts           # write files only
 *   jiti scripts/generate-changelogs.ts --commit      # write + git commit [skip ci]
 *   jiti scripts/generate-changelogs.ts --fetch-tags  # fetch remote tags before resolving versions
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANGELOG_TYPES,
  type ChangelogSection,
  GITHUB_REPO,
  SCOPE_TO_PATH,
  SCOPE_TO_SECTION,
  SCOPE_TO_TAG_PREFIX,
  SECTION_CONFIG,
  SECTION_SCOPES,
  TYPE_LABELS,
  TYPE_TAGS,
} from './changelog-config.ts';

const ROOT = join(fileURLToPath(import.meta.url), '../..');

const SKIP_COMMIT_PATTERNS = [/^docs\(changelog\):/i, /^docs: update changelogs/i, /\[skip ci\]/i];

const GENERATED_MARKER = '{/* changelog:generated */}';

interface ParsedCommit {
  hash: string;
  date: Date;
  subject: string;
  body: string;
  type: string;
  scopes: string[];
  description: string;
  breaking: boolean;
}

interface ChangelogEntry {
  commit: ParsedCommit;
  scopeLabel: string | null;
}

interface ReleaseTag {
  scope: string;
  version: string;
  commit: string;
}

const tagCache = new Map<string, ReleaseTag[]>();

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', cwd: ROOT }).trim();
}

function loadReleaseTags(scope: string): ReleaseTag[] {
  const cached = tagCache.get(scope);
  if (cached) return cached;

  const prefix = SCOPE_TO_TAG_PREFIX[scope];
  if (!prefix) return [];

  const names = run(`git tag -l '${prefix}*' --sort=version:refname`).split('\n').filter(Boolean);

  const tags: ReleaseTag[] = names.map((name) => ({
    scope,
    version: name.slice(prefix.length),
    commit: run(`git rev-parse ${name}^{commit}`),
  }));

  tagCache.set(scope, tags);
  return tags;
}

function commitIncludedInRelease(commitHash: string, tag: ReleaseTag): boolean {
  try {
    execSync(`git merge-base --is-ancestor ${commitHash} ${tag.commit}`, {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** First release tag that includes this commit (version when the change shipped). */
function resolvePublishedVersion(scope: string, commitHash: string): string | null {
  const tags = loadReleaseTags(scope);
  const matching = tags.filter((tag) => commitIncludedInRelease(commitHash, tag));
  if (matching.length === 0) return null;
  return matching[0].version;
}

function latestPublishedVersion(scope: string): string | null {
  const tags = loadReleaseTags(scope);
  if (tags.length === 0) return null;
  return tags[tags.length - 1].version;
}

function scopesForDayEntries(section: ChangelogSection, dayEntries: ChangelogEntry[]): string[] {
  const fromLabels = new Set<string>();
  for (const entry of dayEntries) {
    if (!entry.scopeLabel) continue;
    for (const part of entry.scopeLabel.split(',').map((s) => s.trim())) {
      const normalized = part === 'traceer' ? 'trace-viewer' : part;
      if (SECTION_SCOPES[section].includes(normalized)) {
        fromLabels.add(normalized);
      }
    }
  }
  return fromLabels.size > 0 ? [...fromLabels] : SECTION_SCOPES[section];
}

function entryTouchesScope(entry: ChangelogEntry, scope: string): boolean {
  if (!entry.scopeLabel) return false;
  return entry.scopeLabel
    .split(',')
    .map((s) => (s.trim() === 'traceer' ? 'trace-viewer' : s.trim()))
    .includes(scope);
}

function newestCommitForScope(dayEntries: ChangelogEntry[], scope: string): string {
  const scoped = dayEntries.filter((e) => entryTouchesScope(e, scope));
  const pool = scoped.length > 0 ? scoped : dayEntries;
  return [...pool].sort((a, b) => b.commit.date.getTime() - a.commit.date.getTime())[0].commit.hash;
}

function escapeMdx(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\{/g, '\\{')
    .replace(/</g, '&lt;');
}

function parseConventionalCommit(
  hash: string,
  isoDate: string,
  subject: string,
  body: string,
): ParsedCommit | null {
  const firstLine = subject.trim();
  const breaking = /BREAKING CHANGE:/i.test(body) || /^[a-z]+(\([^)]+\))?!:/i.test(firstLine);

  const match = firstLine.match(/^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/i);
  if (!match) return null;

  const type = match[1].toLowerCase();
  if (!CHANGELOG_TYPES.has(type)) return null;

  const scopePart = match[2]?.trim() ?? '';
  const scopes = scopePart
    ? scopePart
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [];

  return {
    hash,
    date: new Date(isoDate),
    subject: firstLine,
    body,
    type,
    scopes,
    description: match[3].trim(),
    breaking,
  };
}

function getChangedPaths(hash: string): string[] {
  const out = run(`git diff-tree --no-commit-id --name-only -r ${hash}`);
  return out ? out.split('\n').filter(Boolean) : [];
}

function resolveSections(commit: ParsedCommit, changedPaths: string[]): Set<ChangelogSection> {
  const sections = new Set<ChangelogSection>();

  for (const scope of commit.scopes) {
    if (scope === '*') {
      for (const section of Object.keys(SECTION_CONFIG) as ChangelogSection[]) {
        sections.add(section);
      }
      continue;
    }
    const mapped = SCOPE_TO_SECTION[scope];
    if (mapped) sections.add(mapped);
  }

  if (sections.size === 0) {
    for (const [scope, section] of Object.entries(SCOPE_TO_SECTION)) {
      const prefix = SCOPE_TO_PATH[scope];
      if (prefix && changedPaths.some((p) => p.startsWith(prefix))) {
        sections.add(section);
      }
    }
  }

  if (sections.size === 0) {
    for (const [section, config] of Object.entries(SECTION_CONFIG) as [
      ChangelogSection,
      (typeof SECTION_CONFIG)[ChangelogSection],
    ][]) {
      if (config.pathPrefixes.some((prefix) => changedPaths.some((p) => p.startsWith(prefix)))) {
        sections.add(section);
      }
    }
  }

  return sections;
}

function scopeLabelForSection(commit: ParsedCommit, section: ChangelogSection): string | null {
  const relevant = commit.scopes
    .map((s) => (s === 'traceer' ? 'trace-viewer' : s))
    .filter((s) => s !== '*' && SCOPE_TO_SECTION[s] === section);

  if (relevant.length > 0) return relevant.join(', ');
  return null;
}

function shouldSkipCommit(subject: string): boolean {
  return SKIP_COMMIT_PATTERNS.some((re) => re.test(subject));
}

const FIELD_SEP = '\x1e';

function loadCommits(): ParsedCommit[] {
  const raw = run(`git log --format=%H%x1e%ai%x1e%s%x1e%B%x1e----COMMIT----`);
  const commits: ParsedCommit[] = [];

  for (const block of raw.split('----COMMIT----')) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(FIELD_SEP);
    if (parts.length < 4) continue;

    const [hash, isoDate, subject, ...bodyParts] = parts;
    const body = bodyParts.join(FIELD_SEP).replaceAll(FIELD_SEP, '').trim();

    if (shouldSkipCommit(subject)) continue;

    const parsed = parseConventionalCommit(hash, isoDate, subject, body);
    if (parsed) commits.push(parsed);
  }

  return commits;
}

function formatDateLabel(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function versionDescription(section: ChangelogSection, dayEntries: ChangelogEntry[]): string {
  const scopes = scopesForDayEntries(section, dayEntries);
  const published: string[] = [];
  const unreleasedScopes: string[] = [];

  for (const scope of scopes) {
    const commitHash = newestCommitForScope(dayEntries, scope);
    const version = resolvePublishedVersion(scope, commitHash);
    if (version) {
      published.push(scopes.length === 1 ? `v${version}` : `${scope} v${version}`);
    } else {
      unreleasedScopes.push(scope);
    }
  }

  if (published.length > 0 && unreleasedScopes.length === 0) {
    return published.join(' · ');
  }

  if (published.length > 0 && unreleasedScopes.length > 0) {
    const latest = unreleasedScopes
      .map((s) => {
        const v = latestPublishedVersion(s);
        return v ? `${s} v${v}` : s;
      })
      .join(', ');
    return `${published.join(' · ')} · unreleased (${latest})`;
  }

  const latestParts = scopes
    .map((s) => {
      const v = latestPublishedVersion(s);
      return v ? `${s} v${v}` : null;
    })
    .filter(Boolean);

  if (latestParts.length > 0) {
    return `Unreleased · latest ${latestParts.join(', ')}`;
  }

  return `${dayEntries.length} change${dayEntries.length === 1 ? '' : 's'}`;
}

function renderCommitLine(entry: ChangelogEntry): string {
  const { commit, scopeLabel } = entry;
  const desc = escapeMdx(commit.description);
  const link = `https://github.com/${GITHUB_REPO}/commit/${commit.hash}`;
  const scopeSuffix = scopeLabel ? ` (\`${scopeLabel}\`)` : '';
  const breaking = commit.breaking ? ' **BREAKING**' : '';
  const shortHash = commit.hash.slice(0, 7);
  const details = renderCommitBody(commit);

  return `- ${desc}${scopeSuffix}${breaking} ([${shortHash}](${link}))${details}`;
}

function renderCommitBody(commit: ParsedCommit): string {
  const lines = commit.body.split('\n');
  if (lines[0]?.trim() === commit.subject) {
    lines.shift();
  }

  while (lines[0]?.trim() === '') lines.shift();
  while (lines.at(-1)?.trim() === '') lines.pop();

  if (lines.length === 0) return '';

  const rendered = lines.map((line) => `  ${escapeMdx(line)}`).join('\n');
  return `\n\n${rendered}`;
}

function groupByDate(entries: ChangelogEntry[]): Map<string, ChangelogEntry[]> {
  const map = new Map<string, ChangelogEntry[]>();

  for (const entry of entries) {
    const key = entry.commit.date.toISOString().slice(0, 10);
    const list = map.get(key) ?? [];
    list.push(entry);
    map.set(key, list);
  }

  return map;
}

function renderSection(section: ChangelogSection, entries: ChangelogEntry[]): string {
  const config = SECTION_CONFIG[section];
  const byDate = groupByDate(entries);
  const sortedDates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));

  const updateBlocks: string[] = [];

  for (const dateKey of sortedDates) {
    const dayEntries = byDate.get(dateKey) ?? [];
    dayEntries.sort((a, b) => b.commit.date.getTime() - a.commit.date.getTime());

    const label = formatDateLabel(dayEntries[0].commit.date);
    const description = versionDescription(section, dayEntries);

    const tags = new Set<string>();
    const byType = new Map<string, ChangelogEntry[]>();
    const breaking: ChangelogEntry[] = [];

    for (const entry of dayEntries) {
      if (entry.commit.breaking) breaking.push(entry);
      const tag = TYPE_TAGS[entry.commit.type];
      if (tag) tags.add(tag);
      const list = byType.get(entry.commit.type) ?? [];
      list.push(entry);
      byType.set(entry.commit.type, list);
    }

    const tagList = [...tags].sort();
    const tagsAttr = tagList.length > 0 ? ` tags={${JSON.stringify(tagList)}}` : '';

    const rssTitle = `${label} — ${config.npmPackage} updates`;
    const rssDesc = dayEntries
      .slice(0, 3)
      .map((e) => e.commit.description)
      .join('; ');

    const sections: string[] = [];

    if (breaking.length > 0) {
      sections.push(`### Breaking changes\n\n${breaking.map(renderCommitLine).join('\n')}`);
    }

    const typeOrder = ['feat', 'fix', 'perf', 'refactor'] as const;
    for (const type of typeOrder) {
      const typed = byType.get(type);
      if (!typed?.length) continue;
      sections.push(`### ${TYPE_LABELS[type]}\n\n${typed.map(renderCommitLine).join('\n')}`);
    }

    updateBlocks.push(
      `<Update label="${label}" description="${description}"${tagsAttr} rss={{ title: "${escapeMdx(rssTitle)}", description: "${escapeMdx(rssDesc)}" }}>\n\n${sections.join('\n\n')}\n\n</Update>`,
    );
  }

  const generatedAt = new Date().toISOString().slice(0, 10);

  return `---
title: "${config.title}"
description: "${config.description}"
rss: true
---

${GENERATED_MARKER}

Product updates for **${config.npmPackage}**, generated from [conventional commits](https://www.conventionalcommits.org/) in the monorepo. Scopes in commit messages route entries to the Agents, Evals, or Tracing changelogs.

_Last regenerated ${generatedAt} (UTC)._

${updateBlocks.length > 0 ? updateBlocks.join('\n\n') : '_No changelog entries yet. Ship a `feat`, `fix`, `perf`, or `refactor` commit with a matching scope._'}
`;
}

function writeChangelogs(bySection: Map<ChangelogSection, ChangelogEntry[]>): boolean {
  let changed = false;

  for (const section of Object.keys(SECTION_CONFIG) as ChangelogSection[]) {
    const config = SECTION_CONFIG[section];
    const content = renderSection(section, bySection.get(section) ?? []);
    const outPath = join(ROOT, config.outputPath);

    let previous = '';
    try {
      previous = readFileSync(outPath, 'utf-8');
    } catch {
      // new file
    }

    if (previous !== content) {
      writeFileSync(outPath, content);
      changed = true;
      console.log(`Wrote ${config.outputPath}`);
    } else {
      console.log(`Unchanged ${config.outputPath}`);
    }
  }

  return changed;
}

function commitChangelogs(): void {
  const paths = Object.values(SECTION_CONFIG)
    .map((c) => c.outputPath)
    .join(' ');

  run(`git add ${paths}`);

  const status = run('git diff --cached --name-only');
  if (!status) {
    console.log('Nothing to commit.');
    return;
  }

  const message = `docs(changelog): update Mintlify changelogs [skip ci]`;
  run(`git commit -m "${message}"`);
  console.log(`Committed: ${message}`);
}

function main(): void {
  const shouldCommit = process.argv.includes('--commit');

  if (process.argv.includes('--fetch-tags')) {
    run('git fetch --tags --quiet');
  }

  const commits = loadCommits();
  const bySection = new Map<ChangelogSection, ChangelogEntry[]>();

  for (const section of Object.keys(SECTION_CONFIG) as ChangelogSection[]) {
    bySection.set(section, []);
  }

  for (const commit of commits) {
    const changedPaths = getChangedPaths(commit.hash);
    const sections = resolveSections(commit, changedPaths);

    for (const section of sections) {
      const list = bySection.get(section);
      if (!list) continue;
      if (list.some((e) => e.commit.hash === commit.hash)) continue;
      list.push({
        commit,
        scopeLabel: scopeLabelForSection(commit, section),
      });
    }
  }

  const changed = writeChangelogs(bySection);

  if (shouldCommit && changed) {
    commitChangelogs();
  } else if (shouldCommit && !changed) {
    console.log('No changelog changes; skipping commit.');
  }
}

main();
