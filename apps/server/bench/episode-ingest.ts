/**
 * Bench: episode ingest throughput
 *
 * Opens, appends 3 artifacts (mix of inline + CAS), and finishes 500 episodes.
 * Measures total throughput (episodes/sec).
 *
 * Threshold (from v1-plan §3): > 100 episodes/sec (warn, don't fail).
 */
import type postgres from 'postgres';
import { encodeTree } from '@sharp/git-canonical';
import { createRepo, putObject } from '../src/cas';
import { createCommit } from '../src/commit';
import { openEpisode, appendArtifact, finishEpisode } from '../src/episodes';

const EPISODE_COUNT = 500;
const PERSON = {
  nameAndEmail: 'Bench Bot <bench@sharp.dev>',
  timestamp: 1735689600,
  timezone: '+0000',
};

export interface EpisodeIngestResult {
  suite: 'episode-ingest';
  episodeCount: number;
  totalMs: number;
  episodesPerSec: number;
  thresholdEpisodesPerSec: number;
  pass: boolean;
}

async function makeParentCommit(sql: postgres.Sql, repoId: string): Promise<Uint8Array> {
  const blobPayload = new Uint8Array(Buffer.from('initial file\n', 'utf8'));
  const blobId = await putObject(sql, {
    repo: repoId,
    algo: 'sha1',
    kind: 'blob',
    payload: blobPayload,
  });
  const treeBytes = encodeTree([{ mode: '100644', name: 'README.md', id: blobId }]);
  const treeId = await putObject(sql, {
    repo: repoId,
    algo: 'sha1',
    kind: 'tree',
    payload: treeBytes,
  });
  const { id } = await createCommit(sql, {
    repo: repoId,
    algo: 'sha1',
    commit: {
      tree: treeId,
      parents: [],
      author: PERSON,
      committer: PERSON,
      message: 'initial\n',
    },
  });
  return id;
}

export async function runEpisodeIngest(sql: postgres.Sql): Promise<EpisodeIngestResult> {
  const repo = await createRepo(sql, { name: `bench_episode_${Date.now()}_${Math.random()}` });
  const parentCommit = await makeParentCommit(sql, repo.id);

  // Pre-build a CAS object to use as a content_ref in artifact.
  const casPayload = new Uint8Array(
    Buffer.from(JSON.stringify({ kind: 'tool_call', data: 'bench payload' }), 'utf8'),
  );
  const casRef = await putObject(sql, {
    repo: repo.id,
    algo: 'sha1',
    kind: 'blob',
    payload: casPayload,
  });

  const t0 = performance.now();

  for (let i = 0; i < EPISODE_COUNT; i++) {
    const { id: episodeId } = await openEpisode(sql, {
      repo: repo.id,
      parent_commit: parentCommit,
      agent_identity: 'bench-agent',
      model_id: 'bench-model-v1',
      harness_version: '0.0.0',
      tool_versions: { bench: '1.0.0' },
      decoding_params: { temperature: 0.7 },
    });

    // Artifact 1: inline prompt
    await appendArtifact(sql, {
      episodeId,
      kind: 'prompt',
      inline: { text: `prompt for episode ${i}` },
    });

    // Artifact 2: CAS tool_call
    await appendArtifact(sql, {
      episodeId,
      kind: 'tool_call',
      contentRef: casRef,
    });

    // Artifact 3: inline tool_result
    await appendArtifact(sql, {
      episodeId,
      kind: 'tool_result',
      inline: { result: 'ok', episode: i },
    });

    await finishEpisode(sql, { episodeId, status: 'completed' });
  }

  const t1 = performance.now();
  const totalMs = t1 - t0;
  const episodesPerSec = (EPISODE_COUNT / totalMs) * 1000;
  const THRESHOLD = 100;

  return {
    suite: 'episode-ingest',
    episodeCount: EPISODE_COUNT,
    totalMs: Math.round(totalMs),
    episodesPerSec: Math.round(episodesPerSec * 10) / 10,
    thresholdEpisodesPerSec: THRESHOLD,
    pass: episodesPerSec > THRESHOLD,
  };
}
