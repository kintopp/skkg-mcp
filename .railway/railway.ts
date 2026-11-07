import { defineRailway, github, project, service, volume } from "railway/iac";

// The project is shared with other repos' services; the partial limits this file to its own.
export const partial = "skkg-mcp";

export default defineRailway(() => {
  // Holds the database, uploaded by hand (docs/deploy.md). Dropping this mount from the service detaches it.
  const skkgMcpVolume = volume("skkg-mcp-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "europe-west4-drams3a", sizeMB: 5000 });
  const mcp = service("skkg-mcp", {
    source: github("kintopp/skkg-mcp", { branch: "main", checkSuites: false }),
    // Only runtime files redeploy on push; notes, tests, scripts and the skill don't.
    build: { watchPatterns: ["src/**", "package.json", "package-lock.json"] },
    start: "node src/http.js",
    healthcheck: "/health",
    replicas: { "europe-west4-drams3a": 1 },
    // Railway counts the page cache of the database in the container's memory.
    deploy: { limitOverride: { containers: { cpu: 24, memoryBytes: 1000000000 } }, restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 3 },
    volumeMounts: { "/data": skkgMcpVolume },
  });
  return project("endearing-warmth", {
    variables: { managed: false },
    resources: [mcp, skkgMcpVolume],
  });
});
