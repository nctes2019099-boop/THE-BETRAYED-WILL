// THE BETRAYED WILL — test harness
// Zero-dependency assertion framework. Node only; never shipped to the browser.
// Every suite reports a numeric score so `run.sh` output is machine-checkable
// (charter C-1: no score is reported unless the suite actually ran).

const COLOR = process.env.NO_COLOR ? null : {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const c = (name, s) => (COLOR ? COLOR[name](s) : s);

export class AssertionError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'AssertionError';
    this.detail = detail;
  }
}

class Suite {
  constructor(name) {
    this.name = name;
    this.cases = [];
    this.beforeEachFn = null;
    this.afterEachFn = null;
    this.beforeAllFn = null;
  }
  test(name, fn, opts = {}) {
    this.cases.push({ name, fn, skip: opts.skip === true, expectFail: opts.expectFail === true });
    return this;
  }
  beforeEach(fn) { this.beforeEachFn = fn; return this; }
  afterEach(fn) { this.afterEachFn = fn; return this; }
  beforeAll(fn) { this.beforeAllFn = fn; return this; }
}

const registry = [];
let current = null;

export function describe(name, body) {
  const suite = new Suite(name);
  registry.push(suite);
  const prev = current;
  current = suite;
  try { body(suite); } finally { current = prev; }
  return suite;
}

export function test(name, fn, opts) {
  if (!current) throw new Error('test() must be called inside describe()');
  current.test(name, fn, opts);
}

/* ------------------------------------------------------------- assertions */

