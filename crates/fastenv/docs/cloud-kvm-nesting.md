# KVM Nested Virtualization in Cloud Providers

fastenv requires `/dev/kvm` on the host to boot Firecracker microVMs. This document
surveys KVM nested-virtualization availability across major cloud providers so that
deployment targets can be evaluated accurately.

---

## Summary table

| Provider           | Standard VMs                                | Notes                                                                     |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------- |
| AWS EC2            | Yes — C8i, M8i, R8i only (since Feb 2026)   | Intel 8th-gen only; no Graviton; opt-in parameter                         |
| GCP Compute Engine | Yes — Intel families                        | `--enable-nested-virtualization` flag; E2, AMD, ARM excluded              |
| Azure              | Yes — Dv3/Ev3 and newer Intel; some AMD v6  | Hyper-V native; KVM works with caveats; "Standard" security type required |
| DigitalOcean       | Yes — all regions, all tiers                | Unsupported; poor performance; live migration kills VMs                   |
| OCI                | Yes — E5.Flex (AMD), Standard3.Flex (Intel) | Officially documented by Oracle                                           |
| Vultr              | Likely yes                                  | Community-reported; not officially documented                             |
| Hetzner Cloud      | No                                          | Cloud VMs (CX/CPX/CCX) do not expose KVM; dedicated servers do            |
| Linode / Akamai    | No                                          | Incompatible with their live-migration system; no bare metal yet          |

---

## AWS EC2

**Available since February 2026** on 8th-generation Intel instance families: `c8i`, `m8i`,
and `r8i`. Requires the `NestedVirtualization` parameter at launch time; it is not enabled
by default.

Graviton (ARM) instances do not support nested virtualization. Older Nitro families
(C5, M5, R5, etc.) also do not expose `/dev/kvm` — AWS was effectively metal-only before
this launch.

AWS recommends bare-metal instances for latency-sensitive or performance-critical
virtualization workloads. The nested path carries a non-trivial overhead penalty.

Firecracker itself runs in AWS Lambda and Fargate, but those environments sit on dedicated
Nitro bare-metal capacity managed entirely by AWS — not on nested-virt instances.

**References:**

