import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.env.HERMES_E2E_ROOT || 'C:\\HermesE2E';
const output = path.join(root, 'reports');
await mkdir(path.join(output, 'runs'), { recursive: true });
const catalog = JSON.parse(await readFile(new URL('../coverage-catalog.json', import.meta.url), 'utf8'));
const baseline = JSON.parse(await readFile(new URL('../baseline.json', import.meta.url), 'utf8'));
const observed = new Map();
function collect(suite, run) {
  for (const spec of suite.specs || []) {
    const id = spec.title.match(/^([A-Z]+(?:-[A-Z]+)?-\d{3})\b/)?.[1];
    if (!id) continue;
    const tests = spec.tests || [];
    const statuses = tests.flatMap(t => (t.results || []).map(r => r.status));
    if (statuses.length === 0) continue; // A collection-only run is not execution evidence.
    // No skipped/expected-failing/flaky workflow is reported as passing.
    const passed = tests.length > 0 && tests.every(t => t.expectedStatus === 'passed' && t.status === 'expected') && statuses.every(s => s === 'passed');
    observed.set(id, { status: passed ? 'passed' : statuses.every(s => s === 'skipped') ? 'skipped' : 'failed', run, title: spec.title, statuses });
  }
  for (const child of suite.suites || []) collect(child, run);
}
for (const run of (await readdir(path.join(output, 'runs'))).sort()) {
  const dir = path.join(output, 'runs', run);
  try {
    const provenance = JSON.parse(await readFile(path.join(dir, 'baseline.json'), 'utf8'));
    if (JSON.stringify(provenance) !== JSON.stringify(baseline)) continue;
    const result = JSON.parse(await readFile(path.join(dir, 'results.json'), 'utf8'));
    for (const suite of result.suites || []) collect(suite, run);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const rows = catalog.map(item => ({ ...item, ...observed.get(item.id), status: observed.get(item.id)?.status || 'not-run' }));
const counts = rows.reduce((all, row) => ({ ...all, [row.status]: (all[row.status] || 0) + 1 }), {});
const complete = rows.every(row => row.status === 'passed');
await writeFile(path.join(output, 'coverage.json'), JSON.stringify({ baseline, generatedAt: new Date().toISOString(), complete, counts, workflows: rows }, null, 2));
const lines = ['# Windows 全功能验收覆盖', '', `完整验收：${complete ? '通过' : '未完成'}。${JSON.stringify(counts)}。页面截图不计为功能通过。`, '',
  '| 用例 | 功能工作流 | 结果 | 最近证据 | 前置条件 |', '|---|---|---|---|---|',
  ...rows.map(row => `| ${row.id} | ${row.requirement} | ${row.status} | ${row.run ? `runs/${row.run}/playwright-report/index.html` : '尚无运行结果'} | ${row.prerequisite || '本机隔离环境'} |`)];
await writeFile(path.join(output, 'coverage.md'), lines.join('\n') + '\n');
console.log(JSON.stringify({ complete, counts, report: path.join(output, 'coverage.md') }));
if (process.argv.includes('--require-complete') && !complete) process.exitCode = 1;
