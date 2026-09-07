class ConciseReporter {
  onBegin(_config, suite) {
    this.listOnly = process.argv.includes('--list');
    console.log(`${this.listOnly ? 'Collected' : 'Running'} ${suite.allTests().length} native Windows workflows`);
  }
  onTestEnd(test, result) {
    console.log(`${result.status.toUpperCase()} ${(result.duration / 1000).toFixed(1)}s ${test.title}`);
    for (const error of result.errors) {
      const clean = (error.message || '').replace(/\x1b\[[0-9;]*m/g, '');
      console.log(clean.split('\n').filter(Boolean).slice(0, 7).join('\n').slice(0, 700));
    }
  }
  onError(error) { console.log(String(error.message || error).slice(0, 700)); }
  onEnd(result) { if (!this.listOnly) console.log(`Run ${result.status}; full details are in results.json and the HTML report.`); }
}
module.exports = ConciseReporter;
