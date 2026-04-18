import { googleJsonRequest } from "./http.js";
import type { HttpDeps } from "./http.js";
import { pollOperation } from "./operations.js";

export interface ProvisionConfig {
  projectId: string;
  region: string;
  zone: string;
  networkName: string;
  subnetName: string;
  subnetCidr: string;
  podRangeName: string;
  podCidr: string;
  serviceRangeName: string;
  serviceCidr: string;
  sshFirewallName: string;
  appFirewallName: string;
  appPort: string;
  psaAddressName: string;
  psaAddressCidr: string;
  alloydbClusterId: string;
  alloydbInstanceId: string;
  alloydbPassword: string;
  vmName: string;
  vmMachineType: string;
  vmDiskSizeGb: number;
  vmStartupScript: string;
  talosMode?: boolean;
}

export interface ProvisionDeps extends HttpDeps {
  log: (msg: string) => void;
}

interface OperationRef {
  name?: string;
  selfLink?: string;
}

/**
 * Check if a resource exists by GET-ing its URL.
 * Returns true if it exists (2xx), false if 404, throws on other errors.
 */
async function exists(url: string, deps: HttpDeps): Promise<boolean> {
  try {
    await googleJsonRequest(url, {}, deps);
    return true;
  } catch (e) {
    if (e instanceof Error && e.message.includes("404")) {
      return false;
    }
    throw e;
  }
}

/**
 * Extract the poll URL from an operation response.
 * AlloyDB ops use `name` (relative), Compute ops use `selfLink`.
 */
function alloydbPollUrl(opName: string): string {
  return `https://alloydb.googleapis.com/v1/${opName}`;
}

