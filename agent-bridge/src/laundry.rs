use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use tempfile::TempDir;
use walkdir::WalkDir;
use zip::ZipArchive;
use crate::types::LaundryResultInfo;

pub fn analyze_laundry_zip(zip_path: &str) -> Result<Vec<LaundryResultInfo>, String> {
    let path = Path::new(zip_path);
    if !path.is_file() {
        return Err(format!("File zip tidak ditemukan: {zip_path}"));
    }

    let temp = TempDir::new().map_err(|e| format!("Cannot create temp dir: {e}"))?;
    extract_zip_safe(path, temp.path())?;
    scan_laundry_result_infos(temp.path())
}

fn extract_zip_safe(zip_path: &Path, dst: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| format!("Cannot open zip: {e}"))?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid zip: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| format!("Zip entry error: {e}"))?;
        let name = file.name();
        // Extract test_result.xml only for instant parsing speed
        if !name.ends_with("test_result.xml") && !name.ends_with("device-info.log") {
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
    }
    Ok(())
}

fn scan_laundry_result_infos(root: &Path) -> Result<Vec<LaundryResultInfo>, String> {
    let mut results = Vec::new();

    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if entry.file_name() == "test_result.xml" {
            let xml_path = entry.path();
            if let Some(parent) = xml_path.parent() {
                if let Ok(content) = std::fs::read_to_string(xml_path) {
                    let suite = if xml_path.to_string_lossy().contains("gts") {
                        "GTS".to_string()
                    } else if xml_path.to_string_lossy().contains("sts") {
                        "STS".to_string()
                    } else {
                        "CTS".to_string()
                    };

                    let total = parse_xml_attr(&content, "modules_total").unwrap_or(0);
                    let passed = parse_xml_attr(&content, "modules_done").unwrap_or(0);
                    let failed = parse_xml_attr(&content, "modules_not_done").unwrap_or(0);

                    results.push(LaundryResultInfo {
                        id: parent.file_name().unwrap_or_default().to_string_lossy().to_string(),
                        suite,
                        testcase: parent.file_name().unwrap_or_default().to_string_lossy().to_string(),
                        subtestcases: format!("{passed}/{total} Done"),
                        status: if failed > 0 { "fail".to_string() } else { "pass".to_string() },
                        time: "00:00:00".to_string(),
                        total,
                        passed,
                        failed,
                        suite_version: "13.0".to_string(),
                        result_dir: parent.to_string_lossy().to_string(),
                        model: "".to_string(),
                    });
                }
            }
        }
    }

    Ok(results)
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
