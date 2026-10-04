# GBA Agentic Auto Fleet Hub & Bridge

Distributed Android Test Suite Automation (CTS, GTS, STS, SKU, MR, SMR, and Cuci SMR) across remote Linux workstation nodes.

---

## Overview

Sistem otomasi pengujian Android terdistribusi dengan arsitektur dua komponen utama:
1. **`agent-bridge`**: Daemon ringan berbasis Rust/Tauri dengan AppTray (System Tray) yang terinstall pada masing-masing Node PC/Workstation. Bridge memindai perangkat ADB lokal, mengeksekusi test suite Tradefed, dan men-stream log secara real-time.
2. **`web-hub`**: Central Web Hub (`agent.endrisusanto.my.id`) berbasis Node.js/TypeScript WebSocket server dan dashboard modern React/Vite yang mengkoordinasikan armada pengujian dan pemantauan secara real-time.

---

## Struktur Repositori

```
Agent/
├── web-hub/
│   ├── client/          # React, Vite, and TypeScript frontend dashboard
│   └── server/          # Node.js backend & WebSocket Hub server
├── agent-bridge/        # Native Rust/Tauri client daemon with AppTray
├── build-deb.sh         # Skrip build paket .deb untuk Node PC Linux
└── package.json         # Workspace scripts
```

---

## Menjalankan Web Hub Server & Dashboard

### 1. Install Dependensi Workspace
```bash
npm install
```

### 2. Jalankan Development Mode
```bash
# Menjalankan server backend (:4000) dan client frontend (:3000) sekaligus
npm run dev
```

- **Dashboard UI**: `http://localhost:3000` (atau domain produksi `https://agent.endrisusanto.my.id`)
- **WebSocket Endpoints**:
  - `ws://0.0.0.0:4000/ws/ui` (Operator Web Clients)
  - `ws://0.0.0.0:4000/ws/bridge` (Node PC Agent Bridges)

---

## Menjalankan Agent Bridge pada Node PC

### 1. Jalankan Langsung via Cargo
```bash
cd agent-bridge
cargo run
```

Atau tentukan variabel lingkungan secara langsung:
```bash
HUB_URL=wss://agent.endrisusanto.my.id/ws/bridge PC_ID=NODE-LAB-01 cargo run
```

### 2. Build Paket `.deb` untuk Instalasi Node PC
```bash
./build-deb.sh
```

Instal paket yang dihasilkan:
```bash
sudo dpkg -i dist/gba-agent-bridge_1.0.0_amd64.deb
```
Jalankan aplikasi dari Application Launcher atau terminal dengan mengetik:
```bash
gba-agent-bridge
```

---

## Fitur Unggulan

- **AppTray Background Daemon**: Berjalan di System Tray dan otomatis *minimize to tray* jika jendela ditutup.
- **Auto Device Discovery**: Deteksi otomatis build type (`USER` vs `USERDEBUG`), Android Major version, Security Patch Level (SPL), PDA, CSC, dan IP.
- **Cuci SMR (Laundry / Scat Retry)**: Pemilihan file zip hasil test sebelumnya langsung dari disk node PC lokal, analisa XML cepat, dan penandaan modul gagal yang ingin dicuci.
- **Streaming Live Log Drawer**: Console log realtime per-job dan per-device langsung di browser operator.
- **Dark/Light Theme Toggle**: Sesuai dengan design system Octopus berbasis token CSS (`Plus Jakarta Sans` & `JetBrains Mono`).
