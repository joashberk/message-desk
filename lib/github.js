// Starts a render or preview job on GitHub Actions.
import { CONFIG, env } from './config.js';

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
