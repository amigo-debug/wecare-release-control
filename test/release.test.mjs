import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeRelease, planRelease } from '../scripts/release.mjs';

const env = {
  GITHUB_REPOSITORY: 'amigo-debug/wecare-release-control',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'amigo-debug/wecare-release-control/.github/workflows/release.yml@refs/heads/main',
  GITHUB_ACTOR: 'amigo-debug',
  GITHUB_TRIGGERING_ACTOR: 'amigo-debug',
  RELEASE_ACTORS: 'amigo-debug,test-operator',
  RELEASE_ENABLED: 'true',
  VERCEL_TOKEN: 'synthetic-test-token',
};
const input = { project: 'website', operation: 'check', version: 'test-release', confirm: 'false' };
const version = {
  deploymentId: 'dpl_TestCandidate1', sourceSha: 'a'.repeat(40),
  reviewed: true, allowPublish: true, allowRollback: true,
  checks: { application: true, database: true, automation: true },
};
const catalog = { website: { 'test-release': version }, erp: {} };
const targetId = 'prj_R1PQpAGilJTqvEX3nHp4LHEckeZ8';
const makePlan = (i = {}, e = {}, c = catalog) => planRelease({ ...input, ...i }, { ...env, ...e }, c);

test('maps website to one fixed project and domain', () => {
  const p = makePlan();
  assert.equal(p.target.projectId, targetId);
  assert.equal(p.target.domain, 'wecarenursing.com.hk');
});
for (const patch of [
  { GITHUB_REF: 'refs/heads/feature' },
  { GITHUB_REPOSITORY: 'someone/other-repo' },
  { GITHUB_EVENT_NAME: 'pull_request_target' },
  { GITHUB_ACTOR: 'unknown' },
  { GITHUB_TRIGGERING_ACTOR: 'unknown' },
  { GITHUB_WORKFLOW_REF: 'amigo-debug/wecare-release-control/.github/workflows/evil.yml@refs/heads/main' },
  { RELEASE_ACTORS: '' },
]) test(`rejects unsafe context ${JSON.stringify(patch)}`, () => assert.throws(() => makePlan({}, patch)));

test('rejects arbitrary project, operation, URL and unknown version', () => {
  for (const patch of [{ project: 'other' }, { project: '__proto__' }, { operation: 'deploy' },
    { version: 'https://evil.example/' }, { version: 'constructor' }]) {
    assert.throws(() => makePlan(patch));
  }
});
test('requires explicit confirmation and activation for mutations', () => {
  assert.throws(() => makePlan({ operation: 'publish' }));
  assert.throws(() => makePlan({ operation: 'publish', confirm: 'true' }, { RELEASE_ENABLED: 'false' }));
  assert.equal(makePlan({ operation: 'publish', confirm: 'true' }).operation, 'publish');
});
test('observed baseline can be inspected, never published or rolled back', () => {
  const baseline = { website: { 'test-release': { ...version, reviewed: false } } };
  assert.equal(makePlan({}, {}, baseline).operation, 'check');
  for (const operation of ['publish', 'rollback']) {
    assert.throws(() => makePlan({ operation, confirm: 'true' }, {}, baseline));
  }
});
test('all three review checks and source SHA required for a mutation', () => {
  for (const patch of [{ checks: { ...version.checks, database: false } },
    { sourceSha: null }, { allowPublish: false }]) {
    assert.throws(() => makePlan({ operation: 'publish', confirm: 'true' }, {},
      { website: { 'test-release': { ...version, ...patch } } }));
  }
});

