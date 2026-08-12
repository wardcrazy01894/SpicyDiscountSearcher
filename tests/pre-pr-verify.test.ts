/**
 * The pre-PR gate, exercised as a hook rather than read.
 *
 * `scripts/pre-pr-verify.sh` is a `PreToolUse` hook that refuses `gh pr create`
 * unless `npm run verify` passes. It had no tests, and the bug that cost the
 * most was one assertion away from being caught: an `ERR` trap fired on the
 * *expected* failing-verify path, printed its own JSON, and fell through to
 * print the real refusal too. Two JSON documents on stdout — which the hook
 * parser cannot parse, so it treats the output as plain text, finds no
 * decision, and **allows the command**. The gate failed open on precisely the
 * path it exists for.
 *
 * Hence `parseDecision` below: every case asserts stdout is *exactly one* valid
 * JSON document before looking at what it says.
 *
 * The suite never runs the real `npm run verify` — that takes minutes and would
 * make these tests a build. Instead each case points `cwd` at a throwaway tree
 * whose `package.json` is named `spicy-discount-searcher` and whose `verify`
 * script does whatever the case needs. That is exactly what the gate resolves
 * and runs, so the seam is the real one.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/pre-pr-verify.sh', import.meta.url));

const temps: string[] = [];

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

/** A throwaway checkout the gate will accept, with the `verify` we want. */
function fakeRepo(verify: string, name = 'spicy-discount-searcher'): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  temps.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, scripts: { verify } }));
  mkdirSync(join(dir, 'src'));
  return dir;
}

function run(payload: unknown, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/**
 * The decision, insisting stdout holds one JSON document and nothing else.
 *
 * `JSON.parse` is what makes this test worth having: it is the check the hook
 * parser itself performs, and the failure it catches is invisible to any
 * assertion that merely greps for `"deny"`.
 */
function parseDecision(stdout: string): string {
  if (stdout.trim() === '') return 'allow';
  const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
  return parsed.hookSpecificOutput?.permissionDecision ?? 'malformed';
}

const bash = (command: string, cwd: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd });

describe('the pre-PR gate', () => {
  it('emits exactly one JSON document when verify fails', () => {
    // The regression that made the gate fail open. Two documents parse as
    // neither, so the hook is ignored and the PR is created unverified.
    const repo = fakeRepo('echo BROKEN >&2; exit 1');
    const stdout = run(bash('gh pr create --title x', repo));
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(parseDecision(stdout)).toBe('deny');
  });

  it('allows the command when verify passes', () => {
    const repo = fakeRepo('exit 0');
    expect(parseDecision(run(bash('gh pr create --title x', repo)))).toBe('allow');
  });

  describe('matching', () => {
    // Every one of these was silently *missed* by a regex that anchored the
    // phrase to a command position — including the two-line push-then-create,
    // which is the shape the repo's own `pr` skill documents.
    const caught = [
      'gh pr create --title x',
      'gh pr create; echo done',
      '(gh pr create)',
      'git push\ngh pr create --title x',
      'FOO=1 gh pr create',
      'bash -c "gh pr create"',
      '{ gh pr create; }',
    ];

    for (const command of caught) {
      it(`catches ${JSON.stringify(command)}`, () => {
        const repo = fakeRepo('exit 1');
        expect(parseDecision(run(bash(command, repo)))).toBe('deny');
      });
    }

    it('ignores commands that have nothing to do with a PR', () => {
      const repo = fakeRepo('exit 1');
      for (const command of ['git status', 'ls -la', 'npm test']) {
        expect(parseDecision(run(bash(command, repo))), command).toBe('allow');
      }
    });
  });

  describe('which tree it verifies', () => {
    it('resolves the payload cwd, not the checkout the script lives in', () => {
      // The worktree bug: agents run in worktrees here, so verifying the
      // script's own tree means a clean `main` passes while the branch is
      // broken. The marker proves *which* verify ran.
      const repo = fakeRepo('echo MARKER-FROM-PAYLOAD-TREE; exit 1');
      const stdout = run(bash('gh pr create', repo));
      expect(stdout).toContain('MARKER-FROM-PAYLOAD-TREE');
    });

    it('walks up from a subdirectory', () => {
      // `<worktree>/src` is an ordinary cwd and holds no package.json. Testing
      // cwd alone fell back to the main checkout and reintroduced the bug.
      const repo = fakeRepo('echo MARKER-FROM-PAYLOAD-TREE; exit 1');
      const stdout = run(bash('gh pr create', join(repo, 'src')));
      expect(stdout).toContain('MARKER-FROM-PAYLOAD-TREE');
    });

    it('refuses to run npm scripts in a tree that is not this project', () => {
      // `repo_root` comes from the payload, so without the name check any
      // directory with a `verify` script satisfies the gate — and gets its
      // scripts executed.
      const repo = fakeRepo('echo PWNED; exit 0', 'some-other-project');
      const stdout = run(bash('gh pr create', repo));
      expect(stdout).not.toContain('PWNED');
      expect(parseDecision(stdout)).toBe('deny');
    });
  });

  describe('failing closed', () => {
    it('denies a payload it cannot parse', () => {
      // jq present, JSON malformed: `command` ends up empty, nothing matches,
      // and the original fail-open returns by a different door.
      expect(parseDecision(run('{"tool_input":{"command":,}} gh pr create'))).toBe('deny');
    });

    it('denies rather than guessing when no package.json is above cwd', () => {
      const stdout = run({ tool_input: { command: 'gh pr create' }, cwd: '/nonexistent/deep' });
      expect(parseDecision(stdout)).toBe('deny');
    });

    it('denies when jq is missing, and says so', () => {
      const repo = fakeRepo('exit 0');
      const stdout = run(bash('gh pr create', repo), { PATH: '/bin' });
      expect(parseDecision(stdout)).toBe('deny');
      expect(stdout).toContain('jq');
    });

    it('still allows ordinary commands when jq is missing', () => {
      // The collateral damage of guarding before matching: with the jq check
      // ahead of the filter, a machine without jq refused *every* Bash call and
      // the repo became unusable rather than merely un-PR-able.
      const repo = fakeRepo('exit 0');
      expect(parseDecision(run(bash('git status', repo), { PATH: '/bin' }))).toBe('allow');
    });
  });

  describe('diagnosis', () => {
    it('blames the network, not the diff, when the registry is unreachable', () => {
      // `npm audit` exits 1 for an unreachable registry exactly as it does for
      // a real advisory, and the undifferentiated message sent the reader
      // hunting a code defect that did not exist.
      const repo = fakeRepo('echo "npm error audit endpoint returned an error"; exit 1');
      const stdout = run(bash('gh pr create', repo));
      expect(parseDecision(stdout)).toBe('deny');
      expect(stdout).toContain('network');
    });

    it('does not cry network over a test that merely mentions one', () => {
      // The classifier reads the tail, because `verify` runs vitest and eslint
      // over this repo and a test *named* for a network error would otherwise
      // misreport a genuine code failure.
      const repo = fakeRepo(
        'echo "FAIL tests/network-error.test.ts > ECONNREFUSED handling"; ' +
          'for i in $(seq 20); do echo "  at some/stack/frame.ts:$i"; done; exit 1',
      );
      const stdout = run(bash('gh pr create', repo));
      expect(parseDecision(stdout)).toBe('deny');
      expect(stdout).not.toContain('looks like the network');
    });
  });
});
