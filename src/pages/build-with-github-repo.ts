import * as Github from '@octokit/rest';
import * as Admzip from 'adm-zip';
import * as fs from 'fs-extra';
import { Context } from 'koa';
import BuildQueue from '../BuildQueue.class';
import { inWhitelist, REPO_WHITELIST_ENABLED, TEMP_DIR } from '../configs';
import Job from '../Job.class';

export default {
  async get (ctx: Context) {
    const owner = ctx.query.owner;
    const repo = ctx.query.repo;
    const ref = ctx.query.ref || 'master';
    console.timeLog('Job info received: repo= ' + owner + '/' + repo + ' ref= ' + ref);
    if (!REPO_WHITELIST_ENABLED || inWhitelist(owner, repo, ref)) {
      startGithubJob(ctx, owner, repo, ref);
    } else {
      ctx.throw(403, 'Whitelist is enabled & your repo (or ref) is not in it.');
    }
  },

  async post (ctx: Context) {
    const event = ctx.get('X-GitHub-Event') as string | undefined;
    console.log('Github event = ' + event);
    if (!['push', 'release'].includes(event)) {
      ctx.throw(403, 'Does not support event type: ' + event);
    }

    let content = '';
    ctx.req.on('data', chunk => {
      content += chunk;
    });
    ctx.req.on('end', () => {
      const playload = JSON.parse(content);
      if (event === 'push' && playload.ref.indexOf('refs/heads/') === -1) {
        ctx.body = 'Build ignored since this is not a push of /refs/heads/';
        return;
      }
      let ref: string;
      if (event === 'push') {
        ref = playload.head_commit.id;
      } else if (event === 'release') {
        ref = playload.release.tag_name;
      }
      const owner = playload.repository.owner.login;
      const repo = playload.repository.name;
      console.log(`Repo = ${owner}/${repo} ref = ${ref}`);
      if (typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof ref !== 'string') {
        ctx.throw(403, 'Cannot be built, at least one of owner, repo or commit is not string.');
        return;
      }
      if (!REPO_WHITELIST_ENABLED || inWhitelist(owner, repo)) {
        startGithubJob(ctx, owner, repo, ref, event === 'release');
        return;
      } else {
        ctx.throw(403, 'Whitelist is enabled & your repo is not in it.');
        return;
      }
    });
  },
};

async function startGithubJob (ctx: Context, owner: string, repo: string, ref: string, isRelease = false) {
  const job = new Job();
  const jobId = job.id;

  job.attachInfo('buildType', 'github-repo');
  job.attachInfo('owner', owner);
  job.attachInfo('repo', repo);
  job.attachInfo('ref', ref);
  job.attachInfo('isRelease', isRelease);

  ctx.body = { jobId, msg: 'Job added.' };

  // Downlaod archive
  let archiveResponse: Github.Response<Github.ReposGetArchiveLinkResponse>;
  try {
    archiveResponse = await new Github().repos.getArchiveLink({ owner, repo, ref, archive_format: 'zipball' });
  } catch (e) {
    job.status = 'failed';
    job.attachInfo('failInfo', 'Cannot load source from github, please check if the ref or repo exists.');
    console.log(`Fail prepare source of job(${jobId})`, e);
    return;
  }

  // Extract responding archive
  const zip = new Admzip(archiveResponse.data as Buffer);
  if (zip.getEntries().length === 0) {
    throw new Error('No source found in archive downloaded.');
  }
  const entryDir = zip.getEntries()[0].entryName;
  zip.extractAllTo(TEMP_DIR + '/' + jobId + '/rawComponentSource/');
  fs.moveSync(TEMP_DIR + '/' + jobId + '/rawComponentSource/' + entryDir,
              TEMP_DIR + '/' + jobId + '/src');
  fs.rmdirSync(TEMP_DIR + '/' + jobId + '/rawComponentSource');
  console.timeLog('Source extracted to ' + TEMP_DIR + '/' + jobId + '/src');

  BuildQueue.enqueue(job);
}
