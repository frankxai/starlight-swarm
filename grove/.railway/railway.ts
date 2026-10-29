// Railway IaC for the Grove Hub. Named partial, so it only manages these two resources and
// never touches anything else in the Railway project (for example the CI runner services).
//
// Three phases, chosen with GROVE_IAC_PHASE when you plan or apply (see RUNBOOK.md step 3):
//   bootstrap  creates the service and volume with no secret variables declared yet
//   enroll     declares every secret, including the one-off Tailscale key, as preserve()
//   steady     the default; same as enroll without TS_AUTHKEY, which you delete after first boot
import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export const partial = "grove-hub";

type Phase = "bootstrap" | "enroll" | "steady";

const SECRETS = [
  "GROVE_PUBLIC_URL",
  "GROVE_ADMIN_EMAIL",
  "SCION_SERVER_SESSION_SECRET",
  "SCION_SERVER_OAUTH_WEB_GITHUB_CLIENTID",
  "SCION_SERVER_OAUTH_WEB_GITHUB_CLIENTSECRET",
  "SCION_SERVER_OAUTH_CLI_GITHUB_CLIENTID",
  "SCION_SERVER_OAUTH_CLI_GITHUB_CLIENTSECRET",
] as const;

function phase(): Phase {
  const value = process.env.GROVE_IAC_PHASE ?? "steady";
  if (value === "bootstrap" || value === "enroll" || value === "steady") return value;
  throw new Error(`GROVE_IAC_PHASE must be bootstrap, enroll or steady, got "${value}"`);
}

export default defineRailway(() => {
  const current = phase();

  const secretEnv: Record<string, ReturnType<typeof preserve>> = {};
  if (current !== "bootstrap") {
    for (const name of SECRETS) secretEnv[name] = preserve();
    if (current === "enroll") secretEnv.TS_AUTHKEY = preserve();
  }

  const data = volume("grove-hub-data", {
    region: "europe-west4",
    sizeMB: 5120,
  });

  const hub = service("grove-hub", {
    source: github("frankxai/starlight-swarm", { branch: "main", rootDirectory: "grove/hub" }),
    replicas: { "europe-west4": 1 },
    volumeMounts: { "/data": data },
    env: {
      TS_HOSTNAME: "grove-hub",
      TS_TAGS: "tag:grove-hub",
      GROVE_DATA_DIR: "/data",
      ...secretEnv,
    },
  });

  return project("starlight-grove", { resources: [hub, data] });
});
