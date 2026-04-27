/**
 * @file manifest-parser.ts
 *
 * Parses Kubernetes YAML manifests to discover resources and secret references.
 *
 * This module works with raw YAML text — it does not shell out to kubectl.
 * The k8s manifests are read directly from the product's k8s directory.
 *
 * Uses a simple line-based parser (no YAML library dependency). This works
 * because k8s manifests follow a predictable structure with top-level
 * `kind:` and `metadata:` → `name:` fields.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { K8sResource, SecretSpec } from "./types";

/**
 * Read all YAML files from a directory.
 *
 * Returns an array of { filename, content } for every .yaml file found.
 * No filtering is applied here — callers that need to skip certain files
 * (e.g. example files) filter the result themselves.
 */
function readYamlFiles(
  k8sDir: string,
): { filename: string; content: string }[] {
  const files = readdirSync(k8sDir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();
  return files.map((filename) => ({
    filename,
    content: readFileSync(join(k8sDir, filename), "utf-8"),
  }));
}

/**
 * Split a YAML file into individual documents on `---` separators.
 */
function splitDocuments(content: string): string[] {
  return content.split(/^---\s*$/m).filter((doc) => doc.trim().length > 0);
}

/**
 * Discover all Kubernetes resources defined in the product's k8s directory.
 *
 * Reads YAML files directly — does not require kubectl or a running cluster.
 *
 * @param k8sDir  Absolute path to the directory containing k8s YAML files.
 * @returns       List of resources with their kind and name.
 */
export function discoverResources(k8sDir: string): K8sResource[] {
  const resources: K8sResource[] = [];

  for (const { content } of readYamlFiles(k8sDir)) {
    for (const doc of splitDocuments(content)) {
      let kind: string | null = null;
      let name: string | null = null;
      let inMetadata = false;

      for (const line of doc.split("\n")) {
        // Top-level kind field (no leading whitespace).
        const kindMatch = line.match(/^kind:\s*(.+)/);
        if (kindMatch) {
          kind = kindMatch[1].trim();
          continue;
        }

        // Top-level metadata block.
        if (line === "metadata:" || line === "metadata: ") {
          inMetadata = true;
          continue;
        }

        // name: inside the first metadata block (indented).
        if (inMetadata) {
          const nameMatch = line.match(/^\s+name:\s*(.+)/);
          if (nameMatch) {
            name = nameMatch[1].trim();
            inMetadata = false;
            continue;
          }
          // Non-indented line ends the metadata block.
          if (
            line.length > 0 &&
            !line.startsWith(" ") &&
            !line.startsWith("#")
          ) {
            inMetadata = false;
          }
        }
      }

      if (kind && name) {
        resources.push({ kind, name });
      }
    }
  }

  return resources;
}

/**
 * Discover all Secret references in the product's k8s manifests.
 *
 * Scans for `secretKeyRef:` blocks and extracts the secret name + key.
 * Groups by secret name, collecting all referenced keys.
 *
 * @param k8sDir  Absolute path to the k8s YAML directory.
 * @returns       List of secret specs with keys but empty values.
 */
export function discoverSecretRefs(k8sDir: string): SecretSpec[] {
  const secretMap = new Map<string, Set<string>>();

  for (const { content } of readYamlFiles(k8sDir)) {
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (!/secretKeyRef:/.test(lines[i])) continue;

      // Look ahead up to 5 lines for name: and key: fields.
      let secretName: string | null = null;
      let secretKey: string | null = null;

      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const nameMatch = lines[j].match(/^\s+name:\s*(\S+)/);
        const keyMatch = lines[j].match(/^\s+key:\s*(\S+)/);
        if (nameMatch && !secretName) secretName = nameMatch[1];
        if (keyMatch && !secretKey) secretKey = keyMatch[1];
      }

      if (secretName && secretKey) {
        let entry = secretMap.get(secretName);
        if (!entry) {
          entry = new Set();
          secretMap.set(secretName, entry);
        }
        entry.add(secretKey);
      }
    }
  }

  return Array.from(secretMap.entries()).map(([name, keys]) => ({
    name,
    literals: Object.fromEntries([...keys].map((k) => [k, ""])),
  }));
}

/**
 * Discover the port exposed by a named Kubernetes Service.
 *
 * Reads YAML files, finds a Service whose `metadata.name` matches
 * `serviceName`, and returns the first `spec.ports[].port` value.
 *
 * @param k8sDir       Absolute path to the k8s YAML directory.
 * @param serviceName  The Service name to look up (e.g. "web").
 * @returns            The service port number, or null if not found.
 */
export function discoverServicePort(
  k8sDir: string,
  serviceName: string,
): number | null {
  for (const { content } of readYamlFiles(k8sDir)) {
    for (const doc of splitDocuments(content)) {
      let kind: string | null = null;
      let name: string | null = null;
      let inMetadata = false;
      let inSpec = false;
      let inPorts = false;

      for (const line of doc.split("\n")) {
        // Top-level kind field.
        const kindMatch = line.match(/^kind:\s*(.+)/);
        if (kindMatch) {
          kind = kindMatch[1].trim();
          inMetadata = false;
          inSpec = false;
          inPorts = false;
          continue;
        }
        // Top-level metadata block.
        if (/^metadata:\s*$/.test(line)) {
          inMetadata = true;
          inSpec = false;
          inPorts = false;
          continue;
        }
        // Top-level spec block.
        if (/^spec:\s*$/.test(line)) {
          inSpec = true;
          inMetadata = false;
          inPorts = false;
          continue;
        }
        // Any other non-indented key ends the current block.
        if (/^\w/.test(line) && line.includes(":")) {
          inMetadata = false;
          inSpec = false;
          inPorts = false;
        }

        if (inMetadata) {
          const nameMatch = line.match(/^\s{2}name:\s*(.+)/);
          if (nameMatch) name = nameMatch[1].trim();
        }

        if (inSpec && kind === "Service" && name === serviceName) {
          if (/^\s{2}ports:\s*$/.test(line)) {
            inPorts = true;
            continue;
          }
          if (inPorts) {
            const portMatch = line.match(/^\s+port:\s*(\d+)/);
            if (portMatch) return parseInt(portMatch[1], 10);
            // Another spec key at the ports level ends the section.
            if (/^\s{2}\w/.test(line)) inPorts = false;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Discover all container image references in the product's k8s manifests.
 *
 * Looks for `image:` fields. Skips commented-out lines.
 *
 * @param k8sDir  Absolute path to the k8s YAML directory.
 * @returns       List of unique image strings.
 */
export function discoverImages(k8sDir: string): string[] {
  const images = new Set<string>();

  for (const { content } of readYamlFiles(k8sDir)) {
    for (const line of content.split("\n")) {
      // Skip comments.
      if (line.trimStart().startsWith("#")) continue;
      // Match `image: <ref>` with any leading whitespace (container spec).
      const match = line.match(/^\s+image:\s*(\S+)/);
      if (match) images.add(match[1]);
    }
  }

  return [...images];
}