export async function runProvision(
  config: ProvisionConfig,
  deps: ProvisionDeps,
): Promise<void> {
  const {
    projectId,
    region,
    zone,
    networkName,
    subnetName,
    subnetCidr,
    podRangeName,
    podCidr,
    serviceRangeName,
    serviceCidr,
    sshFirewallName,
    appFirewallName,
    appPort,
    psaAddressName,
    alloydbClusterId,
    alloydbInstanceId,
    alloydbPassword,
    vmName,
    vmMachineType,
    vmDiskSizeGb,
    vmStartupScript,
  } = config;

  const computeBase = "https://www.googleapis.com/compute/v1";
  const alloydbBase = "https://alloydb.googleapis.com/v1";
  const serviceNetBase = "https://servicenetworking.googleapis.com";

  // ── 1. VPC Network ──────────────────────────────────────────────────────────
  const networkUrl = `${computeBase}/projects/${projectId}/global/networks/${networkName}`;
  if (await exists(networkUrl, deps)) {
    deps.log(`VPC network "${networkName}" already exists, skipping.`);
  } else {
    deps.log(`Creating VPC network "${networkName}"…`);
    const op = await googleJsonRequest<OperationRef>(
      `${computeBase}/projects/${projectId}/global/networks`,
      {
        method: "POST",
        body: JSON.stringify({
          name: networkName,
          autoCreateSubnetworks: false,
        }),
      },
      deps,
    );
    if (op?.selfLink) {
      await pollOperation(op.selfLink, deps);
    }
    deps.log(`VPC network "${networkName}" created.`);
  }

  // ── 2. Subnet ────────────────────────────────────────────────────────────────
  const subnetUrl = `${computeBase}/projects/${projectId}/regions/${region}/subnetworks/${subnetName}`;
  if (await exists(subnetUrl, deps)) {
    deps.log(`Subnet "${subnetName}" already exists, skipping.`);
  } else {
    deps.log(`Creating subnet "${subnetName}"…`);
    const op = await googleJsonRequest<OperationRef>(
      `${computeBase}/projects/${projectId}/regions/${region}/subnetworks`,
      {
        method: "POST",
        body: JSON.stringify({
          name: subnetName,
          network: networkUrl,
          ipCidrRange: subnetCidr,
          region,
          secondaryIpRanges: [
            { rangeName: podRangeName, ipCidrRange: podCidr },
            { rangeName: serviceRangeName, ipCidrRange: serviceCidr },
          ],
        }),
      },
      deps,
    );
    if (op?.selfLink) {
      await pollOperation(op.selfLink, deps);
    }
    deps.log(`Subnet "${subnetName}" created.`);
  }

  // ── 3. SSH Firewall rule ─────────────────────────────────────────────────────
  const sshFwUrl = `${computeBase}/projects/${projectId}/global/firewalls/${sshFirewallName}`;
  if (await exists(sshFwUrl, deps)) {
    deps.log(
      `SSH firewall rule "${sshFirewallName}" already exists, skipping.`,
    );
  } else {
    deps.log(`Creating SSH firewall rule "${sshFirewallName}"…`);
    const op = await googleJsonRequest<OperationRef>(
      `${computeBase}/projects/${projectId}/global/firewalls`,
      {
        method: "POST",
        body: JSON.stringify({
          name: sshFirewallName,
          network: networkUrl,
          allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
          sourceRanges: ["0.0.0.0/0"],
        }),
      },
      deps,
    );
    if (op?.selfLink) {
      await pollOperation(op.selfLink, deps);
    }
    deps.log(`SSH firewall rule "${sshFirewallName}" created.`);
  }

  // ── 4. App Firewall rule ─────────────────────────────────────────────────────
  const appFwUrl = `${computeBase}/projects/${projectId}/global/firewalls/${appFirewallName}`;
  if (await exists(appFwUrl, deps)) {
    deps.log(
      `App firewall rule "${appFirewallName}" already exists, skipping.`,
    );
  } else {
    deps.log(`Creating app firewall rule "${appFirewallName}"…`);
    const op = await googleJsonRequest<OperationRef>(
      `${computeBase}/projects/${projectId}/global/firewalls`,
      {
        method: "POST",
        body: JSON.stringify({
          name: appFirewallName,
          network: networkUrl,
          allowed: [{ IPProtocol: "tcp", ports: [appPort] }],
          sourceRanges: ["0.0.0.0/0"],
        }),
      },
      deps,
    );
    if (op?.selfLink) {
      await pollOperation(op.selfLink, deps);
    }
    deps.log(`App firewall rule "${appFirewallName}" created.`);
  }

  // ── 5. PSA global address ────────────────────────────────────────────────────
  const psaAddressUrl = `${computeBase}/projects/${projectId}/global/addresses/${psaAddressName}`;
  if (await exists(psaAddressUrl, deps)) {
    deps.log(`PSA address "${psaAddressName}" already exists, skipping.`);
  } else {
    deps.log(`Creating PSA global address "${psaAddressName}"…`);
    const op = await googleJsonRequest<OperationRef>(
      `${computeBase}/projects/${projectId}/global/addresses`,
      {
        method: "POST",
        body: JSON.stringify({
          name: psaAddressName,
          addressType: "INTERNAL",
          purpose: "VPC_PEERING",
          network: networkUrl,
          prefixLength: 16,
        }),
      },
      deps,
    );
    if (op?.selfLink) {
      await pollOperation(op.selfLink, deps);
    }
    deps.log(`PSA address "${psaAddressName}" created.`);
  }

  // ── 6. VPC Peering (Service Networking) ─────────────────────────────────────
  // We need the project number for the network resource path in Service Networking.
  // We use the projectId as projectNumber here since the caller should pass numeric
  // projectNumber as projectId when calling servicenetworking, but we follow the
  // spec which says to use projectId in the network path.
  const snConnectionsUrl = `${serviceNetBase}/v1/services/servicenetworking.googleapis.com/connections`;
  const networkResourcePath = `projects/${projectId}/global/networks/${networkName}`;
  const snListUrl = `${snConnectionsUrl}?network=${networkResourcePath}`;

  const peeringExists = await (async () => {
    try {
      const result = await googleJsonRequest<{ connections?: unknown[] }>(
        snListUrl,
        {},
        deps,
      );
      return (result?.connections?.length ?? 0) > 0;
    } catch (e) {
      if (e instanceof Error && e.message.includes("404")) {
        return false;
      }
      throw e;
    }
  })();

  if (peeringExists) {
    deps.log(`VPC peering for "${networkName}" already exists, skipping.`);
  } else {
    deps.log(`Creating VPC peering (Service Networking) for "${networkName}"…`);
    const op = await googleJsonRequest<OperationRef>(
      snConnectionsUrl,
      {
        method: "POST",
        body: JSON.stringify({
          network: networkResourcePath,
          reservedPeeringRanges: [psaAddressName],
          service: "servicenetworking.googleapis.com",
        }),
      },
      deps,
    );
    // Service Networking returns an operation with `name`
    if (op?.name) {
      const pollUrl = op.name.startsWith("http")
        ? op.name
        : `${serviceNetBase}/v1/${op.name}`;
      await pollOperation(pollUrl, deps);
    } else if (op?.selfLink) {
      await pollOperation(op.selfLink, deps);
    }
    deps.log(`VPC peering created.`);
  }

  // ── 7. AlloyDB Cluster ───────────────────────────────────────────────────────
  const alloydbClusterUrl = `${alloydbBase}/projects/${projectId}/locations/${region}/clusters/${alloydbClusterId}`;
  if (await exists(alloydbClusterUrl, deps)) {
    deps.log(`AlloyDB cluster "${alloydbClusterId}" already exists, skipping.`);
  } else {
    deps.log(`Creating AlloyDB cluster "${alloydbClusterId}"…`);
    const op = await googleJsonRequest<OperationRef>(
      `${alloydbBase}/projects/${projectId}/locations/${region}/clusters?clusterId=${alloydbClusterId}`,
      {
        method: "POST",
        body: JSON.stringify({
          databaseVersion: "POSTGRES_15",
          network: `projects/${projectId}/global/networks/${networkName}`,
          initialUser: {
            password: alloydbPassword,
          },
        }),
      },
      deps,
    );
    if (op?.name) {
      await pollOperation(alloydbPollUrl(op.name), deps);
    }
    deps.log(`AlloyDB cluster "${alloydbClusterId}" created.`);
  }

  // ── 8. AlloyDB Primary Instance ───────────────────────────────────────────────
  const alloydbInstanceUrl = `${alloydbBase}/projects/${projectId}/locations/${region}/clusters/${alloydbClusterId}/instances/${alloydbInstanceId}`;
  if (await exists(alloydbInstanceUrl, deps)) {
    deps.log(
      `AlloyDB instance "${alloydbInstanceId}" already exists, skipping.`,
    );
  } else {
    deps.log(`Creating AlloyDB primary instance "${alloydbInstanceId}"…`);
    const op = await googleJsonRequest<OperationRef>(
      `${alloydbBase}/projects/${projectId}/locations/${region}/clusters/${alloydbClusterId}/instances?instanceId=${alloydbInstanceId}`,
      {
        method: "POST",
        body: JSON.stringify({
          instanceType: "PRIMARY",
          machineConfig: { cpuCount: 2 },
        }),
      },
      deps,
    );
    if (op?.name) {
      await pollOperation(alloydbPollUrl(op.name), deps);
    }
    deps.log(`AlloyDB instance "${alloydbInstanceId}" created.`);
  }

  // ── 9. Compute Engine VM ─────────────────────────────────────────────────────
  const vmUrl = `${computeBase}/projects/${projectId}/zones/${zone}/instances/${vmName}`;
  if (await exists(vmUrl, deps)) {
    deps.log(`VM "${vmName}" already exists, skipping.`);
  } else {
    deps.log(`Creating VM "${vmName}"…`);
    const op = await googleJsonRequest<OperationRef>(
      `${computeBase}/projects/${projectId}/zones/${zone}/instances`,
      {
        method: "POST",
        body: JSON.stringify({
          name: vmName,
          machineType: `zones/${zone}/machineTypes/${vmMachineType}`,
          networkInterfaces: [
            {
              network: networkUrl,
              subnetwork: subnetUrl,
              accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
            },
          ],
          disks: [
            {
              boot: true,
              autoDelete: true,
              initializeParams: {
                sourceImage:
                  "projects/debian-cloud/global/images/family/debian-12",
                diskSizeGb: String(vmDiskSizeGb),
              },
            },
          ],
          metadata: {
            items: [{ key: "startup-script", value: vmStartupScript }],
          },
        }),
      },
      deps,
    );
    if (op?.selfLink) {
      await pollOperation(op.selfLink, deps);
    }
    deps.log(`VM "${vmName}" created.`);
  }
}
