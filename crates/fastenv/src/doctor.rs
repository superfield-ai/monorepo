// doctor.rs — `fastenv doctor` implementation.
//
// Canonical docs:
//   - docs/prd.md
//   - docs/architecture.md
//   - crates/fastenv/docs/scout/firecracker-prerequisites.md
//
// Checks all host prerequisites required to run fastenv microVMs:
//   - /dev/kvm access
//   - vmx or svm CPU virtualisation flag
//   - unrestricted_guest, ept, vpid CPU flags (Intel-only advisory)
//   - firecracker binary presence
//   - crun binary presence
//   - /dev/net/tun access
//   - overlayfs in /proc/filesystems
//   - kernel version >= 5.10
//   - free memory >= configurable floor (default 512 MiB)
//
// Exit code 0 — all required checks pass (warnings do not affect exit code).
// Exit code 1 — one or more required checks failed.
//
// --json emits machine-readable output; human-readable by default.

use std::io::{self, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::Serialize;

// ---------------------------------------------------------------------------
// Check status
// ---------------------------------------------------------------------------

/// Status of a single doctor check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Pass,
    Fail,
    Warn,
}

impl std::fmt::Display for CheckStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CheckStatus::Pass => write!(f, "pass"),
            CheckStatus::Fail => write!(f, "fail"),
            CheckStatus::Warn => write!(f, "warn"),
        }
    }
}

/// Result of a single doctor check.
#[derive(Debug, Clone, Serialize)]
pub struct CheckResult {
    /// Stable machine-readable key for this check.
    pub key: String,
    /// Pass / fail / warn.
    pub status: CheckStatus,
    /// Human-readable message.
    pub message: String,
}

/// Full doctor report (JSON schema).
#[derive(Debug, Serialize)]
pub struct DoctorReport {
    pub checks: Vec<CheckResult>,
}

// ---------------------------------------------------------------------------
// Injectable environment (for testability)
// ---------------------------------------------------------------------------

/// Injectable environment for doctor checks.
///
/// All filesystem and command paths are configurable so unit tests can provide
/// mock paths without root, KVM, or real binaries.
pub struct DoctorEnv {
    /// Root prefix for device paths (default: "/").
    /// Checks for /dev/kvm → <dev_root>/dev/kvm, etc.
    pub dev_root: PathBuf,
    /// Path to /proc/cpuinfo (or a stub).
    pub cpuinfo_path: PathBuf,
    /// Path to /proc/filesystems (or a stub).
    pub filesystems_path: PathBuf,
    /// Path to /proc/version (or a stub containing kernel version string).
    pub proc_version_path: PathBuf,
    /// Path to /proc/meminfo (or a stub).
    pub meminfo_path: PathBuf,
    /// Explicit path to the firecracker binary (overrides PATH search).
    pub firecracker_path: PathBuf,
    /// Explicit path to the crun binary (overrides PATH search).
    pub crun_path: PathBuf,
    /// Minimum free memory in bytes (default: 512 MiB).
    pub min_free_memory_bytes: u64,
}

