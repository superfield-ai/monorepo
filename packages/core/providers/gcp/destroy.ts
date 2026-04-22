import { googleJsonRequest } from "../../gcp/http.ts";
import type { HttpDeps } from "../../gcp/http.ts";
import { pollOperation } from "../../gcp/operations.ts";
import { resourceNames } from "./provision.ts";

const COMPUTE_BASE = "https://www.googleapis.com/compute/v1";
const ALLOYDB_BASE = "https://alloydb.googleapis.com/v1";

export interface DestroyOpts {
  projectId: string;
  region: string;
  zone: string;
  env: string;
}

export interface DestroyDeps extends HttpDeps {
  log: (msg: string) => void;
}

interface OperationRef {
  name?: string;
  selfLink?: string;
}

/**
 * Tear down all resources tagged `superfield-env=<env>` for the given
 * project. Idempotent: missing resources are skipped.
 *
 * NOTE: This is a best-effort destroy in dependency order (VM → AlloyDB
 * instance → cluster → PSA address → firewall → subnet → network).
 * VPC peering removal and audit-log verification are intentionally TODO
 * — full impl tracked in a follow-up.
 */
export async function destroy(
  opts: DestroyOpts,
  deps: DestroyDeps,
): Promise<void> {
  const names = resourceNames(opts.env);

  // VM
  await deleteIfExists({
    label: `VM "${names.vm}"`,
    url: `${COMPUTE_BASE}/projects/${opts.projectId}/zones/${opts.zone}/instances/${names.vm}`,
    pollKind: "compute",
    deps,
  });

  // AlloyDB instance
  await deleteIfExists({
    label: `AlloyDB instance "${names.alloydbInstance}"`,
    url: `${ALLOYDB_BASE}/projects/${opts.projectId}/locations/${opts.region}/clusters/${names.alloydbCluster}/instances/${names.alloydbInstance}`,
    pollKind: "alloydb",
    deps,
  });

  // AlloyDB cluster
  await deleteIfExists({
    label: `AlloyDB cluster "${names.alloydbCluster}"`,
    url: `${ALLOYDB_BASE}/projects/${opts.projectId}/locations/${opts.region}/clusters/${names.alloydbCluster}`,
    pollKind: "alloydb",
    deps,
  });

  // PSA address
  await deleteIfExists({
    label: `PSA address "${names.psaAddress}"`,
    url: `${COMPUTE_BASE}/projects/${opts.projectId}/global/addresses/${names.psaAddress}`,
    pollKind: "compute",
    deps,
  });

  // SSH firewall
  await deleteIfExists({
    label: `SSH firewall "${names.sshFirewall}"`,
    url: `${COMPUTE_BASE}/projects/${opts.projectId}/global/firewalls/${names.sshFirewall}`,
    pollKind: "compute",
    deps,
  });

  // Subnet
  await deleteIfExists({
    label: `subnet "${names.subnet}"`,
    url: `${COMPUTE_BASE}/projects/${opts.projectId}/regions/${opts.region}/subnetworks/${names.subnet}`,
    pollKind: "compute",
    deps,
  });

  // VPC network
  await deleteIfExists({
    label: `VPC network "${names.network}"`,
    url: `${COMPUTE_BASE}/projects/${opts.projectId}/global/networks/${names.network}`,
    pollKind: "compute",
    deps,
  });

  // TODO: remove VPC peering connection via Service Networking
  // (`services/servicenetworking.googleapis.com/connections/...`) — the
  // delete API requires the consumer-network parameter and follow-up
  // tenant-project cleanup which is environment-specific.
}

interface DeleteArgs {
  label: string;
  url: string;
  pollKind: "compute" | "alloydb";
  deps: DestroyDeps;
}

async function deleteIfExists(args: DeleteArgs): Promise<void> {
  let op: OperationRef | null;
  try {
    op = await googleJsonRequest<OperationRef>(
      args.url,
      { method: "DELETE" },
      args.deps,
    );
  } catch (e) {
    if (e instanceof Error && e.message.includes("404")) {
      args.deps.log(`${args.label} not found, skipping.`);
      return;
    }
    throw e;
  }
  args.deps.log(`Deleting ${args.label}…`);
  if (op?.selfLink) {
    await pollOperation(op.selfLink, args.deps);
  } else if (op?.name && args.pollKind === "alloydb") {
    await pollOperation(`${ALLOYDB_BASE}/${op.name}`, args.deps);
  }
  args.deps.log(`${args.label} deleted.`);
}
