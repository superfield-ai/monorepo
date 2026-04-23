export interface AuditCapability {
  id: string;
  name: string;
  description: string;
  /** Hints passed to the agent about what patterns and files to look for. */
  lookFor: string[];
  /** Related blueprint rule IDs for cross-linking in generated issues. */
  blueprintRuleIds?: string[];
}

export const CAPABILITIES: readonly AuditCapability[] = [
  {
    id: "property-graph-db",
    name: "Property Graph Database",
    description:
      "The app uses a property graph database (Neo4j, ArangoDB, Dgraph, or similar) " +
      "with typed nodes, edges, and relationship queries as its primary data model.",
    lookFor: [
      "neo4j driver or client import (neo4j-driver, @neo4j/graphql)",
      "arangodb or arangojs import",
      "dgraph client",
      "graph schema definitions: node types, edge types, relationship properties",
      "Cypher queries or AQL graph traversal queries in the service layer",
      "relationship-aware data access (not just foreign keys in a relational DB)",
    ],
  },
  {
    id: "authentication",
    name: "Authentication",
    description:
      "The app has complete authentication: user identity, session or token management, " +
      "protected routes enforced by middleware, and logout.",
    lookFor: [
      "session middleware or cookie-session library",
      "JWT creation and verification (jsonwebtoken, jose, etc.)",
      "OAuth or third-party auth provider integration",
      "authentication middleware applied to protected route groups",
      "login and logout HTTP handlers",
      "user identity accessible in request context throughout the app",
    ],
  },
  {
    id: "error-tracing",
    name: "Full Error Tracing to DB",
    description:
      "All application errors are captured with full context (stack trace, request metadata, " +
      "user identity) and persisted to a database table or collection — not only logged to stdout.",
    lookFor: [
      "error model or schema in the database (table, collection, or node type)",
      "global error handler or middleware that writes errors to the DB",
      "error records containing: stack trace, user ID or session, request path and method",
      "API or query to retrieve stored errors (admin view, analytics)",
      "correlation IDs linking errors to specific requests or sessions",
    ],
  },
  {
    id: "pwa",
    name: "Progressive Web App",
    description:
      "The app is a fully installable PWA: web app manifest, service worker with a defined " +
      "offline strategy, and a responsive installable shell.",
    lookFor: [
      "manifest.json or site.webmanifest with name, icons, start_url, display fields",
      "service worker registration call in the app entry point",
      "service worker file with a fetch event handler and cache strategy (cache-first, network-first, etc.)",
      "offline fallback page or cached shell for offline use",
      "meta viewport and theme-color tags in HTML",
    ],
  },
];

export function getCapability(id: string): AuditCapability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}
