use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use crate::types::{PreflightItem, PreflightReport};

pub fn run_preflight_check(auto_root: &Path, pc_id: &str) -> PreflightReport {
    let mut items = Vec::new();
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // 1. Check Core Directories
    let core_dirs = ["CTS", "GTS", "STS", "Results"];
    for dir_name in &core_dirs {
        let p = auto_root.join(dir_name);
        let exists = p.is_dir();
        items.push(PreflightItem {
            category: "Core Dir".to_string(),
            item: dir_name.to_string(),
            status: if exists { "OK".to_string() } else { "MISSING".to_string() },
            details: if exists { Some("Directory exists".to_string()) } else { Some("Directory not found".to_string()) },
            path: p.to_string_lossy().to_string(),
            can_sync: false,
            zip_available: false,
            zip_path: None,
            version: None,
            suite: Some(dir_name.to_string()),
        });
    }

    // 2. Scan suite directories and check versions & tradefed tools
    let suites = [
        ("GTS", "android-gts", "tools/gts-tradefed"),
        ("CTS", "android-cts", "tools/cts-tradefed"),
        ("STS", "android-sts", "tools/sts-tradefed"),
    ];

    for (suite_name, suite_sub, tool_rel) in &suites {
        let suite_dir = auto_root.join(suite_name);
        let mut found_any_version = false;

        if suite_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(&suite_dir) {
                let mut version_dirs: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok().map(|x| x.path()))
                    .filter(|p| p.is_dir())
                    .collect();
                version_dirs.sort();

                for v_dir in version_dirs {
                    let v_name = v_dir.file_name().unwrap_or_default().to_string_lossy().to_string();
                    if v_name.starts_with('.') || v_name == "subplans" || v_name == "Results" {
                        continue;
                    }
                    found_any_version = true;

                    // Check android-<suite> directory
                    let inner_android = v_dir.join(suite_sub);
                    let inner_exists = inner_android.is_dir();

                    // Check tools/*-tradefed
                    let tool_path = v_dir.join(tool_rel);
                    let alt_tool_path = inner_android.join(tool_rel);
                    let tool_found = tool_path.is_file() || alt_tool_path.is_file();
                    let actual_path = if inner_exists { inner_android.clone() } else { v_dir.clone() };

                    // Check zip availability
                    let zip_name_candidates = [
                        format!("{suite_sub}-{v_name}.zip"),
                        format!("{v_name}.zip"),
                        format!("{suite_name}_{v_name}.zip"),
                    ];
                    let mut found_zip: Option<PathBuf> = None;
                    for zname in &zip_name_candidates {
                        let direct_zip = suite_dir.join(zname);
                        if direct_zip.is_file() {
                            found_zip = Some(direct_zip);
                            break;
                        }
                        let root_zip = auto_root.join(zname);
                        if root_zip.is_file() {
                            found_zip = Some(root_zip);
                            break;
                        }
                    }

                    let is_ready = inner_exists && tool_found;
                    let details_msg = if is_ready {
                        if found_zip.is_some() {
                            "Package ready (Zip available & tradefed ready)".to_string()
                        } else {
                            "Package ready (Extracted suite ready)".to_string()
                        }
                    } else if !inner_exists {
                        format!("{suite_sub} folder not found inside {v_name}")
                    } else {
                        "tradefed binary missing or not executable".to_string()
                    };

                    items.push(PreflightItem {
                        category: suite_name.to_string(),
                        item: format!("{}/{}/{}", suite_name, v_name, suite_sub),
                        status: if is_ready { "OK".to_string() } else if inner_exists { "WARN".to_string() } else { "MISSING".to_string() },
                        details: Some(details_msg),
                        path: actual_path.to_string_lossy().to_string(),
                        can_sync: true,
                        zip_available: found_zip.is_some(),
                        zip_path: found_zip.map(|p| p.to_string_lossy().to_string()),
                        version: Some(v_name.clone()),
                        suite: Some(suite_name.to_string()),
                    });
                }
            }
        }

        // If suite folder is completely empty or missing
        if !found_any_version {
            items.push(PreflightItem {
                category: suite_name.to_string(),
                item: format!("{suite_name} (Belum ada versi)"),
                status: "MISSING".to_string(),
                details: Some(format!("Folder {suite_name} masih kosong. Belum ada paket test suite terpasang.")),
                path: suite_dir.to_string_lossy().to_string(),
                can_sync: true,
                zip_available: false,
                zip_path: None,
                version: None,
                suite: Some(suite_name.to_string()),
            });
        }
    }

    PreflightReport {
        pc_id: pc_id.to_string(),
        auto_root: auto_root.to_string_lossy().to_string(),
        items,
        scanned_at: now,
    }
}

