import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/**
 * Audit gate.
 *
 * - Production dependencies: any high or critical advisory fails the job
 *   (this is the gate the phase rules require).
 * - Dev-only dependencies: reported as warnings so they can be listed in
 *   docs/security-exceptions.md, and they do not fail the job.
 *
 * The gate is never lowered to make a run pass. Run locally with:
 *   pnpm audit:ci
 */

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

function runAudit(scope) {
  const args = ['audit', '--json'];
  if (scope === 'prod') args.push('--prod');
  if (scope === 'dev') args.push('--dev');

  try {
    return JSON.parse(execFileSync('pnpm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout ?? '') : '';
    if (stdout.trim() === '') {
      throw error;
    }
    return JSON.parse(stdout);
  }
}

/** Normalises both the legacy `advisories` shape and the npm-v2 `vulnerabilities` shape. */
function collect(report) {
  const found = [];

  if (report && typeof report === 'object' && report.advisories) {
    for (const advisory of Object.values(report.advisories)) {
      const findings = Array.isArray(advisory.findings) ? advisory.findings : [];
      found.push({
        package: advisory.module_name ?? 'unknown',
        severity: String(advisory.severity ?? 'unknown'),
        advisory: advisory.github_advisory_id ?? (advisory.url ?? '').split('/').pop() ?? 'unknown',
        title: advisory.title ?? '',
        range: advisory.vulnerable_versions ?? '?',
        patched: advisory.patched_versions ?? '?',
        paths: findings.flatMap((finding) => (Array.isArray(finding.paths) ? finding.paths : [])),
      });
    }
    return found;
  }

  const vulnerabilities = (report && report.vulnerabilities) ?? {};
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (!entry || typeof entry !== 'object') continue;
    const via = (Array.isArray(entry.via) ? entry.via : []).filter((item) => typeof item === 'object');
    found.push({
      package: name,
      severity: String(entry.severity ?? 'unknown'),
      advisory:
        via
          .map((item) => (item.url ?? '').split('/').pop())
          .filter(Boolean)
          .join(',') || 'transitive',
      title: via.map((item) => item.title).filter(Boolean).join('; ') || '(transitive)',
      range: entry.range ?? '?',
      patched: 'see advisory',
      paths: Array.isArray(entry.nodes) ? entry.nodes : [],
    });
  }
  return found;
}

function bySeverity(a, b) {
  return (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || a.package.localeCompare(b.package);
}

function format(prefix, advisory) {
  const path = advisory.paths.length > 0 ? advisory.paths.slice(0, 3).join(' | ') : 'path unknown';
  return `${prefix} ${advisory.severity.toUpperCase()} ${advisory.package} (${advisory.advisory}) range=${advisory.range} paths=${path}`;
}

const production = collect(runAudit('prod')).sort(bySeverity);
const development = collect(runAudit('dev')).sort(bySeverity);

const blocking = production.filter(
  (advisory) => advisory.severity === 'high' || advisory.severity === 'critical',
);

const lines = [];
lines.push(`Production advisories: ${production.length} (blocking high/critical: ${blocking.length})`);
for (const advisory of production) {
  lines.push(format(blocking.includes(advisory) ? 'FAIL' : 'WARN', advisory));
}
lines.push(`Development-only advisories: ${development.length} (warnings; listed in docs/security-exceptions.md)`);
for (const advisory of development) {
  lines.push(format('WARN', advisory));
}

const report = lines.join('\n');
console.log(report);

if (process.env.GITHUB_STEP_SUMMARY) {
  const heading = blocking.length === 0 ? '### Audit: no blocking production advisories' : '### Audit: blocking production advisories';
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${heading}\n\n\`\`\`\n${report}\n\`\`\`\n`);
}

if (blocking.length > 0) {
  process.exit(1);
}
