/**
 * Sharp client public surface. The Sharp test lane and any future CLI
 * import these primitives.
 *
 * v1 leaves the CLI binary to a later phase; the lane and integration
 * tests need only the library functions.
 */
export { SharpClient, SharpHttpError, type ClientOptions, type RefInfo } from './http';
export {
  buildTreeFromSnapshot,
  materializeTree,
  snapshotWorkingTree,
  type FileSnapshot,
  type SnapshotOptions,
} from './workspace';

import { SharpClient } from './http';
import { buildTreeFromSnapshot, snapshotWorkingTree } from './workspace';

export interface AuthorIdentity {
  nameAndEmail: string;
  timestamp: number;
  timezone: string;
}

/**
 * High-level: snapshot the working tree at `root`, hash and push every
 * blob, build the tree, create a commit pointing at the given parents,
 * advance `refName` from `expectedOld` to the new commit atomically.
 *
 * Returns the new commit ID (hex). The caller is responsible for
 * choosing parents (e.g., the current value of `refName` for a normal
 * commit; multiple parents for a merge result).
 */
export async function snapshotAndCommit(
  client: SharpClient,
  opts: {
    root: string;
    parents: string[];
    refName: string;
    expectedOld?: string; // undefined = create-only
    author: AuthorIdentity;
    committer: AuthorIdentity;
    message: string;
  },
): Promise<string> {
  const files = await snapshotWorkingTree(client, { root: opts.root });
  const treeId = await buildTreeFromSnapshot(client, files);
  return client.createCommit({
    tree: treeId,
    parents: opts.parents,
    author: {
      name_email: opts.author.nameAndEmail,
      timestamp: opts.author.timestamp,
      timezone: opts.author.timezone,
    },
    committer: {
      name_email: opts.committer.nameAndEmail,
      timestamp: opts.committer.timestamp,
      timezone: opts.committer.timezone,
    },
    message: opts.message,
    refUpdate: { name: opts.refName, expectedOld: opts.expectedOld },
  });
}
