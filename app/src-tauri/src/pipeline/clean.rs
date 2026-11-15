use std::path::Path;

pub fn clean_temp(root: Option<&Path>) {
    let tmp = match root {
        Some(r) => r.to_path_buf(),
        None => std::env::temp_dir(),
    };
    if let Ok(entries) = std::fs::read_dir(tmp) {
        for entry in entries.flatten() {
            if let Ok(name) = entry.file_name().into_string() {
                if name.starts_with("tween-") && !name.starts_with("tween-selftest") {
                    let p = entry.path();
                    if p.is_dir() {
                        let _ = std::fs::remove_dir_all(&p);
                    }
                }
            }
        }
    }
}
