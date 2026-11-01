import { appendFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Writes the tail of every captured CI log to the job summary and lets the
 * workflow upload the full logs as an artifact.
 */

const TAIL_LINES = 80;

const tempDir = process.env.RUNNER_TEMP;
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
const jobName = process.env.GITHUB_JOB ?? 'job';

async function main() {
  if (!tempDir || !summaryPath) {
    console.log('RUNNER_TEMP or GITHUB_STEP_SUMMARY is not set; skipping summary.');
    return;
  }

  let entries = [];
  try {
    entries = await readdir(tempDir);
  } catch {
    entries = [];
  }

  const logs = entries.filter((name) => name.endsWith('.log')).sort();

  if (logs.length === 0) {
    await appendFile(summaryPath, `### ${jobName} failed\n\nNo captured log files were found.\n`);
    return;
  }

  const sections = [`### ${jobName} failed — last ${TAIL_LINES} lines of each captured log`, ''];

  for (const log of logs) {
    const content = await readFile(path.join(tempDir, log), 'utf8');
    const lines = content.split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    const tail = lines.slice(-TAIL_LINES).join('\n');
    sections.push(`#### ${log}`, '', '```', tail, '```', '');
  }

  await appendFile(summaryPath, `${sections.join('\n')}\n`);
}

await main();
