import { readFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'amigo-debug/wecare-release-control';
const TEAM = 'team_M3TSom4rTOXPgnaUzCfxihjG';
const TARGETS = Object.freeze({
  website: Object.freeze({ projectId: 'prj_R1PQpAGilJTqvEX3nHp4LHEckeZ8',
    domain: 'wecarenursing.com.hk', label: 'WeCare website' }),
  erp: Object.freeze({ projectId: 'prj_HbHDYufrr0p2K88pmS4oQ9Sw6U3d',
    domain: 'erpsystem.wecarenursing.com.hk', label: 'WeCare ERP' }),
});
function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
const has = (object, key) => object != null && Object.hasOwn(object, key);

export function planRelease(input, env, catalog) {
  requireCondition(env.GITHUB_REPOSITORY === REPOSITORY
    && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`,
  'Only manual runs of the protected main release workflow are allowed.');
  const actors = (env.RELEASE_ACTORS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  requireCondition(actors.length > 0 && [env.GITHUB_ACTOR, env.GITHUB_TRIGGERING_ACTOR]
    .every(actor => typeof actor === 'string' && actors.includes(actor.toLowerCase())),
  'Operator is not in the administrator-managed release allowlist.');
  requireCondition(has(TARGETS, input.project), 'Only website and erp targets are allowed.');
  requireCondition(['check', 'publish', 'rollback'].includes(input.operation), 'Unsupported operation.');
  requireCondition(typeof input.version === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(input.version)
    && has(catalog, input.project) && has(catalog[input.project], input.version),
  'Choose an existing version key from the reviewed release catalog.');
  const release = structuredClone(catalog[input.project][input.version]);
  requireCondition(/^dpl_[a-zA-Z0-9]+$/.test(release.deploymentId), 'Invalid catalog deployment ID.');
  if (input.operation !== 'check') {
    requireCondition(env.RELEASE_ENABLED === 'true', 'Release mutations are not activated.');
    requireCondition(input.confirm === 'true', 'Explicit release confirmation is required.');
    requireCondition(release.reviewed === true
      && release[input.operation === 'publish' ? 'allowPublish' : 'allowRollback'] === true
      && /^[a-f0-9]{40}$/.test(release.sourceSha || '')
      && ['application', 'database', 'automation'].every(key => release.checks?.[key] === true),
    'This version has not passed the application, database and automation review for this operation.');
  }
  return Object.freeze({ target: TARGETS[input.project], project: input.project,
    version: input.version, operation: input.operation, release: Object.freeze(release) });
}

export async function executeRelease(plan, token, {
  fetcher = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), pollAttempts = 20,
} = {}) {
  requireCondition(typeof token === 'string' && token.length > 0, 'Project-scoped Vercel credential is missing.');
  async function request(path, { method = 'GET', denied = false } = {}) {
    const url = new URL(path, 'https://api.vercel.com');
    requireCondition(url.origin === 'https://api.vercel.com', 'External API destinations are forbidden.');
    url.searchParams.set('teamId', TEAM);
    let response;
    try {
      response = await fetcher(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch {
      throw new Error(method === 'POST'
        ? 'Release outcome uncertain. Check current production before any new request; no automatic retry was made.'
        : 'Vercel read request failed. No release was attempted.');
    }
    if (denied) {
      requireCondition([403, 404].includes(response.status), 'Credential can reach another project or scope denial is unverified.');
      return null;
    }
    requireCondition(response.ok, method === 'POST'
      ? 'Release request was not confirmed. Check production before retrying.'
      : 'Vercel read was denied or unavailable. No release was attempted.');
    if (method === 'POST') return null;
    try { return await response.json(); }
    catch { throw new Error('Invalid Vercel response. Release verification stopped.'); }
  }

  // Reject broad tokens as well as the wrong project before touching deployment state.
  const listing = await request('/v9/projects?limit=100');
  requireCondition(Array.isArray(listing.projects) && listing.projects.length === 1
    && listing.projects[0].id === plan.target.projectId && !listing.pagination?.next,
  'Project scope was not verified. '
    + `projectCount=${Array.isArray(listing.projects) ? listing.projects.length : 'invalid'}; `
    + `targetPresent=${Array.isArray(listing.projects) && listing.projects.some(item => item.id === plan.target.projectId)}; `
    + `hasMore=${Boolean(listing.pagination?.next)}. No release was attempted.`);
  const other = Object.values(TARGETS).find(t => t.projectId !== plan.target.projectId);
  await request(`/v9/projects/${other.projectId}`, { denied: true });
  const deployment = await request(`/v13/deployments/${plan.release.deploymentId}`);
  requireCondition(deployment.id === plan.release.deploymentId
    && (deployment.projectId || deployment.project?.id) === plan.target.projectId
    && (!deployment.ownerId || deployment.ownerId === TEAM)
    && deployment.target === 'production'
    && (deployment.readyState || deployment.state) === 'READY'
    && (!deployment.state || deployment.state === 'READY'),
  'Candidate must be the exact READY production build belonging to the selected project.');
  if (plan.operation !== 'check') {
    const sha = deployment.meta?.wecareSourceSha || deployment.meta?.githubCommitSha || deployment.gitSource?.sha;
    requireCondition(sha === plan.release.sourceSha, 'Candidate source SHA does not match its reviewed catalog record.');
  }
  async function currentDeployment() {
    const alias = await request(`/v4/aliases/${plan.target.domain}`);
    requireCondition(alias.alias === plan.target.domain && alias.projectId === plan.target.projectId
      && /^dpl_[a-zA-Z0-9]+$/.test(alias.deploymentId || ''),
    'Production domain mapping is missing or does not belong to the selected project.');
    return alias.deploymentId;
  }
  const previousDeploymentId = await currentDeployment();
  const result = { project: plan.project, operation: plan.operation, version: plan.version,
    deploymentId: deployment.id, previousDeploymentId, productionUrl: `https://${plan.target.domain}` };
  if (plan.operation === 'check') return { ...result, status: 'checked' };
  if (previousDeploymentId === deployment.id) return { ...result, status: 'already-current' };
  if (plan.operation === 'rollback') {
    const candidates = await request(`/v7/deployments?projectId=${plan.target.projectId}&target=production&state=READY&rollbackCandidate=true&limit=100`);
    requireCondition(Array.isArray(candidates.deployments) && candidates.deployments.some(item =>
      (item.uid || item.id) === deployment.id && item.isRollbackCandidate === true),
    'The selected version is not a verified previous production rollback candidate.');
  }

  const started = Date.now();
  const endpoint = plan.operation === 'publish' ? '/v10/projects' : '/v1/projects';
  const action = plan.operation === 'publish' ? 'promote' : 'rollback';
  await request(`${endpoint}/${plan.target.projectId}/${action}/${deployment.id}`, { method: 'POST' });
  try {
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      if (await currentDeployment() === deployment.id) {
        if (plan.operation === 'publish') {
          const aliases = await request(`/v1/projects/${plan.target.projectId}/promote/aliases?failedOnly=true&since=${started}&limit=100`);
          requireCondition(Array.isArray(aliases.aliases) && aliases.aliases.length === 0
            && !aliases.pagination?.next, 'One or more production aliases have not been verified.');
        }
        return { ...result, status: 'verified' };
      }
      await sleep(3000);
    }
  } catch {
    throw new Error('Release submitted but unverified. Inspect production; no automatic retry or rollback was attempted.');
  }
  throw new Error('Release submitted but unverified after timeout. Inspect production before retrying.');
}

async function main() {
  const catalog = JSON.parse(await readFile(new URL('../releases.json', import.meta.url), 'utf8'));
  const plan = planRelease({ project: process.env.RELEASE_PROJECT, operation: process.env.RELEASE_OPERATION,
    version: process.env.RELEASE_VERSION, confirm: process.env.RELEASE_CONFIRM }, process.env, catalog);
  const result = await executeRelease(plan, process.env.VERCEL_TOKEN);
  // Only these controlled fields are public. Never output full provider responses or environment values.
  const summary = `## WeCare release\n\n| Field | Result |\n| --- | --- |\n`
    + Object.entries(result).map(([key, value]) => `| ${key} | ${value} |`).join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(`WeCare ${result.project}: ${result.operation} ${result.status}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const token = process.env.VERCEL_TOKEN;
    const message = String(error.message).replaceAll(token || '\0', '[REDACTED]');
    console.error(message);
    process.exitCode = 1;
  });
}
