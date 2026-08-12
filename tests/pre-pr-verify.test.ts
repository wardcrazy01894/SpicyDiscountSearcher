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
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
 * Run it expecting the process itself to survive, and report exit code too.
 *
 * `run` uses `execFileSync`, which throws on a non-zero exit — and a non-zero
 * exit is precisely a fail-open, since the hook runner treats it as a
 * non-blocking error and lets the command through. So the cases below need to
 * see the code rather than have it thrown at them.
 */
function runRaw(payload: unknown, env: NodeJS.ProcessEnv = {}): { status: number; stdout: string } {
  const result = spawnSync('bash', [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout };
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

const bash = (command: string, cwd: string) => ({
  tool_name: 'Bash',
  tool_input: { command },
  cwd,
});

/**
 * A PATH holding everything the script needs *except* `jq`.
 *
 * `PATH=/bin` looked like it removed jq and only did so on macOS, where jq
 * lives in `/opt/homebrew/bin`. On Ubuntu — which is what CI runs — `/bin` is
 * a symlink to `/usr/bin` and jq is right there, so the gate sailed past the
 * check and denied for the *next* reason. The test passed locally, failed all
 * three CI Node jobs, and never exercised the branch it names on either.
 *
 * Symlinking the externals by name is the portable way: whatever is missing is
 * missing everywhere.
 */
function pathWithoutJq(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nojq-'));
  temps.push(dir);
  for (const tool of ['bash', 'cat', 'tr', 'dirname', 'tail', 'grep', 'npm', 'node', 'sh', 'env']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
    const target = found.stdout.trim();
    if (target) symlinkSync(target, join(dir, tool));
  }
  return dir;
}

describe('the pre-PR gate', () => {
  it('emits exactly one JSON document when verify fails', () => {
    // The regression that made the gate fail open. Two documents parse as
    // neither, so the hook is ignored and the PR is created unverified.
    const repo = fakeRepo('echo BROKEN >&2; exit 1');
    const stdout = run(bash('gh pr create --title x', repo));
    expect(() => JSON.parse(stdout) as unknown).not.toThrow();
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

    it('catches whitespace variants', () => {
      // Pinned separately from the list above, which does *not* cover this: the
      // two-line `git push` case passes even with the normalisation deleted,
      // because a glob `*` already matches across a newline. Mutation testing
      // found the fix shipped with a test that could not see it — the same
      // shape as the round-3 finding it was written for.
      const repo = fakeRepo('exit 1');
      for (const command of ['gh  pr   create', 'gh\tpr\tcreate']) {
        expect(parseDecision(run(bash(command, repo))), JSON.stringify(command)).toBe('deny');
      }
    });

    it('catches the gh api route to opening a pull request', () => {
      // Refusing one route while leaving another open is not a gate, and this
      // is the obvious fallback the moment the direct command is denied.
      const repo = fakeRepo('exit 1');
      expect(parseDecision(run(bash('gh api repos/o/r/pulls -f title=x', repo)))).toBe('deny');
    });

    it('ignores commands that have nothing to do with a PR', () => {
      const repo = fakeRepo('exit 1');
      // `gh` subcommands that read rather than create are included on purpose:
      // the match is deliberately loose, and this is where that would bite.
      for (const command of [
        'git status',
        'ls -la',
        'npm test',
        'gh repo view',
        'gh pr list',
        'gh api user',
      ]) {
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
      const stdout = run(bash('gh pr create', repo), { PATH: pathWithoutJq() });
      expect(parseDecision(stdout)).toBe('deny');
      expect(stdout).toContain('jq');
    });

    it('still allows ordinary commands when jq is missing', () => {
      // The collateral damage of guarding before matching: with the jq check
      // ahead of the filter, a machine without jq refused *every* Bash call and
      // the repo became unusable rather than merely un-PR-able.
      //
      // The last three carry the letters "gh" inside ordinary words. A bare
      // `*gh*` prefilter refused all of them with a message about a PR, which
      // is the same nonsense diagnosis this gate was rewritten to stop giving.
      const repo = fakeRepo('exit 0');
      for (const command of [
        'git status',
        'npm run lighthouse',
        'cat notes/highlights.md',
        'grep -rn TODO through/the/tree',
      ]) {
        expect(parseDecision(run(bash(command, repo), { PATH: pathWithoutJq() })), command).toBe(
          'allow',
        );
      }
    });
  });

  describe('the last-resort backstop', () => {
    // These exist because mutation testing found the round-2 fail-open was
    // still *invisible*: deleting `exit 0` from the trap — literally that bug —
    // left all nineteen other tests green, as did deleting the trap outright.
    // A backstop nothing makes fire is not a backstop.

    it('denies, once, when the script hits a fatal', () => {
      // A copy of the script with a deliberate `set -u` fatal spliced in right
      // after the backstop is installed. Contrived on purpose: the backstop
      // exists for the errors nobody enumerated, so the only faithful test is
      // to cause one. Driving an *anticipated* failure instead — a missing
      // `dirname`, an unresolvable cwd — takes a normal `deny` path and leaves
      // the trap untested, which is exactly how the round-2 bug survived a
      // green suite. An earlier version of this test did that and let the
      // trap-deleted mutant live.
      const source = readFileSync(SCRIPT, 'utf8');
      const marker = 'trap finish EXIT';
      expect(source, 'the backstop this test exercises has moved').toContain(marker);
      const dir = mkdtempSync(join(tmpdir(), 'gate-fatal-'));
      temps.push(dir);
      const broken = join(dir, 'gate.sh');
      writeFileSync(broken, source.replace(marker, `${marker}\necho "$NOT_SET_ANYWHERE"`));

      const result = spawnSync('bash', [broken], {
        input: JSON.stringify({ tool_input: { command: 'gh pr create' }, cwd: '/tmp' }),
        encoding: 'utf8',
      });

      // Exit 0, or the hook runner treats it as a non-blocking error and lets
      // the command through — which is the fail-open itself.
      expect(result.status).toBe(0);
      expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
      expect(parseDecision(result.stdout)).toBe('deny');
    });

    it('never emits two documents on any reachable path', () => {
      // The shape of the round-2 bug rather than one instance of it: whatever
      // happens, stdout is either empty (allow) or exactly one JSON object.
      const repo = fakeRepo('exit 1');
      const payloads: unknown[] = [
        bash('gh pr create', repo),
        bash('git status', repo),
        bash('gh pr create', '/nonexistent/deep'),
        '{"tool_input":{"command":,}} gh pr create',
        '',
        { tool_input: { command: 'gh pr create' }, cwd: null },
      ];
      for (const payload of payloads) {
        const { status, stdout } = runRaw(payload);
        expect(status, JSON.stringify(payload)).toBe(0);
        if (stdout.trim() !== '') {
          expect(() => JSON.parse(stdout) as unknown, JSON.stringify(payload)).not.toThrow();
        }
      }
    });

    it('denies when jq writes something and then fails', () => {
      // A jq that emits a fragment *and* exits non-zero used to put that
      // fragment on stdout ahead of the fallback — two documents again.
      const stub = mkdtempSync(join(tmpdir(), 'jqstub-'));
      temps.push(stub);
      writeFileSync(join(stub, 'jq'), '#!/bin/sh\necho "jq: partial output"\nexit 3\n');
      chmodSync(join(stub, 'jq'), 0o755);
      const repo = fakeRepo('exit 1');
      const { status, stdout } = runRaw(bash('gh pr create', repo), {
        PATH: `${stub}:${process.env.PATH ?? ''}`,
      });
      expect(status).toBe(0);
      expect(() => JSON.parse(stdout) as unknown).not.toThrow();
      expect(parseDecision(stdout)).toBe('deny');
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

    it('sees a match even when the tail is big enough to fill a pipe', () => {
      // The reason the classifier reads from a variable rather than piping into
      // `grep -q`. With `pipefail`, grep exits on its first match, `tail` then
      // takes SIGPIPE, and the pipeline inherits *that* status — so the check
      // was false exactly when it matched. It only shows up once the tail fills
      // the pipe buffer, which is why a one-line fixture missed it entirely and
      // the buggy form passed the test written for it.
      const repo = fakeRepo(
        // The match must land on the FIRST of the last fifteen lines, so grep
        // exits with fourteen big lines still unwritten behind it.
        'echo "npm error audit endpoint returned an error"; ' +
          'for i in $(seq 14); do printf "%020000d\\n" 0; done; exit 1',
      );
      const stdout = run(bash('gh pr create', repo));
      expect(parseDecision(stdout)).toBe('deny');
      expect(stdout).toContain('looks like the network');
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
