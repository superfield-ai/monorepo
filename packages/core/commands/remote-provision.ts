import { execFile, spawn } from "node:child_process";

export interface RemoteProvisionConfig {
  host: string;
  user: string;
  keyPath?: string;
}

export interface RemoteProvisionResult {
  deployPublicKey: string;
}

export interface RemoteProvisionDeps {
  sshRun?: (config: RemoteProvisionConfig, command: string) => Promise<void>;
  sshCapture?: (
    config: RemoteProvisionConfig,
    command: string,
  ) => Promise<string>;
}

export async function runRemoteProvision(
  config: RemoteProvisionConfig,
  deps: RemoteProvisionDeps = {},
): Promise<RemoteProvisionResult> {
  const sshRun = deps.sshRun ?? defaultSshRun;
  const sshCapture = deps.sshCapture ?? defaultSshCapture;

  console.log(`\n==> Connecting to ${config.user}@${config.host}`);

  console.log("\n[1/5] Verifying SSH connectivity...");
  await sshRun(config, 'echo "SSH connection OK"');

  console.log("\n[2/5] Checking operating system...");
  const osRelease = await sshCapture(
    config,
    "cat /etc/os-release 2>/dev/null || true",
  );
  if (
    !osRelease.toLowerCase().includes("debian") &&
    !osRelease.toLowerCase().includes("ubuntu")
  ) {
    throw new Error(
      `Remote host does not appear to be Debian or Ubuntu.\n  Detected: ${osRelease.split("\n")[0]}`,
    );
  }

  console.log("\n[3/5] Installing docker.io and kubectl...");
  await sshRun(
    config,
    `
set -e
sudo apt-get update -q
if ! command -v docker &>/dev/null; then
  sudo apt-get install -y docker.io
  sudo systemctl enable --now docker
else
  echo "docker already installed"
fi
if ! groups "$USER" | grep -qw docker; then
  sudo usermod -aG docker "$USER"
  echo "Added $USER to docker group — re-login required for group to take effect"
fi
if ! command -v kubectl &>/dev/null; then
  curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" -o /tmp/kubectl
  sudo install -o root -g root -m 0755 /tmp/kubectl /usr/local/bin/kubectl
  rm /tmp/kubectl
  echo "kubectl installed: $(kubectl version --client --short 2>/dev/null || kubectl version --client 2>/dev/null | head -1)"
else
  echo "kubectl already installed"
fi
`.trim(),
  );

  console.log("\n[4/5] Installing k3d...");
  await sshRun(
    config,
    `
if command -v k3d &>/dev/null; then
  echo "k3d already installed: $(k3d version | head -1)"
else
  curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
fi
`.trim(),
  );

  console.log("\n[5/5] Generating deploy key...");
  await sshRun(
    config,
    `
mkdir -p ~/.ssh
chmod 700 ~/.ssh
if [ -f ~/.ssh/superfield_deploy ]; then
  echo "Deploy key already exists at ~/.ssh/superfield_deploy"
else
  ssh-keygen -t ed25519 -C "superfield-deploy@$(hostname)" -f ~/.ssh/superfield_deploy -N ""
  echo "Deploy key generated."
fi
`.trim(),
  );

  const deployPublicKey = await sshCapture(
    config,
    "cat ~/.ssh/superfield_deploy.pub",
  );

  return { deployPublicKey };
}

function buildSshArgs(
  config: RemoteProvisionConfig,
  command: string,
): string[] {
  const args = ["-o", "StrictHostKeyChecking=accept-new"];
  if (config.keyPath) args.push("-i", config.keyPath);
  args.push(`${config.user}@${config.host}`);
  args.push(command);
  return args;
}

function defaultSshRun(
  config: RemoteProvisionConfig,
  command: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", buildSshArgs(config, command), {
      stdio: "inherit",
    });
    child.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            '"ssh" not found on PATH. Install OpenSSH client (sudo apt install openssh-client).',
          ),
        );
      } else {
        reject(err);
      }
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SSH command failed with exit code ${code}`));
    });
  });
}

function defaultSshCapture(
  config: RemoteProvisionConfig,
  command: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ssh", buildSshArgs(config, command), (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}
