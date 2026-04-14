import type { GoogleCredentialInfo } from "./types.ts";
import { googleJsonRequest } from "./http.ts";
import type { HttpDeps } from "./http.ts";

export type DoctorMode = "provision" | "deploy";

export interface DoctorConfig {
  mode: DoctorMode;
  projectId: string;
}

export interface DoctorResult {
  ok: boolean;
  projectId: string;
  projectNumber: string;
  missingPermissions: string[];
  disabledServices: string[];
  warnings: string[];
  credential: GoogleCredentialInfo;
}

export interface DoctorDeps extends HttpDeps {
  getCredentialInfo: () => GoogleCredentialInfo;
}

interface ProjectResponse {
  projectId?: string;
  projectNumber?: string;
  lifecycleState?: string;
  name?: string;
}

interface PermissionCheckResponse {
  permissions?: string[];
}

interface ServiceStateResponse {
  state?: string;
}

const REQUIRED_SERVICES = [
  "compute.googleapis.com",
  "alloydb.googleapis.com",
  "serviceusage.googleapis.com",
  "servicenetworking.googleapis.com",
  "cloudresourcemanager.googleapis.com",
] as const;

const PROVISION_PERMISSIONS = [
  "resourcemanager.projects.get",
  "serviceusage.services.get",
  "serviceusage.services.enable",
  "compute.networks.get",
  "compute.networks.create",
  "compute.subnetworks.get",
  "compute.subnetworks.create",
  "compute.firewalls.get",
  "compute.firewalls.create",
  "compute.globalAddresses.get",
  "compute.globalAddresses.create",
  "compute.instances.get",
  "compute.instances.create",
  "compute.instances.start",
  "compute.images.useReadOnly",
  "compute.subnetworks.use",
  "compute.subnetworks.useExternalIp",
  "compute.globalOperations.get",
  "compute.regionOperations.get",
  "compute.zoneOperations.get",
  "servicenetworking.services.addPeering",
  "alloydb.clusters.get",
  "alloydb.clusters.create",
  "alloydb.instances.get",
  "alloydb.instances.create",
  "alloydb.operations.get",
] as const;

const DEPLOY_PERMISSIONS = [
  "resourcemanager.projects.get",
  "compute.instances.get",
  "alloydb.clusters.get",
  "alloydb.instances.get",
] as const;

export async function runDoctor(
  config: DoctorConfig,
  deps: DoctorDeps,
): Promise<DoctorResult> {
  const credential = deps.getCredentialInfo();

  // Step 1: verify credential works
  await deps.getAccessToken();

  // Step 2: verify project exists and is ACTIVE
  const project = await googleJsonRequest<ProjectResponse>(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${config.projectId}`,
    {},
    deps,
  );

  if (!project?.projectId || !project.projectNumber) {
    throw new Error(
      `Unable to read project metadata for ${config.projectId}`,
    );
  }

  if (project.lifecycleState && project.lifecycleState !== "ACTIVE") {
    throw new Error(
      `Project ${config.projectId} is ${project.lifecycleState}; expected ACTIVE before provisioning`,
    );
  }

  const projectNumber = project.projectNumber;

  // Step 3: check IAM permissions
  const permissions =
    config.mode === "provision"
      ? [...PROVISION_PERMISSIONS]
      : [...DEPLOY_PERMISSIONS];

  const permCheckResponse = await googleJsonRequest<PermissionCheckResponse>(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${config.projectId}:testIamPermissions`,
    {
      method: "POST",
      body: JSON.stringify({ permissions }),
    },
    deps,
  );

  const grantedPermissions = new Set(permCheckResponse?.permissions ?? []);
  const missingPermissions = permissions.filter(
    (p) => !grantedPermissions.has(p),
  );

  // Step 4: check required services
  const disabledServices: string[] = [];
  for (const service of REQUIRED_SERVICES) {
    const state = await googleJsonRequest<ServiceStateResponse>(
      `https://serviceusage.googleapis.com/v1/projects/${projectNumber}/services/${service}`,
      {},
      deps,
    );
    if (state?.state !== "ENABLED") {
      disabledServices.push(service);
    }
  }

  const warnings: string[] = [];
  if (
    config.mode === "provision" &&
    disabledServices.length > 0 &&
    !grantedPermissions.has("serviceusage.services.enable")
  ) {
    warnings.push(
      `Required APIs are disabled but the credential cannot enable them: ${disabledServices.join(", ")}`,
    );
  }

  const ok =
    missingPermissions.length === 0 &&
    (config.mode !== "provision" ||
      disabledServices.length === 0 ||
      grantedPermissions.has("serviceusage.services.enable"));

  return {
    ok,
    projectId: config.projectId,
    projectNumber,
    missingPermissions,
    disabledServices,
    warnings,
    credential,
  };
}