function transport({ candidate = {}, current = 'dpl_Current1', broad = false, wrongScope = false,
  postFailure = false, neverMaps = false, failedAlias = false, eligibleRollback = true } = {}) {
  const calls = [];
  let assigned = current;
  const fetcher = async (url, options) => {
    const u = new URL(url);
    calls.push({ method: options.method, path: u.pathname });
    assert.equal(u.origin, 'https://api.vercel.com');
    assert.equal(options.redirect, 'error');
    let status = 200;
    let data;
    if (u.pathname === '/v9/projects') {
      data = { projects: [{ id: targetId }, ...(broad ? [{ id: 'prj_Other' }] : [])], pagination: { next: null } };
    } else if (u.pathname.startsWith('/v9/projects/')) {
      status = wrongScope ? 200 : 403; data = {};
    } else if (u.pathname.startsWith('/v13/deployments/')) {
      data = { id: version.deploymentId, projectId: targetId, readyState: 'READY', target: 'production',
        meta: { wecareSourceSha: version.sourceSha }, ...candidate };
    } else if (u.pathname.startsWith('/v4/aliases/')) {
      data = { alias: 'wecarenursing.com.hk', projectId: targetId, deploymentId: assigned };
    } else if (u.pathname === '/v7/deployments') {
      data = { deployments: eligibleRollback ? [{ uid: version.deploymentId, isRollbackCandidate: true }] : [] };
    } else if (u.pathname.endsWith('/promote/' + version.deploymentId)
      || u.pathname.endsWith('/rollback/' + version.deploymentId)) {
      if (postFailure) throw new Error('network error with synthetic-test-token');
      if (!neverMaps) assigned = version.deploymentId;
      data = {};
    } else if (u.pathname.endsWith('/promote/aliases')) {
      data = { aliases: failedAlias ? [{ alias: 'www.wecarenursing.com.hk', status: 'error' }] : [] };
    } else throw new Error('Unexpected request');
    return { status, ok: status >= 200 && status < 300, json: async () => data };
  };
  return { calls, fetcher };
}
const run = (plan, mock) => executeRelease(plan, env.VERCEL_TOKEN, {
  fetcher: mock.fetcher, sleep: async () => {}, pollAttempts: 2,
});
test('check performs only GET and returns a sanitized summary', async () => {
  const mock = transport();
  const result = await run(makePlan(), mock);
  assert.ok(mock.calls.every(x => x.method === 'GET'));
  assert.equal(result.status, 'checked');
  assert.ok(!JSON.stringify(result).includes(env.VERCEL_TOKEN));
});
for (const options of [{ broad: true }, { wrongScope: true },
  { candidate: { projectId: 'prj_Other' } }, { candidate: { target: 'preview' } },
  { candidate: { readyState: 'ERROR' } }, { candidate: { meta: {} } },
  { candidate: { id: 'dpl_Different' } }]) {
  test(`rejects unsafe live response ${JSON.stringify(options)}`, async () => {
    const mock = transport(options);
    await assert.rejects(() => run(makePlan({ operation: 'publish', confirm: 'true' }), mock));
    assert.ok(mock.calls.every(x => x.method === 'GET'));
  });
}
for (const operation of ['publish', 'rollback']) {
  test(`${operation} makes one scoped POST and verifies alias readback`, async () => {
    const mock = transport();
    const result = await run(makePlan({ operation, confirm: 'true' }), mock);
    assert.equal(mock.calls.filter(x => x.method === 'POST').length, 1);
    assert.equal(result.status, 'verified');
    assert.equal(result.previousDeploymentId, 'dpl_Current1');
    assert.equal(result.deploymentId, version.deploymentId);
  });
}
test('already-current candidate does not mutate production', async () => {
  const mock = transport({ current: version.deploymentId });
  assert.equal((await run(makePlan({ operation: 'publish', confirm: 'true' }), mock)).status, 'already-current');
  assert.ok(mock.calls.every(x => x.method === 'GET'));
});
test('an ambiguous POST is not retried or automatically rolled back', async () => {
  const mock = transport({ postFailure: true });
  await assert.rejects(() => run(makePlan({ operation: 'publish', confirm: 'true' }), mock),
    error => !error.message.includes(env.VERCEL_TOKEN) && /uncertain/i.test(error.message));
  assert.equal(mock.calls.filter(x => x.method === 'POST').length, 1);
});
test('alias timeout is not reported as release success', async () => {
  const mock = transport({ neverMaps: true });
  await assert.rejects(() => run(makePlan({ operation: 'publish', confirm: 'true' }), mock), /unverified/i);
});
test('rollback refuses a build that has never served production', async () => {
  const mock = transport({ eligibleRollback: false });
  await assert.rejects(() => run(makePlan({ operation: 'rollback', confirm: 'true' }), mock));
  assert.ok(mock.calls.every(x => x.method === 'GET'));
});
test('partial domain assignment failure is not release success', async () => {
  const mock = transport({ failedAlias: true });
  await assert.rejects(() => run(makePlan({ operation: 'publish', confirm: 'true' }), mock), /unverified/i);
});
test('ERP maps to the second fixed target and cannot use website versions', () => {
  assert.throws(() => makePlan({ project: 'erp' }));
  const p = makePlan({ project: 'erp' }, {}, { erp: { 'test-release': version } });
  assert.equal(p.target.projectId, 'prj_HbHDYufrr0p2K88pmS4oQ9Sw6U3d');
  assert.equal(p.target.domain, 'erpsystem.wecarenursing.com.hk');
});
test('missing token stops before network calls', async () => {
  const mock = transport();
  await assert.rejects(() => executeRelease(makePlan(), '', { fetcher: mock.fetcher }));
  assert.equal(mock.calls.length, 0);
});
