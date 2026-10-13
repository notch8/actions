module.exports = async ({ github, context, merges }) => {
  const marker = '<!-- hyku-auto-merger -->'
  const currentBranch = context.ref.replace('refs/heads/', '')
  const base = merges[currentBranch]
  const merge = base && { head: currentBranch, base }

  if (!merge) return

  const { commits, files } = await getCommits(merge.base, merge.head)

  // Every promotion leaves a merge commit on the branch it lands on, and merging down brings
  // those across too, so a branch is often "ahead" with no file changes at all. A merge-down
  // then would only move empty merge commits, and its own merge would trigger the next one.
  if (files === 0) {
    console.log(`${merge.head} has no file changes that ${merge.base} lacks; nothing to merge down.`)
    await closeEmptyMerge(merge)
    return
  }

  const pullRequests = await getMergedPullRequests(commits, merge)

  if (pullRequests.length === 0) {
    console.log(`No non-${merge.base} PRs to merge from ${merge.head} into ${merge.base}.`)
    return
  }

  await prepareMerge(merge, pullRequests)

  async function getCommits(base, head) {
    const commits = []
    let files = 0
    let page = 1

    while (true) {
      const response = await github.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
        owner: context.repo.owner,
        repo: context.repo.repo,
        basehead: `${base}...${head}`,
        page,
        per_page: 100
      })

      commits.push(...response.data.commits)
      files += (response.data.files || []).length
      if (response.data.total_commits <= page * 100) return { commits, files }
      page += 1
    }
  }

  async function getMergedPullRequests(commits, { head, base }) {
    const pullRequests = new Map()

    for (const commit of commits) {
      const response = await github.rest.repos.listPullRequestsAssociatedWithCommit({
        owner: context.repo.owner,
        repo: context.repo.repo,
        commit_sha: commit.sha
      })

      for (const pullRequest of response.data) {
        if (
          pullRequest.merged_at &&
          pullRequest.base.ref === head &&
          pullRequest.head.ref !== base
        ) {
          pullRequests.set(pullRequest.number, pullRequest)
        }
      }
    }

    return [...pullRequests.values()]
  }

  async function findAutoMergePullRequest({ head, base }) {
    const openPullRequests = await github.rest.pulls.list({
      owner: context.repo.owner,
      repo: context.repo.repo,
      state: 'open',
      head: `${context.repo.owner}:${head}`,
      base,
      sort: 'created',
      direction: 'desc'
    })
    const autoMergePullRequest = openPullRequests.data.find(pullRequest => pullRequest.body && pullRequest.body.includes(marker))
    return { openPullRequests, autoMergePullRequest }
  }

  // An auto-merger PR opened before the changes it carried reached the base some other way.
  async function closeEmptyMerge(merge) {
    const { autoMergePullRequest } = await findAutoMergePullRequest(merge)
    if (!autoMergePullRequest) return

    console.log(`Closing #${autoMergePullRequest.number}; it no longer changes any files.`)
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: autoMergePullRequest.number,
      body: `Closing: \`${merge.base}\` already has every file change in \`${merge.head}\`, so there is nothing left to merge down.`
    })
    await github.rest.pulls.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: autoMergePullRequest.number,
      state: 'closed'
    })
  }

  async function prepareMerge({ head, base }, pullRequests) {
    const date = new Date().toISOString().split('T')[0]
    const title = `Merge down \`${head}\` -> \`${base}\` (${date})`
    const pullRequestList = pullRequests.map(pullRequest => `- #${pullRequest.number} ${pullRequest.title}`).join('\n')
    const body = [
      marker,
      `**Automatic merge-down.** These pull requests went straight into \`${head}\`, so this brings them into \`${base}\` too:`,
      '',
      pullRequestList,
      '',
      `**Review and merge it; don't close it.** Until \`${base}\` has these changes, anything built from \`${base}\` (its environment, new branches) lacks them, and the branches drift apart.`,
      '',
      `Opened by the auto-merger after a push to \`${head}\`. It updates this PR if more changes land there first.`
    ].join('\n')

    const { openPullRequests, autoMergePullRequest } = await findAutoMergePullRequest({ head, base })

    if (autoMergePullRequest) {
      console.log(`Updating ${head} -> ${base} PR #${autoMergePullRequest.number}.`)
      await github.rest.pulls.update({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: autoMergePullRequest.number,
        title,
        body
      })
    } else if (openPullRequests.data.length === 0) {
      console.log(`Creating ${head} -> ${base} PR.`)
      const { data: createdPullRequest } = await github.rest.pulls.create({
        owner: context.repo.owner,
        repo: context.repo.repo,
        title,
        body,
        head,
        base,
        draft: true
      })
      // Satisfies the required `PR has required labels` check.
      await github.rest.issues.addLabels({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: createdPullRequest.number,
        labels: ['ignore-for-release']
      })
    } else {
      console.log(`A manually opened ${head} -> ${base} PR already exists; leaving it alone.`)
    }
  }
}