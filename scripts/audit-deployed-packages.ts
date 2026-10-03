#!/usr/bin/env node
/**
 * Audit dependency vulnerabilities for published packages only.
 * Only production dependencies (`dependencies` / `optionalDependencies`) are audited —
 * devDependencies (build/test tooling) are never shipped to consumers. Website and
 * examples are ignored as well.
 *
 * Usage: jiti scripts/audit-deployed-packages.ts
 */

import { execSync } from 'node:child_process';
import { SCOPE_TO_PATH } from './changelog-config.ts';

const AUDIT_LEVEL = 'high' as const;
const SEVERITY_RANK: Record<string, number> = {
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

const DEPLOYED_PREFIXES = Object.values(SCOPE_TO_PATH).map((path) => path.replace(/\/$/, ''));

type AuditAdvisory = {
  severity: string;
  title: string;
  findings?: Array<{ paths?: string[] }>;
};

type AuditReport = {
  advisories?: Record<string, AuditAdvisory>;
};

function pathTouchesDeployedPackage(path: string): boolean {
  for (const prefix of DEPLOYED_PREFIXES) {
    if (path.startsWith(`${prefix} `) || path.startsWith(`${prefix}>`)) {
      return true;
    }

    const compactPrefix = prefix.replace(/\//g, '__');
    if (path.startsWith(`${compactPrefix}>`) || path === compactPrefix) {
      return true;
    }
  }

  return false;
}

const AUDIT_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One `pnpm audit` call; returns `null` when no usable report came back (registry/network issue). */
function tryAudit(): AuditReport | null {
  let output = '';

  try {
    output = execSync('pnpm audit --prod --json --ignore-registry-errors 2>/dev/null', {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (error) {
    // pnpm exits non-zero when advisories exist; the report is still on stdout.
    const execError = error as { stdout?: string };
    output = execError.stdout ?? '';
  }

  if (!output.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  // An error payload (e.g. registry 5xx) has no advisories key and must not count as "clean".
  if (!parsed || typeof parsed !== 'object' || !('advisories' in parsed)) return null;
  return parsed as AuditReport;
}

/**
 * Retries transient registry failures so CI is only blocked by real findings. If no report can
 * be obtained at all, exit 2 — an unverified audit must not pass silently.
 */
function runAudit(): AuditReport {
  for (let attempt = 1; attempt <= AUDIT_ATTEMPTS; attempt++) {
    const report = tryAudit();
    if (report) return report;
    if (attempt < AUDIT_ATTEMPTS) {
      console.warn(
        `pnpm audit returned no report (attempt ${attempt}/${AUDIT_ATTEMPTS}); retrying in ${(RETRY_DELAY_MS * attempt) / 1000}s…`,
      );
      sleep(RETRY_DELAY_MS * attempt);
    }
  }
  console.error(
    `pnpm audit did not return a report after ${AUDIT_ATTEMPTS} attempts (registry unavailable?). Re-run the job.`,
  );
  process.exit(2);
}

function main(): void {
  const minSeverity = SEVERITY_RANK[AUDIT_LEVEL];
  const report = runAudit();
  const findings: Array<{ severity: string; title: string; path: string }> = [];

  for (const advisory of Object.values(report.advisories ?? {})) {
    if ((SEVERITY_RANK[advisory.severity] ?? 0) < minSeverity) {
      continue;
    }

    for (const finding of advisory.findings ?? []) {
      for (const path of finding.paths ?? []) {
        if (pathTouchesDeployedPackage(path)) {
          findings.push({
            severity: advisory.severity,
            title: advisory.title,
            path,
          });
        }
      }
    }
  }

  if (findings.length === 0) {
    console.log(
      `No ${AUDIT_LEVEL} or critical vulnerabilities in production dependencies of deployed packages (${DEPLOYED_PREFIXES.join(', ')}).`,
    );
    process.exit(0);
  }

  console.error(
    `Found ${findings.length} ${AUDIT_LEVEL}+ vulnerabilit${findings.length === 1 ? 'y' : 'ies'} in production dependencies of deployed packages:\n`,
  );

  for (const finding of findings) {
    console.error(`[${finding.severity}] ${finding.title}`);
    console.error(`  ${finding.path}\n`);
  }

  process.exit(1);
}

main();
