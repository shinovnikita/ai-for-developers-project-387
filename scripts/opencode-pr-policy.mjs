export const REPOSITORY = 'shinovnikita/ai-for-developers-project-387';
export const SHA = /^[a-f0-9]{40}$/;
export const REVIEW_EVENTS = ['opened', 'synchronize', 'reopened', 'ready_for_review'];

export function classifyEvent(event, name) {
  if (event.repository?.full_name !== REPOSITORY) return { allowed: false, reason: 'repository' };
  if (name === 'pull_request') {
    if (!REVIEW_EVENTS.includes(event.action) || event.pull_request?.draft) {
      return { allowed: false, reason: 'event or draft' };
    }
    return { allowed: true, kind: 'review', pr: event.pull_request.number };
  }
  if (!['issue_comment', 'pull_request_review_comment'].includes(name) || event.action !== 'created') {
    return { allowed: false, reason: 'event' };
  }
  const comment = event.comment;
  if (comment?.user?.login !== 'shinovnikita' || comment.user.type !== 'User') {
    return { allowed: false, reason: 'untrusted command author' };
  }
  if (!/(?:^|\s)\/(?:oc|opencode)(?=\s|$)/i.test(comment.body ?? '')) {
    return { allowed: false, reason: 'no command' };
  }
  const pr = event.pull_request?.number ?? (event.issue?.pull_request && event.issue.number);
  return { allowed: true, kind: pr ? 'fix' : 'issue', pr: pr || undefined };
}

export function assertPullRequest(pr, expected = {}) {
  if (pr.state !== 'open' || pr.base?.repo?.full_name !== REPOSITORY
    || pr.base.ref !== 'main' || pr.head?.repo?.full_name !== REPOSITORY
    || !SHA.test(pr.head.sha) || !pr.head.ref || pr.head.ref === 'main'
    || pr.head.ref === 'opencode-budget' || pr.head.ref.startsWith('release-please--')) {
    throw new Error('PR must be open, same-repository, target main, and use a non-protected work branch');
  }
  if (expected.sha && pr.head.sha !== expected.sha) throw new Error('Stale PR HEAD');
  if (expected.branch && pr.head.ref !== expected.branch) throw new Error('PR branch changed');
  return pr;
}