// -------------------------------------------------------------------------------------------------
// Archive Packing & Extraction for Cross-Node Sync
// -------------------------------------------------------------------------------------------------

#[allow(dead_code)]
pub fn export_tool_archive(auto_root: &Path, suite: &str, version: &str) -> Result<PathBuf, String> {
    let suite_dir = auto_root.join(suite);
    let version_dir = suite_dir.join(version);

    if !version_dir.exists() {
        return Err(format!("Source version dir does not exist: {}", version_dir.display()));
    }

    // Check if zip already exists
    let zip_candidates = [
        suite_dir.join(format!("{suite}-{version}.zip")),
        suite_dir.join(format!("{version}.zip")),
        auto_root.join(format!("{suite}_{version}.zip")),
    ];

    for z in &zip_candidates {
        if z.is_file() {
            return Ok(z.clone());
        }
    }

    // Otherwise create a fast .tar.gz archive
    let temp_dir = std::env::temp_dir().join("gba_tools_export");
    let _ = fs::create_dir_all(&temp_dir);
    let out_archive = temp_dir.join(format!("{suite}_{version}.tar.gz"));

    let tar_gz = File::create(&out_archive)
        .map_err(|e| format!("Failed to create archive file {}: {e}", out_archive.display()))?;
    let enc = flate2::write::GzEncoder::new(tar_gz, flate2::Compression::fast());
    let mut tar = tar::Builder::new(enc);

    tar.append_dir_all(version, &version_dir)
        .map_err(|e| format!("Failed to append dir to tar: {e}"))?;
    tar.finish()
        .map_err(|e| format!("Failed to finalize tar archive: {e}"))?;

    Ok(out_archive)
}

#[allow(dead_code)]
pub fn import_tool_archive(auto_root: &Path, suite: &str, version: &str, archive_file: &Path) -> Result<(), String> {
    let target_dir = auto_root.join(suite).join(version);
    let _ = fs::create_dir_all(&target_dir);

    let file_name = archive_file.file_name().unwrap_or_default().to_string_lossy().to_string();

    if file_name.ends_with(".zip") {
        let file = File::open(archive_file).map_err(|e| format!("Cannot open zip: {e}"))?;
        let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file))
            .map_err(|e| format!("Invalid zip archive: {e}"))?;
        archive.extract(&target_dir)
            .map_err(|e| format!("Extraction failed: {e}"))?;
    } else if file_name.ends_with(".tar.gz") || file_name.ends_with(".tgz") {
        let file = File::open(archive_file).map_err(|e| format!("Cannot open tar.gz: {e}"))?;
        let dec = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(dec);
        archive.unpack(auto_root.join(suite))
            .map_err(|e| format!("Tar extraction failed: {e}"))?;
    } else {
        return Err(format!("Unsupported archive format: {file_name}"));
    }

    // Set chmod +x on executable scripts
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let tools_dirs = [
            target_dir.join("tools"),
            target_dir.join(format!("android-{}", suite.to_lowercase())).join("tools"),
        ];
        for td in &tools_dirs {
            if let Ok(entries) = fs::read_dir(td) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.is_file() {
                        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o755));
                    }
                }
            }
        }
    }

    Ok(())
}
