# GBA Agentic Auto Fleet Hub & Bridge

Distributed Android Test Suite Automation (CTS, GTS, STS, SKU, MR, SMR, and Cuci SMR) across remote Linux workstation nodes.

---

## Overview

GBA Agentic Auto Fleet coordinates large-scale Android compliance and certification test suites across multiple workstation PCs running native agent daemons. Operators manage connected devices, trigger automated test runs, monitor live execution logs, and inspect test results from a central web dashboard.

---

## Architecture

```
                                  ┌───────────────────────────────┐
                                  │      Central Web Hub          │
                                  │  (agent.endrisusanto.my.id)   │
                                  │  - Node.js + WebSocket Server │
                                  │  - React + Vite Dashboard     │
                                  └───────────────▲───────────────┘
                                                  │
                                WebSocket (/ws/bridge & /ws/ui)
                                                  │
                 ┌────────────────────────────────┴────────────────────────────────┐
                 │                                                                 │
  ┌──────────────▼──────────────┐                                   ┌──────────────▼──────────────┐
  │   Node Workstation 01       │                                   │   Node Workstation 02       │
  │   - gba-agent-bridge (Tray) │                                   │   - gba-agent-bridge (Tray) │
  │   - Tradefed Runner Engine  │                                   │   - Tradefed Runner Engine  │
  │   - Local Results/ & ADB    │                                   │   - Local Results/ & ADB    │
  └──────────────┬──────────────┘                                   └──────────────┬──────────────┘
                 │                                                                 │
        ┌────────┴────────┐                                               ┌────────┴────────┐
        ▼                 ▼                                               ▼                 ▼
  [Galaxy S24]      [Galaxy A55]                                    [Galaxy S23]      [Galaxy Z Fold]
```

---

## Repository Structure

```
agent/
├── web-hub/
│   ├── client/          # React, Vite, and TypeScript frontend dashboard
│   └── server/          # Node.js backend and WebSocket hub server
├── agent-bridge/        # Native Rust/Tauri client daemon with AppTray
├── build-deb.sh         # Linux .deb native packager script
├── release.sh           # Automated versioning, tagging, and release script
└── package.json         # Monorepo workspace configuration
```

---

## Core Capabilities

### Central Web Hub (`agent.endrisusanto.my.id`)
- **Fleet State Aggregator**: Real-time tracking of connected bridge nodes, active running jobs, and connected Android devices across all benches.
- **Suite Orchestration**: Triggers `CTS`, `GTS`, `STS`, `SKU`, `MR`, `SMR`, and `Cuci SMR` with custom retry counts, timeouts, and Wi-Fi provisioning.
- **Cuci SMR (Laundry / Scat Retry)**: Scans result zip archives on target node disks, parses `test_result.xml` subtests, and allows operators to selectively retry failed modules.
- **Live Log Streaming**: Real-time console log drawer per job and device with auto-scroll and cancel actions.
- **Design System**: High-contrast dark and light modes with typography powered by `Plus Jakarta Sans` and `JetBrains Mono`.

### Native Agent Bridge (`agent-bridge`)
- **AppTray Background Daemon**: Runs in the system tray with close-to-tray protection to prevent accidental cancellation during long test runs.
- **Hardware & Build Detection**: Continuously monitors connected ADB devices, extracting Android version, SPL, PDA, CSC, and `USER` vs `USERDEBUG` build types.
- **Zero Network Waste**: Executes Tradefed suites locally; only metadata and log streams are transmitted to the Hub.

---

## Quick Start

### 1. Web Hub Development
```bash
# Install workspace dependencies
npm install

# Start both backend server (:4000) and frontend client (:3000)
npm run dev
```

### 2. Run Agent Bridge Locally
```bash
cd agent-bridge
cargo run
```

To connect to a custom hub host or set a specific node identifier:
```bash
HUB_URL=wss://agent.endrisusanto.my.id/ws/bridge PC_ID=NODE-LAB-01 cargo run
```

### 3. Build & Install Debian Package on Node PCs
```bash
./build-deb.sh
sudo dpkg -i dist/gba-agent-bridge_1.0.0_amd64.deb
```

---

## Automated Releases

To bump version, tag, and trigger GitHub Actions release pipeline:
```bash
# Patch release (default: 1.0.0 -> 1.0.1)
./release.sh patch "Description of changes"

# Minor release (1.0.0 -> 1.1.0)
./release.sh minor "Feature update"
```

GitHub Actions automatically builds and publishes Linux packages to the [Releases](https://github.com/endrisusanto/agent/releases) page.
