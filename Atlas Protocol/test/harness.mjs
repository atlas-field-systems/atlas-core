export function harness(p) {
  let checks = 0;
  const failures = [];
  const check = (name, run) => {
    checks++;
    try {
      run();
    } catch (error) {
      failures.push({ name, code: error.code ?? error.message });
    }
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const refuses = (run, code, issue) => {
    try {
      run();
    } catch (error) {
      assert(
        error instanceof p.ProtocolError && (code === undefined || error.code === code),
        `Expected ${code ?? 'ProtocolError'}, received ${error.code ?? error.message}`,
      );
      assert(
        error.issues.length <= 16 &&
          error.issues.every((issue) => issue.path.length <= 256 && issue.message.length <= 160),
        'Unbounded diagnostics',
      );
      if (issue)
        assert(
          JSON.stringify(error.issues) === JSON.stringify([issue]),
          `Wrong diagnostic ${JSON.stringify(error.issues)}`,
        );
      return;
    }
    throw new Error(`Accepted instead of ${code ?? 'ProtocolError'}`);
  };
  const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
  const result = (...reports) => {
    const total = checks + reports.reduce((sum, report) => sum + report.checks, 0);
    const allFailures = [...failures, ...reports.flatMap((report) => report.failures)];
    return { checks: total, passed: total - allFailures.length, failures: allFailures };
  };
  return { check, assert, refuses, encode, result };
}
