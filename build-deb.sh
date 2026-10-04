#!/usr/bin/env bash
# ponytail: Native .deb packager for GBA Agentic Auto Bridge
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION=$(grep -m1 'version' "${ROOT_DIR}/agent-bridge/Cargo.toml" | cut -d '"' -f 2)
PKG_NAME="gba-agent-bridge"
ARCH="amd64"
DEB_NAME="${PKG_NAME}_${VERSION}_${ARCH}.deb"
DIST_DIR="${ROOT_DIR}/dist"
STAGE_DIR="${DIST_DIR}/stage_${PKG_NAME}"

echo "==> [1/4] Compiling Rust release binary (${PKG_NAME} v${VERSION})..."
cargo build --release --manifest-path "${ROOT_DIR}/agent-bridge/Cargo.toml"

echo "==> [2/4] Preparing Debian package layout..."
rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}/DEBIAN"
mkdir -p "${STAGE_DIR}/usr/bin"
mkdir -p "${STAGE_DIR}/usr/share/applications"
mkdir -p "${STAGE_DIR}/usr/share/icons/hicolor/512x512/apps"
mkdir -p "${STAGE_DIR}/usr/share/icons/hicolor/128x128/apps"
mkdir -p "${STAGE_DIR}/usr/share/icons/hicolor/32x32/apps"

# 1. Copy binary
cp "${ROOT_DIR}/agent-bridge/target/release/gba-agent-bridge" "${STAGE_DIR}/usr/bin/gba-agent-bridge"
chmod +x "${STAGE_DIR}/usr/bin/gba-agent-bridge"

# 2. Copy App Icons
if [ -f "${ROOT_DIR}/agent-bridge/icons/icon.png" ]; then
    cp "${ROOT_DIR}/agent-bridge/icons/icon.png" "${STAGE_DIR}/usr/share/icons/hicolor/512x512/apps/gba-agent-bridge.png"
    cp "${ROOT_DIR}/agent-bridge/icons/128x128.png" "${STAGE_DIR}/usr/share/icons/hicolor/128x128/apps/gba-agent-bridge.png"
    cp "${ROOT_DIR}/agent-bridge/icons/32x32.png" "${STAGE_DIR}/usr/share/icons/hicolor/32x32/apps/gba-agent-bridge.png"
fi

# 3. Create Desktop Entry Shortcut
cat <<EOF > "${STAGE_DIR}/usr/share/applications/gba-agent-bridge.desktop"
[Desktop Entry]
Name=GBA Agent Bridge
Comment=Distributed Android Test Suite Automation (CTS/GTS/STS) Bridge Daemon
Exec=/usr/bin/gba-agent-bridge
Icon=gba-agent-bridge
Terminal=false
Type=Application
Categories=Development;Utility;
Keywords=Android;CTS;GTS;STS;Tradefed;ADB;GBA;
StartupNotify=true
EOF
chmod 644 "${STAGE_DIR}/usr/share/applications/gba-agent-bridge.desktop"

# 4. Create DEBIAN Control File
cat <<EOF > "${STAGE_DIR}/DEBIAN/control"
Package: ${PKG_NAME}
Version: ${VERSION}
Architecture: ${ARCH}
Maintainer: Endri Susanto <endri@endrisusanto.my.id>
Section: utils
Priority: optional
Depends: libc6, libgtk-3-0, libwebkit2gtk-4.1-0 | libwebkit2gtk-4.0-37, libayatana-appindicator3-1, adb | android-tools-adb
Description: GBA Agentic Auto Bridge Daemon
 Native system tray daemon connecting local ADB Android devices to agent.endrisusanto.my.id Web Hub.
 Supports CTS, GTS, STS, and Cuci SMR automation.
EOF

# 5. Create postinst hook for icon cache update
cat <<'EOF' > "${STAGE_DIR}/DEBIAN/postinst"
#!/bin/sh
set -e
if which update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q || true
fi
if which gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q /usr/share/icons/hicolor || true
fi
exit 0
EOF
chmod 755 "${STAGE_DIR}/DEBIAN/postinst"

echo "==> [3/4] Building .deb package using dpkg-deb..."
mkdir -p "${DIST_DIR}"
dpkg-deb --build --root-owner-group "${STAGE_DIR}" "${DIST_DIR}/${DEB_NAME}"
rm -rf "${STAGE_DIR}"

echo "==> [4/4] Package built successfully!"
echo "--------------------------------------------------------"
echo "Package File: ${DIST_DIR}/${DEB_NAME}"
echo "File Size:    $(du -h "${DIST_DIR}/${DEB_NAME}" | cut -f1)"
echo "--------------------------------------------------------"
echo "Untuk menginstall di node Linux, jalankan:"
echo "  sudo dpkg -i ${DIST_DIR}/${DEB_NAME}"
echo "--------------------------------------------------------"
