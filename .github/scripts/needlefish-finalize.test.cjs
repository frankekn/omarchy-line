const { test } = require('node:test');
const assert = require('node:assert/strict');
const finalize = require('./needlefish-finalize.cjs');

class ActionsContext {
  get repo() { return { owner: 'owner', repo: 'repo' }; }
}

function scenario(conclusion = 'cancelled') {
  const head = 'a'.repeat(40);
  const context = Object.assign(new ActionsContext(), {
    payload: { workflow_run: {
      id: 123, run_attempt: 2, status: 'completed', conclusion,
      repository: { full_name: 'owner/repo' }, html_url: 'https://github.com/owner/repo/actions/runs/123'
    } }
  });
  const identity = { run_id: '123', run_attempt: '2', head_sha: head };
  const checks = [{
    id: 1, name: 'Needlefish', app: { slug: 'github-actions' }, external_id: '123',
    head_sha: head, started_at: '2026-09-07T10:01:00Z', status: 'in_progress', conclusion: null
  }];
  const jobs = [{ steps: [{
    name: 'Needlefish review', started_at: '2026-09-07T10:00:00Z',
    completed_at: '2026-09-07T11:00:00Z', conclusion: 'cancelled'
  }] }];
  const github = {
    rest: {
      actions: { listJobsForWorkflowRunAttempt: 'jobs' },
      checks: {
        listForRef: 'checks',
        get: async ({ check_run_id }) => ({ data: checks.find(c => c.id === check_run_id) }),
        update: async ({ check_run_id, ...change }) => Object.assign(checks.find(c => c.id === check_run_id), change)
      }
    },
    paginate: async (endpoint, params) => {
      if (endpoint === 'jobs') {
        assert.equal(params.attempt_number, 2);
        return jobs;
      }
      assert.equal(params.ref, head);
      assert.equal(params.filter, 'all');
      return checks;
    }
  };
  return { github, context, identity, checks, jobs };
}

test('a killed runner leaves an explicitly cancelled review, without changing another run or attempt', async () => {
  const s = scenario();
  s.checks.push(
    { ...s.checks[0], id: 2, external_id: '456' },
    { ...s.checks[0], id: 3, started_at: '2026-09-07T09:01:00Z' },
    { ...s.checks[0], id: 4, started_at: '2026-09-07T11:01:00Z' },
    { ...s.checks[0], id: 5, head_sha: 'b'.repeat(40) },
    { ...s.checks[0], id: 6, app: { slug: 'another-app' } }
  );
  const unrelated = structuredClone(s.checks.slice(1));
  await finalize(s);
  assert.equal(s.checks[0].status, 'completed');
  assert.equal(s.checks[0].conclusion, 'cancelled');
  assert.deepEqual(s.checks.slice(1), unrelated);
  const finished = structuredClone(s.checks);
  await finalize(s);
  assert.deepEqual(s.checks, finished);
});

test('hard timeout and failed process cannot leave a pending or passing review', async () => {
  for (const conclusion of ['timed_out', 'failure', 'success']) {
    const s = scenario(conclusion);
    await finalize(s);
    assert.equal(s.checks[0].status, 'completed');
    assert.equal(s.checks[0].conclusion, conclusion === 'timed_out' ? 'timed_out' : 'failure');
  }
});

test('completed reviewer verdicts survive workflow failure and cancellation', async () => {
  for (const conclusion of ['success', 'failure']) {
    const s = scenario();
    Object.assign(s.checks[0], { status: 'completed', conclusion });
    const before = structuredClone(s.checks);
    await finalize(s);
    assert.deepEqual(s.checks, before);
  }
});

test('invalid artifact identity fails before any check mutation', async () => {
  for (const change of [{ run_id: '456' }, { run_attempt: '1' }, { head_sha: '../other' }]) {
    const s = scenario();
    Object.assign(s.identity, change);
    const before = structuredClone(s.checks);
    await assert.rejects(finalize(s), /identity/);
    assert.deepEqual(s.checks, before);
  }
});

test('a skipped review does not claim or close a check', async () => {
  const s = scenario();
  s.jobs[0].steps[0].conclusion = 'skipped';
  const before = structuredClone(s.checks);
  await finalize(s);
  assert.deepEqual(s.checks, before);
});

test('a completed detail response takes precedence over a stale pending list entry', async () => {
  const s = scenario();
  s.github.rest.checks.get = async () => {
    Object.assign(s.checks[0], { status: 'completed', conclusion: 'success' });
    return { data: s.checks[0] };
  };
  await finalize(s);
  assert.equal(s.checks[0].conclusion, 'success');
});

test('an active original workflow cannot finalize any review', async () => {
  const s = scenario();
  s.context.payload.workflow_run.status = 'in_progress';
  const before = structuredClone(s.checks);
  await assert.rejects(finalize(s), /completed workflow run/);
  assert.deepEqual(s.checks, before);
});

test('manual recovery closes a historical check using the exact completed attempt without an artifact', async () => {
  const s = scenario();
  const original = s.context.payload.workflow_run;
  s.context.payload = { inputs: s.identity };
  s.github.rest.actions.getWorkflowRunAttempt = async params => {
    assert.equal(params.run_id, 123);
    assert.equal(params.attempt_number, 2);
    return { data: original };
  };
  await finalize.recover({ ...s, inputs: s.identity });
  assert.equal(s.checks[0].status, 'completed');
  assert.equal(s.checks[0].conclusion, 'cancelled');
});

test('manual recovery rejects an active attempt instead of trusting the operator', async () => {
  const s = scenario();
  s.context.payload.workflow_run.status = 'in_progress';
  s.github.rest.actions.getWorkflowRunAttempt = async () => ({ data: s.context.payload.workflow_run });
  const before = structuredClone(s.checks);
  await assert.rejects(finalize.recover({ ...s, inputs: s.identity }), /completed workflow run/);
  assert.deepEqual(s.checks, before);
});

test('manual recovery rejects malformed run IDs before reaching GitHub', async () => {
  for (const run_id of ['../123', '0', '1.5', '9007199254740993']) {
    const s = scenario();
    await assert.rejects(finalize.recover({ ...s, inputs: { ...s.identity, run_id } }), /Invalid recovery run_id/);
    assert.equal(s.checks[0].status, 'in_progress');
  }
});
