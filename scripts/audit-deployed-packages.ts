#!/usr/bin/env node
/**
 * Audit dependency vulnerabilities for published packages only.
 * Ignores website, examples, and root devDependencies that are not shipped.
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

function runAudit(): AuditReport {
  let output = '';

  try {
    output = execSync('pnpm audit --json --ignore-registry-errors 2>/dev/null', {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (error) {
    const execError = error as { stdout?: string };
    output = execError.stdout ?? '';
  }

  if (!output.trim()) {
    console.error('pnpm audit did not return a report');
    process.exit(2);
  }

  return JSON.parse(output) as AuditReport;
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
      `No ${AUDIT_LEVEL} or critical vulnerabilities in deployed packages (${DEPLOYED_PREFIXES.join(', ')}).`,
    );
    process.exit(0);
  }

  console.error(
    `Found ${findings.length} ${AUDIT_LEVEL}+ vulnerabilit${findings.length === 1 ? 'y' : 'ies'} in deployed packages:\n`,
  );

  for (const finding of findings) {
    console.error(`[${finding.severity}] ${finding.title}`);
    console.error(`  ${finding.path}\n`);
  }

  process.exit(1);
}

main();
