// Starts a render or preview job on GitHub Actions.
import { CONFIG, env } from './config.js';

const gh = (method, path, body) => fetch('https://api.github.com/repos/' + CONFIG.githubRepo + path, {
  method,
  headers: { Authorization: 'Bearer ' + env('GH_DISPATCH_TOKEN'), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'message-desk' },
  body: body ? JSON.stringify(body) : undefined
});

// Stops any render still running for a post (each run is named after its post).
export async function cancelRuns(workflowFile, messageId) {
  for (const status of ['in_progress', 'queued', 'waiting']) {
    const r = await gh('GET', '/actions/workflows/' + workflowFile + '/runs?per_page=30&status=' + status);
    if (!r.ok) continue;
    const j = await r.json();
    for (const run of j.workflow_runs || []) {
      if (String(run.display_title || run.name).includes(messageId) && !/practice/.test(run.display_title || '')) {
        await gh('POST', '/actions/runs/' + run.id + '/cancel');
      }
    }
  }
}

export async function dispatch(workflowFile, inputs) {
  const r = await fetch('https://api.github.com/repos/' + CONFIG.githubRepo + '/actions/workflows/' + workflowFile + '/dispatches', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env('GH_DISPATCH_TOKEN'),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'message-desk'
    },
    body: JSON.stringify({ ref: CONFIG.githubBranch, inputs })
  });
  if (r.status !== 204) {
    const t = await r.text().catch(() => '');
    throw new Error('Could not start the job: ' + r.status + ' ' + t.slice(0, 200));
  }
}