- [AWS EC2 Nested Virtualization announcement (InfoQ, Mar 2026)](https://www.infoq.com/news/2026/03/aws-ec2-nested-virtualization/)
- [AWS re:Post thread on compute-optimized nested virt](https://repost.aws/questions/QUkOwmVhagQbOumNhdfc4YcA/nested-virtualisation-support-on-ec2-compute-optimized-instances)

---

## GCP Compute Engine

Officially supported via the `--enable-nested-virtualization` flag (or
`enableNestedVirtualization: true` in the instance API). The instance must be pinned to
Intel Haswell or newer with `--min-cpu-platform`.

**Supported families:** N1, N2, C2, C3 (Intel).

**Not supported:** E2 (no CPU pinning), N2D/C2D (AMD EPYC), T2A/Axion (ARM),
memory-optimized (M1/M2/M3), H4D.

`/dev/kvm` is exposed on supported instances. Firecracker is known to run on GCP with
nested KVM enabled.

**References:**

- [GCP docs: About nested virtualization](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview)
- [GCP docs: Enable nested virtualization](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/enabling)
- [firecracker-gcp (community project)](https://github.com/glikson/firecracker-gcp)

---

## Azure

Azure exposes nested virtualization on Intel-based Dv3/Ev3 and all later D/E-series
generations (Dv4, Dv5, Ev4, Ev5, Dsv4, Esv4, etc.), Fsv2, and select AMD v6 families
(Dalsv6, Easv6). No configuration flag is needed — nested virtualization is available by
default on supported sizes.

Azure uses Hyper-V as its hypervisor, but Linux KVM works inside a supported Azure VM:
`/dev/kvm` is accessible and Firecracker can run. Important caveats:

- **AMD shapes:** 50–90% CPU performance degradation observed with nested KVM on AMD
  Azure instances. Intel shapes are considerably more usable.
- **Firecracker stability:** some configurations hit `KVM_EXIT_FAIL_ENTRY` with Firecracker
  under nested KVM on Azure — this is a known issue in the Firecracker tracker.
- **Security type:** the default "Trusted launch" VM security type is incompatible with
  nested virtualization. The VM must be created with security type set to "Standard".

Azure ARM (Cobalt) instances do not support nested virtualization.

**References:**

- [Microsoft: Nested Virtualization in Azure (blog)](https://azure.microsoft.com/en-us/blog/nested-virtualization-in-azure/)
- [Microsoft Q&A: which Azure VM sizes support nested virt](https://learn.microsoft.com/en-us/answers/questions/813416/how-do-i-know-what-size-azure-vm-supports-nested-v)
- [Microsoft Q&A: KVM environment inside Azure VM](https://learn.microsoft.com/en-us/answers/questions/2086756/about-nested-vms-when-building-a-kvm-environment-i)
- [Firecracker issue #668: KVM_EXIT_FAIL_ENTRY under nested virt](https://github.com/firecracker-microvm/firecracker/issues/668)
- [cloud-hypervisor issue #4827: AMD nested KVM degradation on Azure](https://github.com/cloud-hypervisor/cloud-hypervisor/issues/4827)

---

## DigitalOcean

A DigitalOcean employee confirmed in 2021 that `/dev/kvm` is accessible on Droplets across
all regions. This appears to hold across all current Droplet tiers (Basic, Premium,
CPU-Optimized, GPU). It is not officially supported, and DO actively discourages its use.

Key operational concern: **DigitalOcean live-migrates Droplets without notice** for
maintenance. Nested VMs do not survive live migration and must be restarted. For fastenv,
this means project VMs can be killed by the hypervisor at any time, making
crash-recovery and rehydration a hard requirement rather than a nice-to-have.

Performance is described as "often very poor" in the official response.

**First-hand validation:** Firecracker v1.16.0 was tested on a DigitalOcean Ubuntu droplet
(kernel 6.8.0-111-generic, x86_64) and confirmed fully functional:

- `/dev/kvm` present and accessible
- CPU exposes `vmx` with `unrestricted_guest`, `ept`, `vpid` — all required by Firecracker
- Firecracker API server started without errors
- Ubuntu 24.04 microVM booted to login prompt in ~4 seconds
- Guest kernel and systemd both reported `virtualization: kvm`

The key prerequisite to check before assuming a DO Droplet is usable:

```bash
grep 'unrestricted_guest' /proc/cpuinfo   # must be present for Firecracker
```

Viable for development and testing. Not recommended as a production substrate without
explicit tolerance for unannounced VM restarts.

**References:**

- [DO community: KVM / nested virtualization support (official reply)](https://www.digitalocean.com/community/questions/does-digitalocean-support-kvm-or-nested-virtulzation)
- [Alex Ellis: Running Firecracker without KVM on cloud VMs (Feb 2025)](https://blog.alexellis.io/how-to-run-firecracker-without-kvm-on-regular-cloud-vms/)

---

## OCI (Oracle Cloud Infrastructure)

Oracle officially documents nested KVM virtualization on OCI. Supported shapes:

- **VM.Standard.E5.Flex** (AMD EPYC)
- **VM.Standard3.Flex** (Intel)

OCI's Always Free tier uses different shapes (A1 ARM and E2.Micro) that are not listed as
supported for nested virt.

**References:**

- [Oracle blog: KVM Nested Virtualization in OCI](https://blogs.oracle.com/linux/kvm-nested-virtualization-in-oci)
- [Oracle blog: Simple guide to nested KVM on OCI](https://blogs.oracle.com/cloud-infrastructure/post/a-simple-guide-to-nested-kvm-virtualization-on-oracle-cloud-infrastructure)

---

## Vultr

Community reports indicate that `/dev/kvm` is accessible on Vultr cloud compute instances
and that nested virtualization works. Vultr does not publish official documentation
confirming or denying this, and there is no explicit support commitment. The situation
appears similar to DigitalOcean: works in practice, unsupported officially.

Live-migration behavior and performance characteristics are not well-documented. Treat
similarly to DigitalOcean until verified otherwise.

---

## Hetzner Cloud

Standard Hetzner Cloud VMs (CX, CPX, CCX, CAX series) **do not expose `/dev/kvm`**.
KVM hardware acceleration must be disabled when running QEMU on their cloud VPS, meaning
Firecracker cannot run.

Hetzner's **dedicated servers** (Root Servers / AX/EX lines) are bare metal and do
support KVM. Hetzner Cloud ≠ Hetzner dedicated — they are distinct product lines.

**References:**

- [GitHub: Proxmox on Hetzner Cloud — KVM limitation](https://bennetgallein.de/blog/proxmox-on-hetzner-cloud)
- [hetzner-ocp issue: nested virtualization unavailable on cloud VMs](https://github.com/RedHat-EMEA-SSA-Team/hetzner-ocp/issues/10)

---

## Linode / Akamai

Linode standard instances do not support nested virtualization. The official reason given
is incompatibility with their live-migration infrastructure. No workaround is available
on standard shared or dedicated instances.

Linode has mentioned future bare-metal offerings as a path to KVM access, but no
generally-available bare-metal product exists as of this writing.

**References:**

- [Linode community: nested VM/virtualization support](https://www.linode.com/community/questions/19459/do-any-linode-regionsinstances-support-nested-vmvirtualization)

---

## Implications for fastenv

**Well-supported targets (recommended):**

- GCP N2/C2/C3 Intel instances with `--enable-nested-virtualization`
- Azure Dv5/Ev5 Intel instances (security type: Standard)
- AWS C8i/M8i/R8i with NestedVirtualization enabled (since Feb 2026)
- OCI VM.Standard3.Flex or VM.Standard.E5.Flex

**Works but unsupported / unstable:**

- DigitalOcean: any Droplet, but expect poor performance and unannounced VM restarts
- Vultr: likely works; treat as unsupported

**Does not work:**

- Hetzner Cloud VMs (CX/CPX/CCX/CAX)
- Linode / Akamai standard instances
- AWS Graviton, GCP E2 / ARM / AMD, Azure Cobalt (ARM)

**Cross-cutting note:** ARM/Graviton instances are consistently excluded from nested
virtualization support across all providers. fastenv is effectively x86-only for KVM-based
deployments.

fastenv should check for `/dev/kvm` at startup and fail with a clear diagnostic message
identifying the likely cause, rather than producing obscure errors from Firecracker
initialization failure. This is implemented by the `fastenv doctor` subcommand — see
[§9 Doctor](architecture.md#9-doctor) in `crates/fastenv/docs/architecture.md` for the
full check inventory, exit codes, and `--json` output format.
