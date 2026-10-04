use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use tempfile::TempDir;
use walkdir::WalkDir;
use zip::ZipArchive;
use crate::types::LaundryResultInfo;

pub fn resolve_zip_path(zip_path: &str) -> Option<PathBuf> {
    let p = Path::new(zip_path);
    if p.is_file() {
        return Some(p.to_path_buf());
    }

    let filename = p.file_name()?.to_string_lossy();

    // 1. Check environment variable CUCIAN_DIR
    if let Ok(cucian_env) = std::env::var("CUCIAN_DIR") {
        let candidate = PathBuf::from(cucian_env).join(filename.as_ref());
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // 2. Check user HOME Downloads/CUCIAN
    if let Ok(home) = std::env::var("HOME") {
        let candidate = PathBuf::from(home).join("Downloads").join("CUCIAN").join(filename.as_ref());
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // 3. Check all user directories in /home
    if let Ok(entries) = std::fs::read_dir("/home") {
        for entry in entries.flatten() {
            let candidate = entry.path().join("Downloads").join("CUCIAN").join(filename.as_ref());
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // 4. Known directories
    for dir in &["/home/endri-pro/Downloads/CUCIAN", "/cucian", "/tmp/CUCIAN"] {
        let candidate = PathBuf::from(dir).join(filename.as_ref());
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

pub fn analyze_laundry_zip(zip_path: &str) -> Result<Vec<LaundryResultInfo>, String> {
    let resolved = resolve_zip_path(zip_path)
        .ok_or_else(|| format!("File zip tidak ditemukan: {zip_path}"))?;

    let temp = TempDir::new().map_err(|e| format!("Cannot create temp dir: {e}"))?;
    extract_zip_safe(&resolved, temp.path())?;
    scan_laundry_result_infos(temp.path(), &resolved)
}

fn extract_zip_safe(zip_path: &Path, dst: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| format!("Cannot open zip: {e}"))?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid zip: {e}"))?;

    let mut nested_zips: Vec<PathBuf> = Vec::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| format!("Zip entry error: {e}"))?;
        let name = file.name();

        let is_xml = name.ends_with("test_result.xml");
        let is_nested_zip = name.ends_with(".zip");

        if !is_xml && !is_nested_zip {
            continue;
        }

        let outpath = match file.enclosed_name() {
            Some(path) => dst.join(path),
            None => continue,
        };

        if let Some(p) = outpath.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let mut outfile = File::create(&outpath).map_err(|e| format!("Cannot write file: {e}"))?;
        let _ = std::io::copy(&mut file, &mut outfile);

        if is_nested_zip {
            nested_zips.push(outpath);
        }
    }

    // Extract nested zips
    for sub_zip in nested_zips {
        if let Some(sub_dst) = sub_zip.parent() {
            let _ = extract_zip_safe(&sub_zip, sub_dst);
        }
    }

    Ok(())
}

fn scan_laundry_result_infos(root: &Path, original_zip_path: &Path) -> Result<Vec<LaundryResultInfo>, String> {
    let mut results = Vec::new();

    let filename_model = original_zip_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .and_then(|name| extract_model_from_name(&name))
        .unwrap_or_default();

    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if entry.file_name() == "test_result.xml" {
            let xml_path = entry.path();
            if let Ok(content) = std::fs::read_to_string(xml_path) {
                let suite = if xml_path.to_string_lossy().contains("gts") {
                    "GTS".to_string()
                } else if xml_path.to_string_lossy().contains("sts") {
                    "STS".to_string()
                } else {
                    "CTS".to_string()
                };

                let parsed_model = parse_xml_string_attr(&content, "build_model")
                    .or_else(|| parse_xml_string_attr(&content, "build_device"))
                    .or_else(|| parse_xml_entry_value(&content, "build_model"))
                    .unwrap_or_else(|| filename_model.clone());

                let formatted_model = if parsed_model.starts_with("SM-") {
                    parsed_model
                } else if !parsed_model.is_empty() {
                    format!("SM-{}", parsed_model.to_uppercase())
                } else {
                    filename_model.clone()
                };

                let total = parse_xml_attr(&content, "modules_total").unwrap_or(0);
                let passed = parse_xml_attr(&content, "modules_done").unwrap_or(0);
                let failed = parse_xml_attr(&content, "modules_not_done").unwrap_or(0);

                let testcase_name = xml_path
                    .parent()
                    .and_then(|p| p.file_name())
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                results.push(LaundryResultInfo {
                    id: format!("{}_{}", suite, testcase_name),
                    suite,
                    testcase: testcase_name,
                    subtestcases: format!("{passed}/{total} Modul Done"),
                    status: if failed > 0 { "fail".to_string() } else { "pass".to_string() },
                    time: "00:00:00".to_string(),
                    total,
                    passed,
                    failed,
                    suite_version: "14_r2".to_string(),
                    result_dir: xml_path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                    model: formatted_model,
                });
            }
        }
    }

    Ok(results)
}

fn extract_model_from_name(filename: &str) -> Option<String> {
    let base = filename.strip_suffix(".zip").unwrap_or(filename);
    let first_token = base.split('_').next().unwrap_or(base);

    if first_token.starts_with("SM-") || first_token.starts_with("sm-") {
        return Some(first_token.to_uppercase());
    }

    let mut model_part = String::new();
    for ch in first_token.chars() {
        if ch.is_ascii_alphanumeric() {
            model_part.push(ch);
            if model_part.len() >= 5 && (model_part.ends_with('F') || model_part.ends_with('B') || model_part.ends_with('G') || model_part.ends_with('E') || model_part.ends_with('P') || model_part.ends_with('N') || model_part.ends_with('U') || model_part.ends_with('W')) {
                break;
            }
        } else {
            break;
        }
    }

    if !model_part.is_empty() && model_part.len() >= 4 {
        return Some(format!("SM-{}", model_part.to_uppercase()));
    }
    None
}

fn parse_xml_attr(content: &str, attr: &str) -> Option<u64> {
    let pattern = format!("{attr}=\"");
    if let Some(start) = content.find(&pattern) {
        let rest = &content[start + pattern.len()..];
        if let Some(end) = rest.find('"') {
            return rest[..end].parse().ok();
        }
    }
    None
}

fn parse_xml_string_attr(content: &str, attr: &str) -> Option<String> {
    let pattern = format!("{attr}=\"");
    if let Some(start) = content.find(&pattern) {
        let rest = &content[start + pattern.len()..];
        if let Some(end) = rest.find('"') {
            let val = rest[..end].trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

fn parse_xml_entry_value(content: &str, entry_name: &str) -> Option<String> {
    let pattern = format!("name=\"{entry_name}\"");
    if let Some(start) = content.find(&pattern) {
        let rest = &content[start + pattern.len()..];
        if let Some(val_idx) = rest.find("value=\"") {
            let val_rest = &rest[val_idx + 7..];
            if let Some(end) = val_rest.find('"') {
                let val = val_rest[..end].trim();
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}