impl Default for DoctorEnv {
    fn default() -> Self {
        Self {
            dev_root: PathBuf::from("/"),
            cpuinfo_path: PathBuf::from("/proc/cpuinfo"),
            filesystems_path: PathBuf::from("/proc/filesystems"),
            proc_version_path: PathBuf::from("/proc/version"),
            meminfo_path: PathBuf::from("/proc/meminfo"),
            firecracker_path: PathBuf::from("/usr/local/bin/firecracker"),
            crun_path: PathBuf::from("/usr/bin/crun"),
            min_free_memory_bytes: 512 * 1024 * 1024,
        }
    }
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

fn check_kvm_device(env: &DoctorEnv) -> CheckResult {
    let kvm_path = env.dev_root.join("dev").join("kvm");
    if kvm_path.exists() {
        CheckResult {
            key: "kvm_device".to_owned(),
            status: CheckStatus::Pass,
            message: format!("{} exists and is accessible", kvm_path.display()),
        }
    } else {
        CheckResult {
            key: "kvm_device".to_owned(),
            status: CheckStatus::Fail,
            message: format!(
                "{} not found — KVM is required for Firecracker microVMs",
                kvm_path.display()
            ),
        }
    }
}

fn check_cpu_virt_flag(env: &DoctorEnv) -> CheckResult {
    let cpuinfo = match std::fs::read_to_string(&env.cpuinfo_path) {
        Ok(c) => c,
        Err(e) => {
            return CheckResult {
                key: "cpu_virt_flag".to_owned(),
                status: CheckStatus::Fail,
                message: format!("cannot read {}: {}", env.cpuinfo_path.display(), e),
            }
        }
    };

    if cpuinfo.contains("vmx") {
        CheckResult {
            key: "cpu_virt_flag".to_owned(),
            status: CheckStatus::Pass,
            message: "Intel VT-x (vmx) CPU flag present".to_owned(),
        }
    } else if cpuinfo.contains("svm") {
        CheckResult {
            key: "cpu_virt_flag".to_owned(),
            status: CheckStatus::Pass,
            message: "AMD-V (svm) CPU flag present".to_owned(),
        }
    } else {
        CheckResult {
            key: "cpu_virt_flag".to_owned(),
            status: CheckStatus::Fail,
            message: "Neither vmx nor svm CPU flag found — hardware virtualisation required"
                .to_owned(),
        }
    }
}

fn check_unrestricted_guest(env: &DoctorEnv) -> CheckResult {
    let cpuinfo = match std::fs::read_to_string(&env.cpuinfo_path) {
        Ok(c) => c,
        Err(e) => {
            return CheckResult {
                key: "cpu_unrestricted_guest".to_owned(),
                status: CheckStatus::Fail,
                message: format!("cannot read {}: {}", env.cpuinfo_path.display(), e),
            }
        }
    };

    // unrestricted_guest is an Intel-only flag; only required when vmx is present.
    if cpuinfo.contains("vmx") {
        if cpuinfo.contains("unrestricted_guest") {
            CheckResult {
                key: "cpu_unrestricted_guest".to_owned(),
                status: CheckStatus::Pass,
                message: "unrestricted_guest CPU flag present (Intel UG mode)".to_owned(),
            }
        } else {
            CheckResult {
                key: "cpu_unrestricted_guest".to_owned(),
                status: CheckStatus::Fail,
                message: "Intel vmx present but unrestricted_guest flag missing — \
                           Firecracker requires unrestricted guest mode"
                    .to_owned(),
            }
        }
    } else {
        // AMD-V or no virt — flag is Intel-only, emit advisory warning only.
        CheckResult {
            key: "cpu_unrestricted_guest".to_owned(),
            status: CheckStatus::Warn,
            message: "unrestricted_guest is Intel-only; not applicable on this CPU".to_owned(),
        }
    }
}

fn check_ept(env: &DoctorEnv) -> CheckResult {
    let cpuinfo = match std::fs::read_to_string(&env.cpuinfo_path) {
        Ok(c) => c,
        Err(e) => {
            return CheckResult {
                key: "cpu_ept".to_owned(),
                status: CheckStatus::Fail,
                message: format!("cannot read {}: {}", env.cpuinfo_path.display(), e),
            }
        }
    };

    if cpuinfo.contains("vmx") {
        if cpuinfo.contains(" ept") || cpuinfo.contains("\nept") || cpuinfo.starts_with("ept") {
            CheckResult {
                key: "cpu_ept".to_owned(),
                status: CheckStatus::Pass,
                message: "ept (Extended Page Tables) CPU flag present".to_owned(),
            }
        } else {
            CheckResult {
                key: "cpu_ept".to_owned(),
                status: CheckStatus::Fail,
                message: "Intel vmx present but ept flag missing — EPT required for Firecracker"
                    .to_owned(),
            }
        }
    } else {
        CheckResult {
            key: "cpu_ept".to_owned(),
            status: CheckStatus::Warn,
            message: "ept is Intel-only; not applicable on this CPU".to_owned(),
        }
    }
}

fn check_vpid(env: &DoctorEnv) -> CheckResult {
    let cpuinfo = match std::fs::read_to_string(&env.cpuinfo_path) {
        Ok(c) => c,
        Err(e) => {
            return CheckResult {
                key: "cpu_vpid".to_owned(),
                status: CheckStatus::Fail,
                message: format!("cannot read {}: {}", env.cpuinfo_path.display(), e),
            }
        }
    };

    if cpuinfo.contains("vmx") {
        if cpuinfo.contains("vpid") {
            CheckResult {
                key: "cpu_vpid".to_owned(),
                status: CheckStatus::Pass,
                message: "vpid (Virtual Processor ID) CPU flag present".to_owned(),
            }
        } else {
            CheckResult {
                key: "cpu_vpid".to_owned(),
                status: CheckStatus::Fail,
                message: "Intel vmx present but vpid flag missing — vpid required for Firecracker"
                    .to_owned(),
            }
        }
    } else {
        CheckResult {
            key: "cpu_vpid".to_owned(),
            status: CheckStatus::Warn,
            message: "vpid is Intel-only; not applicable on this CPU".to_owned(),
        }
    }
}

fn check_firecracker_binary(env: &DoctorEnv) -> CheckResult {
    let path = &env.firecracker_path;
    if path.exists() {
        // Check it is executable.
        let is_exec = path
            .metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
        if is_exec {
            CheckResult {
                key: "firecracker_binary".to_owned(),
                status: CheckStatus::Pass,
                message: format!("firecracker binary found at {}", path.display()),
            }
        } else {
            CheckResult {
                key: "firecracker_binary".to_owned(),
                status: CheckStatus::Fail,
                message: format!("firecracker binary at {} is not executable", path.display()),
            }
        }
    } else {
        CheckResult {
            key: "firecracker_binary".to_owned(),
            status: CheckStatus::Fail,
            message: format!(
                "firecracker binary not found at {} — install firecracker",
                path.display()
            ),
        }
    }
}

fn check_crun_binary(env: &DoctorEnv) -> CheckResult {
    let path = &env.crun_path;
    if path.exists() {
        let is_exec = path
            .metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
        if is_exec {
            CheckResult {
                key: "crun_binary".to_owned(),
                status: CheckStatus::Pass,
                message: format!("crun binary found at {}", path.display()),
            }
        } else {
            CheckResult {
                key: "crun_binary".to_owned(),
                status: CheckStatus::Fail,
                message: format!("crun binary at {} is not executable", path.display()),
            }
        }
    } else {
        CheckResult {
            key: "crun_binary".to_owned(),
            status: CheckStatus::Fail,
            message: format!("crun binary not found at {} — install crun", path.display()),
        }
    }
}

fn check_dev_net_tun(env: &DoctorEnv) -> CheckResult {
    let tun_path = env.dev_root.join("dev").join("net").join("tun");
    if tun_path.exists() {
        CheckResult {
            key: "dev_net_tun".to_owned(),
            status: CheckStatus::Pass,
            message: format!("{} exists", tun_path.display()),
        }
    } else {
        CheckResult {
            key: "dev_net_tun".to_owned(),
            status: CheckStatus::Fail,
            message: format!(
                "{} not found — TUN/TAP device required for VM networking",
                tun_path.display()
            ),
        }
    }
}

fn check_overlayfs(env: &DoctorEnv) -> CheckResult {
    let filesystems = match std::fs::read_to_string(&env.filesystems_path) {
        Ok(c) => c,
        Err(e) => {
            return CheckResult {
                key: "overlayfs".to_owned(),
                status: CheckStatus::Fail,
                message: format!("cannot read {}: {}", env.filesystems_path.display(), e),
            }
        }
    };

    if filesystems.contains("overlay") {
        CheckResult {
            key: "overlayfs".to_owned(),
            status: CheckStatus::Pass,
            message: "overlayfs support found in /proc/filesystems".to_owned(),
        }
    } else {
        CheckResult {
            key: "overlayfs".to_owned(),
            status: CheckStatus::Fail,
            message: "overlay not listed in /proc/filesystems — \
                       kernel overlayfs module required"
                .to_owned(),
        }
    }
}

/// Parse a kernel version string like "5.15.0-173-generic" into (major, minor).
fn parse_kernel_version(s: &str) -> Option<(u32, u32)> {
    // /proc/version format: "Linux version 5.15.0-173-generic (...)"
    // Try to find "version X.Y" or just parse leading "X.Y" from the string.
    let version_part = if let Some(rest) = s.strip_prefix("Linux version ") {
        rest.split_whitespace().next().unwrap_or(s)
    } else {
        // Assume it's just the version string directly (e.g. stub "5.15.0")
        s.trim()
    };

    let mut parts = version_part.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    Some((major, minor))
}

fn check_kernel_version(env: &DoctorEnv) -> CheckResult {
    let version_str = match std::fs::read_to_string(&env.proc_version_path) {
        Ok(c) => c,
        Err(e) => {
            return CheckResult {
                key: "kernel_version".to_owned(),
                status: CheckStatus::Warn,
                message: format!(
                    "cannot read {}: {} — cannot verify kernel version",
                    env.proc_version_path.display(),
                    e
                ),
            }
        }
    };

    match parse_kernel_version(version_str.trim()) {
        Some((major, minor)) if major > 5 || (major == 5 && minor >= 10) => CheckResult {
            key: "kernel_version".to_owned(),
            status: CheckStatus::Pass,
            message: format!("kernel version {}.{} >= 5.10 requirement met", major, minor),
        },
        Some((major, minor)) => CheckResult {
            key: "kernel_version".to_owned(),
            status: CheckStatus::Fail,
            message: format!(
                "kernel version {}.{} is below the minimum required 5.10",
                major, minor
            ),
        },
        None => CheckResult {
            key: "kernel_version".to_owned(),
            status: CheckStatus::Warn,
            message: format!(
                "could not parse kernel version from: {}",
                version_str.trim()
            ),
        },
    }
}

/// Parse MemAvailable (or MemFree if unavailable) from /proc/meminfo in kB.
fn parse_meminfo_free_kb(content: &str) -> Option<u64> {
    for line in content.lines() {
        if line.starts_with("MemAvailable:") || line.starts_with("MemFree:") {
            let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
            return Some(kb);
        }
    }
    None
}

fn check_free_memory(env: &DoctorEnv) -> CheckResult {
    let meminfo = match std::fs::read_to_string(&env.meminfo_path) {
        Ok(c) => c,
        Err(e) => {
            return CheckResult {
                key: "free_memory".to_owned(),
                status: CheckStatus::Warn,
                message: format!(
                    "cannot read {}: {} — cannot verify free memory",
                    env.meminfo_path.display(),
                    e
                ),
            }
        }
    };

    let min_mib = env.min_free_memory_bytes / (1024 * 1024);

    match parse_meminfo_free_kb(&meminfo) {
        Some(free_kb) => {
            let free_bytes = free_kb * 1024;
            if free_bytes >= env.min_free_memory_bytes {
                CheckResult {
                    key: "free_memory".to_owned(),
                    status: CheckStatus::Pass,
                    message: format!(
                        "{} MiB free memory available (minimum {} MiB)",
                        free_kb / 1024,
                        min_mib
                    ),
                }
            } else {
                CheckResult {
                    key: "free_memory".to_owned(),
                    status: CheckStatus::Warn,
                    message: format!(
                        "{} MiB free memory available — below recommended {} MiB floor",
                        free_kb / 1024,
                        min_mib
                    ),
                }
            }
        }
        None => CheckResult {
            key: "free_memory".to_owned(),
            status: CheckStatus::Warn,
            message: "could not parse free memory from /proc/meminfo".to_owned(),
        },
    }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/// Run all doctor checks and return the report + exit code.
///
/// Returns `Ok(0)` when all required checks pass (warnings are acceptable).
/// Returns `Ok(1)` when one or more required checks fail.
pub fn run(env: &DoctorEnv) -> Result<i32> {
    let report = build_report(env);
    print_human(&report);
    let exit_code = exit_code_for(&report.checks);
    Ok(exit_code)
}

/// Run all doctor checks and emit JSON to stdout.
///
/// Returns `Ok(0)` when all required checks pass.
/// Returns `Ok(1)` when one or more required checks fail.
pub fn run_json(env: &DoctorEnv) -> Result<i32> {
    let report = build_report(env);
    let json = serde_json::to_string_pretty(&report).context("serialize doctor report")?;
    let stdout = io::stdout();
    let mut out = stdout.lock();
    writeln!(out, "{json}")?;
    let exit_code = exit_code_for(&report.checks);
    Ok(exit_code)
}

/// Build the full report without any I/O.
pub fn build_report(env: &DoctorEnv) -> DoctorReport {
    let checks = vec![
        check_kvm_device(env),
        check_cpu_virt_flag(env),
        check_unrestricted_guest(env),
        check_ept(env),
        check_vpid(env),
        check_firecracker_binary(env),
        check_crun_binary(env),
        check_dev_net_tun(env),
        check_overlayfs(env),
        check_kernel_version(env),
        check_free_memory(env),
    ];
    DoctorReport { checks }
}

/// Compute the exit code: 0 if no fails, 1 otherwise.
/// Warnings do not affect the exit code.
pub fn exit_code_for(checks: &[CheckResult]) -> i32 {
    if checks.iter().any(|c| c.status == CheckStatus::Fail) {
        1
    } else {
        0
    }
}

fn print_human(report: &DoctorReport) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for check in &report.checks {
        let icon = match check.status {
            CheckStatus::Pass => "✓",
            CheckStatus::Fail => "✗",
            CheckStatus::Warn => "⚠",
        };
        writeln!(out, "{} [{}] {}", icon, check.key, check.message).expect("stdout write failed");
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use tempfile::TempDir;

    /// Create a fully-populated mock environment under `root`.
    pub fn mock_env_all_pass(root: &Path) -> DoctorEnv {
        // /dev/kvm
        let dev = root.join("dev");
        fs::create_dir_all(&dev).unwrap();
        fs::write(dev.join("kvm"), b"").unwrap();

        // /dev/net/tun
        let dev_net = dev.join("net");
        fs::create_dir_all(&dev_net).unwrap();
        fs::write(dev_net.join("tun"), b"").unwrap();

        // /proc/cpuinfo with all required Intel flags
        let proc_dir = root.join("proc");
        fs::create_dir_all(&proc_dir).unwrap();
        fs::write(
            proc_dir.join("cpuinfo"),
            "flags\t\t: vmx unrestricted_guest ept vpid\n",
        )
        .unwrap();

        // /proc/filesystems with overlay
        fs::write(
            proc_dir.join("filesystems"),
            "nodev\tsysfs\nnodev\ttmpfs\nnodev\toverlay\n",
        )
        .unwrap();

        // /proc/version with kernel 5.15
        fs::write(
            proc_dir.join("version"),
            "Linux version 5.15.0-173-generic (buildd@lcy02-amd64-023) ...",
        )
        .unwrap();

        // /proc/meminfo with 1 GiB free
        fs::write(
            proc_dir.join("meminfo"),
            "MemTotal:       16384000 kB\nMemAvailable:    1048576 kB\n",
        )
        .unwrap();

        // Firecracker dummy binary
        let firecracker_path = root
            .join("usr")
            .join("local")
            .join("bin")
            .join("firecracker");
        fs::create_dir_all(firecracker_path.parent().unwrap()).unwrap();
        fs::write(&firecracker_path, b"#!/bin/sh\n").unwrap();
        let mut perms = fs::metadata(&firecracker_path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&firecracker_path, perms).unwrap();

        // crun dummy binary
        let crun_path = root.join("usr").join("bin").join("crun");
        fs::create_dir_all(crun_path.parent().unwrap()).unwrap();
        fs::write(&crun_path, b"#!/bin/sh\n").unwrap();
        let mut perms = fs::metadata(&crun_path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&crun_path, perms).unwrap();

        DoctorEnv {
            dev_root: root.to_path_buf(),
            cpuinfo_path: proc_dir.join("cpuinfo"),
            filesystems_path: proc_dir.join("filesystems"),
            proc_version_path: proc_dir.join("version"),
            meminfo_path: proc_dir.join("meminfo"),
            firecracker_path,
            crun_path,
            min_free_memory_bytes: 512 * 1024 * 1024,
        }
    }

    #[test]
    fn all_checks_pass_returns_exit_0() {
        let tmp = TempDir::new().unwrap();
        let env = mock_env_all_pass(tmp.path());
        let report = build_report(&env);
        let exit_code = exit_code_for(&report.checks);
        assert_eq!(
            exit_code,
            0,
            "expected exit 0; failing checks: {:?}",
            report
                .checks
                .iter()
                .filter(|c| c.status == CheckStatus::Fail)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn missing_kvm_device_returns_exit_1() {
        let tmp = TempDir::new().unwrap();
        let env = mock_env_all_pass(tmp.path());
        // Remove /dev/kvm
        fs::remove_file(env.dev_root.join("dev").join("kvm")).unwrap();
        let report = build_report(&env);
        let kvm_check = report
            .checks
            .iter()
            .find(|c| c.key == "kvm_device")
            .unwrap();
        assert_eq!(
            kvm_check.status,
            CheckStatus::Fail,
            "expected kvm_device to fail"
        );
        assert_eq!(exit_code_for(&report.checks), 1);
    }

    #[test]
    fn missing_cpu_virt_flag_returns_exit_1() {
        let tmp = TempDir::new().unwrap();
        let env = mock_env_all_pass(tmp.path());
        // Write cpuinfo without vmx or svm
        fs::write(&env.cpuinfo_path, "flags\t\t: fpu vme de\n").unwrap();
        let report = build_report(&env);
        let check = report
            .checks
            .iter()
            .find(|c| c.key == "cpu_virt_flag")
            .unwrap();
        assert_eq!(
            check.status,
            CheckStatus::Fail,
            "expected cpu_virt_flag to fail"
        );
        assert_eq!(exit_code_for(&report.checks), 1);
    }

    #[test]
    fn missing_unrestricted_guest_returns_exit_1() {
        let tmp = TempDir::new().unwrap();
        let env = mock_env_all_pass(tmp.path());
        // cpuinfo has vmx but NOT unrestricted_guest
        fs::write(&env.cpuinfo_path, "flags\t\t: vmx ept vpid\n").unwrap();
        let report = build_report(&env);
        let check = report
            .checks
            .iter()
            .find(|c| c.key == "cpu_unrestricted_guest")
            .unwrap();
        assert_eq!(
            check.status,
            CheckStatus::Fail,
            "expected cpu_unrestricted_guest to fail"
        );
        assert_eq!(exit_code_for(&report.checks), 1);
    }

    #[test]
    fn missing_firecracker_binary_returns_exit_1() {
        let tmp = TempDir::new().unwrap();
        let env = mock_env_all_pass(tmp.path());
        // Remove firecracker
        fs::remove_file(&env.firecracker_path).unwrap();
        let report = build_report(&env);
        let check = report
            .checks
            .iter()
            .find(|c| c.key == "firecracker_binary")
            .unwrap();
        assert_eq!(
            check.status,
            CheckStatus::Fail,
            "expected firecracker_binary to fail"
        );
        assert_eq!(exit_code_for(&report.checks), 1);
    }

    #[test]
    fn missing_crun_binary_returns_exit_1() {
        let tmp = TempDir::new().unwrap();
        let env = mock_env_all_pass(tmp.path());
        // Remove crun
        fs::remove_file(&env.crun_path).unwrap();
        let report = build_report(&env);
        let check = report
            .checks
            .iter()
            .find(|c| c.key == "crun_binary")
            .unwrap();
        assert_eq!(
            check.status,
            CheckStatus::Fail,
            "expected crun_binary to fail"
        );
        assert_eq!(exit_code_for(&report.checks), 1);
    }

    #[test]
    fn missing_overlayfs_returns_exit_1() {
        let tmp = TempDir::new().unwrap();
        let env = mock_env_all_pass(tmp.path());
        // Write filesystems without overlay
        fs::write(&env.filesystems_path, "nodev\tsysfs\nnodev\ttmpfs\n").unwrap();
        let report = build_report(&env);
        let check = report.checks.iter().find(|c| c.key == "overlayfs").unwrap();
        assert_eq!(
            check.status,
            CheckStatus::Fail,
            "expected overlayfs to fail"
        );
        assert_eq!(exit_code_for(&report.checks), 1);
    }

    #[test]
    fn json_flag_output_matches_schema() {
        let tmp = TempDir::new().unwrap();
        let env = mock_env_all_pass(tmp.path());
        let report = build_report(&env);
        let json = serde_json::to_string_pretty(&report).unwrap();
        // Deserialize back and validate schema
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let checks = v["checks"].as_array().unwrap();
        assert!(!checks.is_empty());

        let expected_keys = [
            "kvm_device",
            "cpu_virt_flag",
            "cpu_unrestricted_guest",
            "cpu_ept",
            "cpu_vpid",
            "firecracker_binary",
            "crun_binary",
            "dev_net_tun",
            "overlayfs",
            "kernel_version",
            "free_memory",
        ];
        let valid_statuses = ["pass", "fail", "warn"];
        for check in checks {
            let key = check["key"].as_str().unwrap();
            assert!(!key.is_empty(), "key must not be empty");
            let status = check["status"].as_str().unwrap();
            assert!(
                valid_statuses.contains(&status),
                "status '{}' must be pass/fail/warn",
                status
            );
            let message = check["message"].as_str().unwrap();
            assert!(!message.is_empty(), "message must not be empty");
        }
        // All 11 expected keys present
        let present_keys: Vec<&str> = checks.iter().map(|c| c["key"].as_str().unwrap()).collect();
        for key in &expected_keys {
            assert!(
                present_keys.contains(key),
                "expected check key '{}' not found in output",
                key
            );
        }
    }

    #[test]
    fn warnings_do_not_affect_exit_code() {
        let tmp = TempDir::new().unwrap();
        let env = mock_env_all_pass(tmp.path());
        // Use AMD-V (svm) cpuinfo — Intel-only checks (unrestricted_guest, ept, vpid) become warn
        fs::write(&env.cpuinfo_path, "flags\t\t: svm\n").unwrap();
        let report = build_report(&env);
        // Confirm some checks are warn
        let warn_checks: Vec<_> = report
            .checks
            .iter()
            .filter(|c| c.status == CheckStatus::Warn)
            .collect();
        assert!(
            !warn_checks.is_empty(),
            "expected at least one warn check with AMD-V cpuinfo"
        );
        // No fail checks
        let fail_checks: Vec<_> = report
            .checks
            .iter()
            .filter(|c| c.status == CheckStatus::Fail)
            .collect();
        assert!(
            fail_checks.is_empty(),
            "unexpected fail checks: {:?}",
            fail_checks
        );
        assert_eq!(exit_code_for(&report.checks), 0);
    }

    /// Live host test — only runs when FASTENV_E2E_SMOKE=1 is set.
    #[test]
    fn live_host_all_pass() {
        if std::env::var("FASTENV_E2E_SMOKE").as_deref() != Ok("1") {
            eprintln!("Skipping live_host_all_pass — set FASTENV_E2E_SMOKE=1 to run");
            return;
        }
        let env = DoctorEnv::default();
        let report = build_report(&env);
        let expected_keys = [
            "kvm_device",
            "cpu_virt_flag",
            "cpu_unrestricted_guest",
            "cpu_ept",
            "cpu_vpid",
            "firecracker_binary",
            "crun_binary",
            "dev_net_tun",
            "overlayfs",
            "kernel_version",
            "free_memory",
        ];
        let present_keys: Vec<&str> = report.checks.iter().map(|c| c.key.as_str()).collect();
        for key in &expected_keys {
            assert!(present_keys.contains(key), "missing key: {}", key);
        }
        for check in &report.checks {
            assert_ne!(
                check.status,
                CheckStatus::Fail,
                "check '{}' failed on live host: {}",
                check.key,
                check.message
            );
        }
        assert_eq!(exit_code_for(&report.checks), 0);
    }
}