function fmt(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : String(v);
  if (typeof v === 'string') return JSON.stringify(v.length > 90 ? `${v.slice(0, 90)}…` : v);
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.slice(0, 6).map(fmt).join(', ')}${v.length > 6 ? ', …' : ''}]`;
  if (typeof v === 'object') {
    if (v.x !== undefined && v.z !== undefined) {
      return `(${fmt(v.x)}, ${fmt(v.y ?? 0)}, ${fmt(v.z)})`;
    }
    try {
      const s = JSON.stringify(v);
      return s && s.length > 110 ? `${s.slice(0, 110)}…` : s;
    } catch { return Object.prototype.toString.call(v); }
  }
  return String(v);
}

export const assert = {
  ok(value, message = 'expected truthy') {
    if (!value) throw new AssertionError(message, { value });
  },
  notOk(value, message = 'expected falsy') {
    if (value) throw new AssertionError(message, { value });
  },
  equal(actual, expected, message) {
    if (actual !== expected) {
      throw new AssertionError(message ?? `expected ${fmt(expected)}, got ${fmt(actual)}`,
        { actual, expected });
    }
  },
  notEqual(actual, unexpected, message) {
    if (actual === unexpected) {
      throw new AssertionError(message ?? `expected value other than ${fmt(unexpected)}`, { actual });
    }
  },
  deepEqual(actual, expected, message) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new AssertionError(message ?? `expected ${b}, got ${a}`, { actual, expected });
  },
  close(actual, expected, tolerance = 1e-6, message) {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
      throw new AssertionError(
        message ?? `expected ${fmt(expected)} ±${tolerance}, got ${fmt(actual)}`,
        { actual, expected, tolerance },
      );
    }
  },
  gt(actual, bound, message) {
    if (!(actual > bound)) throw new AssertionError(message ?? `expected ${fmt(actual)} > ${fmt(bound)}`, { actual, bound });
  },
  gte(actual, bound, message) {
    if (!(actual >= bound)) throw new AssertionError(message ?? `expected ${fmt(actual)} >= ${fmt(bound)}`, { actual, bound });
  },
  lt(actual, bound, message) {
    if (!(actual < bound)) throw new AssertionError(message ?? `expected ${fmt(actual)} < ${fmt(bound)}`, { actual, bound });
  },
  lte(actual, bound, message) {
    if (!(actual <= bound)) throw new AssertionError(message ?? `expected ${fmt(actual)} <= ${fmt(bound)}`, { actual, bound });
  },
  within(actual, lo, hi, message) {
    if (!(actual >= lo && actual <= hi)) {
      throw new AssertionError(message ?? `expected ${fmt(actual)} within [${fmt(lo)}, ${fmt(hi)}]`, { actual, lo, hi });
    }
  },
  finite(value, message = 'expected a finite number') {
    if (!Number.isFinite(value)) throw new AssertionError(message, { value });
  },
  includes(haystack, needle, message) {
    const has = typeof haystack?.includes === 'function'
      ? haystack.includes(needle)
      : Object.values(haystack ?? {}).includes(needle);
    if (!has) throw new AssertionError(message ?? `expected ${fmt(haystack)} to include ${fmt(needle)}`, { haystack, needle });
  },
  excludes(haystack, needle, message) {
    const has = typeof haystack?.includes === 'function' ? haystack.includes(needle) : false;
    if (has) throw new AssertionError(message ?? `expected ${fmt(haystack)} NOT to include ${fmt(needle)}`, { needle });
  },
  throws(fn, message = 'expected function to throw') {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) throw new AssertionError(message);
  },
  doesNotThrow(fn, message = 'expected function NOT to throw') {
    try { fn(); } catch (err) {
      throw new AssertionError(`${message}: ${err?.message ?? err}`, { error: String(err?.message ?? err) });
    }
  },
};

/* ------------------------------------------------------------------ runner */

/**
 * Run every registered suite.
 * @returns {{pass:number, fail:number, skip:number, total:number, score:string,
 *            failures:Array, durationMs:number}}
 */
export async function runAll(opts = {}) {
  const title = opts.title ?? 'THE BETRAYED WILL — test run';
  console.log(`\n${c('bold', c('cyan', title))}`);
  console.log(c('dim', '─'.repeat(68)));

  let pass = 0, fail = 0, skip = 0;
  const failures = [];
  const t0 = Date.now();

  for (const suite of registry) {
    console.log(`\n${c('bold', suite.name)}`);
    if (suite.beforeAllFn) {
      try { await suite.beforeAllFn(); } catch (err) {
        console.log(`  ${c('red', '✗')} beforeAll failed: ${err.message}`);
        failures.push({ suite: suite.name, test: 'beforeAll', error: err });
        fail++;
        continue;
      }
    }

    for (const testCase of suite.cases) {
      if (testCase.skip) {
        skip++;
        console.log(`  ${c('yellow', '○')} ${testCase.name} ${c('dim', '(skipped)')}`);
        continue;
      }
      const start = Date.now();
      let error = null;
      try {
        if (suite.beforeEachFn) await suite.beforeEachFn();
        await testCase.fn();
        if (suite.afterEachFn) await suite.afterEachFn();
      } catch (err) {
        error = err;
      }
      const ms = Date.now() - start;

      if (error) {
        if (testCase.expectFail) {
          pass++;
          console.log(`  ${c('yellow', '⚠')} ${testCase.name} ${c('dim', `(expected failure: ${error.message})`)}`);
        } else {
          fail++;
          failures.push({ suite: suite.name, test: testCase.name, error });
          console.log(`  ${c('red', '✗')} ${testCase.name}`);
          console.log(`      ${c('red', error.message)}`);
          if (opts.verbose && error.stack) {
            console.log(c('dim', error.stack.split('\n').slice(1, 4).map((l) => `      ${l}`).join('\n')));
          }
        }
      } else if (testCase.expectFail) {
        fail++;
        failures.push({ suite: suite.name, test: testCase.name, error: new Error('expected failure but passed') });
        console.log(`  ${c('red', '✗')} ${testCase.name} ${c('red', '(expected to fail but passed)')}`);
      } else {
        pass++;
        console.log(`  ${c('green', '✓')} ${testCase.name}${ms > 60 ? c('dim', ` ${c('yellow', `${ms}ms`)}`) : ''}`);
      }
    }
  }

  const total = pass + fail;
  const durationMs = Date.now() - t0;
  console.log(`\n${c('dim', '─'.repeat(68))}`);
  const score = `${pass}/${total}`;
  const line = `${c('bold', score)} passed`;
  if (fail) console.log(`${c('red', c('bold', 'FAIL'))}  ${line}, ${c('red', `${fail} failed`)}${skip ? `, ${skip} skipped` : ''}  ${c('dim', `(${durationMs}ms)`)}`);
  else console.log(`${c('green', c('bold', 'PASS'))}  ${line}${skip ? `, ${skip} skipped` : ''}  ${c('dim', `(${durationMs}ms)`)}`);

  if (fail && opts.printFailures !== false) {
    console.log(`\n${c('red', c('bold', 'Failures:'))}`);
    for (const f of failures) {
      console.log(`  ${c('dim', '•')} ${f.suite} → ${f.test}`);
      console.log(`    ${c('red', f.error?.message ?? String(f.error))}`);
      // fmt(), not JSON.stringify: it already catches the cycle and the BigInt and falls
      // back to a type name. Stringify throws here, in the reporter, after every test has
      // run - so one circular value in one failed assertion (an agent holds its squad,
      // which holds its agents) replaced the whole failure list and the RESULT line with
      // a stack trace, and run.sh read a missing RESULT as a crash rather than as the
      // failures it was about to be told about.
      if (f.error?.detail !== undefined) console.log(`    ${c('dim', fmt(f.error.detail))}`);
    }
  }

  // Machine-readable line so run.sh can aggregate without parsing colours.
  console.log(`\nRESULT ${pass}/${total} ${fail === 0 ? 'PASS' : 'FAIL'} ${durationMs}ms`);

  return { pass, fail, skip, total, score, failures, durationMs };
}

/** Exit with a non-zero code on failure so CI and run.sh gate correctly. */
export async function runAndExit(opts = {}) {
  const result = await runAll(opts);
  process.exitCode = result.fail === 0 ? 0 : 1;
  return result;
}

/** Performance measurement helper for the §24 gates. */
export function measure(fn, iterations = 1, warmup = 1) {
  for (let i = 0; i < warmup; i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6 / iterations;
}

/** Reset the registry — used when a runner imports several suites in one process. */
export function clearRegistry() { registry.length = 0; current = null; }

export { registry, c, fmt };
