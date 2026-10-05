const fs = require('node:fs');

module.exports = async function finalize({ github, context, identity }) {
  const run = context.payload.workflow_run;
  const repo = context.repo;
  if (run.status !== 'completed' || run.repository.full_name !== `${repo.owner}/${repo.repo}`) {
    throw new Error('Expected a completed workflow run from this repository');
  }
  if (identity.run_id !== String(run.id) || identity.run_attempt !== String(run.run_attempt) ||
      !/^[0-9a-f]{40}$/.test(identity.head_sha)) {
    throw new Error('Review identity does not match the completed run attempt');
  }

  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
    ...repo, run_id: run.id, attempt_number: run.run_attempt, per_page: 100
  });
  const review = jobs.flatMap(job => job.steps || []).filter(step => step.name === 'Needlefish review');
  if (review.length === 0) return;
  if (review.length !== 1) throw new Error('Ambiguous review step identity');
  const step = review[0];
  if (step.conclusion === 'skipped') return;
  const start = Date.parse(step.started_at);
  const end = Date.parse(step.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error('Completed review step has no valid execution interval');
  }

  // Needlefish external_id contains run_id only; timestamps isolate reruns of the same SHA.
  const belongsToAttempt = check => check.name === 'Needlefish' &&
    check.app?.slug === 'github-actions' && check.external_id === String(run.id) &&
    check.head_sha === identity.head_sha && Date.parse(check.started_at) >= start &&
    Date.parse(check.started_at) <= end;
  const checks = await github.paginate(github.rest.checks.listForRef, {
    ...repo, ref: identity.head_sha, check_name: 'Needlefish', filter: 'all', per_page: 100
  });
  for (const check of checks.filter(belongsToAttempt)) {
    // workflow_run.completed serializes this after the synchronous reviewer and runner cleanup.
    // The reread handles a stale list response; it is not a CAS against an active reviewer.
    // A normally finished review owns its verdict, including a legitimate failure.
    const { data: current } = await github.rest.checks.get({ ...repo, check_run_id: check.id });
    if (!belongsToAttempt(current) || current.status === 'completed') continue;
    const conclusion = run.conclusion === 'cancelled' ? 'cancelled' :
      run.conclusion === 'timed_out' ? 'timed_out' : 'failure';
    await github.rest.checks.update({
      ...repo, check_run_id: check.id, status: 'completed', conclusion,
      output: {
        title: 'Needlefish review interrupted',
        summary: `Workflow run ${run.id}, attempt ${run.run_attempt} ended (${run.conclusion}) without a review verdict. This is not a passing review. See ${run.html_url}.`
      }
    });
  }
};

module.exports.readIdentity = path => JSON.parse(fs.readFileSync(path, 'utf8'));

module.exports.recover = async function recover({ github, context, inputs }) {
  for (const key of ['run_id', 'run_attempt']) {
    const value = Number(inputs[key]);
    if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== inputs[key]) {
      throw new Error(`Invalid recovery ${key}`);
    }
  }
  const { data: run } = await github.rest.actions.getWorkflowRunAttempt({
    ...context.repo, run_id: Number(inputs.run_id), attempt_number: Number(inputs.run_attempt)
  });
  await module.exports({
    github,
    context: { repo: context.repo, payload: { workflow_run: run } },
    identity: { run_id: inputs.run_id, run_attempt: inputs.run_attempt, head_sha: inputs.head_sha }
  });
};
