#!/usr/bin/env bun
/**
 * studio:down — Delete studio cluster resources from k3s.
 *
 * Reads the product's k8s manifests to discover what was deployed,
 * then deletes each resource by kind/name. Leaves the k3s daemon running.
 *
 * Usage:
 *   bun run studio:down [source-dir] [k8s-dir]
 *
 * Arguments mirror studio-start.ts. Defaults:
 *   source-dir  Parent of the studio submodule.
 *   k8s-dir     "k8s/" relative to source-dir.
 */

import { join, resolve } from 'path';
import { discoverResources } from '../packages/core/manifest-parser';
import { cleanupCluster } from '../packages/core/cluster-manager';
import type { StudioClusterConfig } from '../packages/core/types';

const STUDIO_DIR = join(import.meta.dir, '..');
const SOURCE_DIR = resolve(process.argv[2] ?? resolve(STUDIO_DIR, '..'));
const K8S_DIR = process.argv[3] ?? 'k8s';
const K8S_DIR_ABS = resolve(SOURCE_DIR, K8S_DIR);

const config: StudioClusterConfig = {
  sourceDir: SOURCE_DIR,
  k8sDir: K8S_DIR,
  namespace: process.env.STUDIO_CLUSTER_CONTEXT ?? 'default',
  verbose: process.env.STUDIO_VERBOSE === '1',
};

console.log(`studio:down — reading manifests from ${K8S_DIR_ABS}`);
const resources = discoverResources(K8S_DIR_ABS);

if (resources.length === 0) {
  console.log('No resources found. Nothing to delete.');
  process.exit(0);
}

console.log(`Deleting ${resources.length} resource(s)...`);
cleanupCluster(config, resources);
console.log('studio:down complete.');
