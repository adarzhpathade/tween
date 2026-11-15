//! Ports `src/lib/remotezip.js`.
//! Read single files out of a .zip that lives on a web server, using HTTP Range requests.

use std::sync::Mutex;

#[derive(Debug, Clone)]
pub struct ZipEntry {
    pub name: String,
    pub method: u16,
    pub csize: u64,
    pub size: u64,
    pub offset: u64,
}

pub struct RemoteZip {
    client: reqwest::Client,
    orig_url: String,
    resolved_url: Mutex<String>,
    pub size: u64,
    pub entries: Vec<ZipEntry>,
}

#[derive(Debug, Clone)]
pub struct ResolvedUrl {
    pub url: String,
    pub ranges: bool,
    pub size: u64,
}

pub async fn resolve_url(client: &reqwest::Client, url: &str) -> Result<ResolvedUrl, String> {
    let res = client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let final_url = res.url().to_string();
    let status = res.status();

    if status != reqwest::StatusCode::PARTIAL_CONTENT {
        let size = res
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        return Ok(ResolvedUrl {
            url: final_url,
            ranges: false,
            size,
        });
    }

    let total = res
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|h| h.to_str().ok())
        .and_then(|cr| cr.split('/').nth(1))
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);

    Ok(ResolvedUrl {
        url: final_url,
        ranges: total > 0,
        size: total,
    })
}

pub async fn fetch_range(
    client: &reqwest::Client,
    orig_url: &str,
    resolved_url: &Mutex<String>,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, String> {
    for _attempt in 0..3 {
        let url = {
            resolved_url
                .lock()
                .map_err(|e| e.to_string())?
                .clone()
        };

        let res = client
            .get(&url)
            .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
            .send()
            .await;

        match res {
            Ok(resp) => {
                let status = resp.status();
                if status == reqwest::StatusCode::PARTIAL_CONTENT {
                    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
                    return Ok(bytes.to_vec());
                }
                if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::GONE {
                    // signed URL expired (403 or 410)
                    let resolved = resolve_url(client, orig_url).await?;
                    if let Ok(mut lock) = resolved_url.lock() {
                        *lock = resolved.url;
                    }
                    continue;
                }
                return Err(format!("Range request failed (HTTP {status})"));
            }
            Err(e) => {
                return Err(format!("Range request failed: {e}"));
            }
        }
    }
    Err("Range request failed after retries".to_string())
}

fn read_u16_le(buf: &[u8], offset: usize) -> Result<u16, String> {
    if offset + 2 > buf.len() {
        return Err("Unexpected EOF reading u16".to_string());
    }
    Ok(u16::from_le_bytes([buf[offset], buf[offset + 1]]))
}

fn read_u32_le(buf: &[u8], offset: usize) -> Result<u32, String> {
    if offset + 4 > buf.len() {
        return Err("Unexpected EOF reading u32".to_string());
    }
    Ok(u32::from_le_bytes([
        buf[offset],
        buf[offset + 1],
        buf[offset + 2],
        buf[offset + 3],
    ]))
}

fn read_u64_le(buf: &[u8], offset: usize) -> Result<u64, String> {
    if offset + 8 > buf.len() {
        return Err("Unexpected EOF reading u64".to_string());
    }
    let mut b = [0u8; 8];
    b.copy_from_slice(&buf[offset..offset + 8]);
    Ok(u64::from_le_bytes(b))
}

fn last_index_of(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    for i in (0..=haystack.len() - needle.len()).rev() {
        if &haystack[i..i + needle.len()] == needle {
            return Some(i);
        }
    }
    None
}

fn zip64_extra(extra: &[u8], entry: &mut ZipEntry) {
    let mut p = 0;
    while p + 4 <= extra.len() {
        let id = match read_u16_le(extra, p) {
            Ok(v) => v,
            Err(_) => break,
        };
        let len = match read_u16_le(extra, p + 2) {
            Ok(v) => v as usize,
            Err(_) => break,
        };
        if id == 0x0001 {
            let mut q = p + 4;
            let end_extra = (p + 4 + len).min(extra.len());
            if entry.size == 0xffff_ffff && q + 8 <= end_extra {
                if let Ok(v) = read_u64_le(extra, q) {
                    entry.size = v;
                    q += 8;
                }
            }
            if entry.csize == 0xffff_ffff && q + 8 <= end_extra {
                if let Ok(v) = read_u64_le(extra, q) {
                    entry.csize = v;
                    q += 8;
                }
            }
            if entry.offset == 0xffff_ffff && q + 8 <= end_extra {
                if let Ok(v) = read_u64_le(extra, q) {
                    entry.offset = v;
                }
            }
        }
        p += 4 + len;
    }
}

impl RemoteZip {
    /// Open a remote zip. Returns None if the server does not support Range requests.
    pub async fn open(url: &str) -> Result<Option<Self>, String> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| format!("Failed to create reqwest client: {e}"))?;

        let resolved = resolve_url(&client, url).await?;
        if !resolved.ranges {
            return Ok(None);
        }

        let tail_len = resolved.size.min(65557 + 20);
        let tail = fetch_range(
            &client,
            url,
            &Mutex::new(resolved.url.clone()),
            resolved.size - tail_len,
            resolved.size - 1,
        )
        .await?;

        let eocd = match last_index_of(&tail, &[0x50, 0x4b, 0x05, 0x06]) {
            Some(i) => i,
            None => return Err("Not a zip file (no end-of-central-directory record)".to_string()),
        };

        let mut count = read_u16_le(&tail, eocd + 10)? as u64;
        let mut cd_size = read_u32_le(&tail, eocd + 12)? as u64;
        let mut cd_off = read_u32_le(&tail, eocd + 16)? as u64;

        let resolved_url_mutex = Mutex::new(resolved.url);

        if cd_off == 0xffff_ffff || count == 0xffff {
            let loc = match last_index_of(&tail, &[0x50, 0x4b, 0x06, 0x07]) {
                Some(i) => i,
                None => return Err("Zip64 locator missing".to_string()),
            };
            let z64_off = read_u64_le(&tail, loc + 8)?;
            let z = fetch_range(&client, url, &resolved_url_mutex, z64_off, z64_off + 55).await?;
            count = read_u64_le(&z, 32)?;
            cd_size = read_u64_le(&z, 40)?;
            cd_off = read_u64_le(&z, 48)?;
        }

        let cd = fetch_range(
            &client,
            url,
            &resolved_url_mutex,
            cd_off,
            cd_off + cd_size - 1,
        )
        .await?;

        let mut entries = Vec::new();
        let mut p = 0;
        for _ in 0..count {
            if p + 46 > cd.len() {
                break;
            }
            if read_u32_le(&cd, p)? != 0x02014b50 {
                return Err("Corrupt central directory".to_string());
            }
            let method = read_u16_le(&cd, p + 10)?;
            let csize = read_u32_le(&cd, p + 20)? as u64;
            let size = read_u32_le(&cd, p + 24)? as u64;
            let name_len = read_u16_le(&cd, p + 28)? as usize;
            let extra_len = read_u16_le(&cd, p + 30)? as usize;
            let comment_len = read_u16_le(&cd, p + 32)? as usize;
            let offset = read_u32_le(&cd, p + 42)? as u64;

            if p + 46 + name_len > cd.len() {
                return Err("Corrupt central directory (name length exceeds buffer)".to_string());
            }

            let name = String::from_utf8_lossy(&cd[p + 46..p + 46 + name_len]).replace('\\', "/");
            let mut entry = ZipEntry {
                name,
                method,
                csize,
                size,
                offset,
            };

            if extra_len > 0 && p + 46 + name_len + extra_len <= cd.len() {
                let extra = &cd[p + 46 + name_len..p + 46 + name_len + extra_len];
                zip64_extra(extra, &mut entry);
            }

            entries.push(entry);
            p += 46 + name_len + extra_len + comment_len;
        }

        Ok(Some(Self {
            client,
            orig_url: url.to_string(),
            resolved_url: resolved_url_mutex,
            size: resolved.size,
            entries,
        }))
    }

    /// Extract a single entry from the remote zip directly to `dest`.
    pub async fn extract(&self, entry: &ZipEntry, dest: &std::path::Path) -> Result<(), String> {
        if entry.name.ends_with('/') {
            tokio::fs::create_dir_all(dest)
                .await
                .map_err(|e| format!("Failed to create directory {}: {e}", dest.display()))?;
            return Ok(());
        }

        let lh = fetch_range(
            &self.client,
            &self.orig_url,
            &self.resolved_url,
            entry.offset,
            entry.offset + 29,
        )
        .await?;

        if read_u32_le(&lh, 0)? != 0x04034b50 {
            return Err(format!("Bad local header for {}", entry.name));
        }

        let lh_name_len = read_u16_le(&lh, 26)? as u64;
        let lh_extra_len = read_u16_le(&lh, 28)? as u64;
        let start = entry.offset + 30 + lh_name_len + lh_extra_len;

        let raw = if entry.csize > 0 {
            fetch_range(
                &self.client,
                &self.orig_url,
                &self.resolved_url,
                start,
                start + entry.csize - 1,
            )
            .await?
        } else {
            Vec::new()
        };

        let data = match entry.method {
            0 => raw,
            8 => {
                use std::io::Read;
                let mut decoder = flate2::read::DeflateDecoder::new(&raw[..]);
                let mut decompressed = Vec::with_capacity(entry.size as usize);
                decoder
                    .read_to_end(&mut decompressed)
                    .map_err(|e| format!("Decompression failed for {}: {e}", entry.name))?;
                decompressed
            }
            m => return Err(format!("Unsupported compression method {m} for {}", entry.name)),
        };

        if data.len() as u64 != entry.size {
            return Err(format!("Size mismatch for {}", entry.name));
        }

        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create parent dir {}: {e}", parent.display()))?;
        }

        let part_path = format!("{}.part", dest.display());
        tokio::fs::write(&part_path, &data)
            .await
            .map_err(|e| format!("Failed to write {part_path}: {e}"))?;

        tokio::fs::rename(&part_path, dest)
            .await
            .map_err(|e| format!("Failed to rename {part_path} to {}: {e}", dest.display()))?;

        Ok(())
    }
}

/// Pull only the named files (by suffix after the zip's top folder) out of a remote zip.
pub async fn fetch_from_zip<F>(
    url: &str,
    want_rel: &[&str],
    dest_dir: &std::path::Path,
    mut on_bytes: F,
) -> Result<(), String>
where
    F: FnMut(u64, u64),
{
    let z = RemoteZip::open(url)
        .await?
        .ok_or_else(|| "Server does not support partial downloads".to_string())?;

    if z.entries.is_empty() {
        return Err("Zip archive is empty".to_string());
    }

    let top = z.entries[0]
        .name
        .split('/')
        .next()
        .unwrap_or("")
        .to_string();

    let root_re = regex::Regex::new(r"(rife-ncnn-vulkan(\.exe)?|bin/ff(mpeg|probe)(\.exe)?|^ff(mpeg|probe))$")
        .map_err(|e| e.to_string())?;

    let root = z
        .entries
        .iter()
        .find(|e| !e.name.ends_with('/') && root_re.is_match(&e.name));

    let prefix = match root {
        Some(r) => root_re.replace(&r.name, "").to_string(),
        None => format!("{top}/"),
    };

    let picks: Vec<&ZipEntry> = z
        .entries
        .iter()
        .filter(|e| {
            if e.name.ends_with('/') {
                return false;
            }
            if !e.name.starts_with(&prefix) {
                return false;
            }
            let rel = &e.name[prefix.len()..];
            want_rel.iter().any(|w| {
                if w.ends_with('/') {
                    rel.starts_with(*w)
                } else {
                    rel == *w
                }
            })
        })
        .collect();

    if picks.is_empty() {
        return Err("Expected files were not found in the archive".to_string());
    }

    let total: u64 = picks.iter().map(|e| e.csize).sum();
    let mut done: u64 = 0;

    for e in picks {
        let rel = &e.name[prefix.len()..];
        let stripped = rel.strip_prefix("bin/").unwrap_or(rel);
        let dest = dest_dir.join(stripped);
        z.extract(e, &dest).await?;
        done += e.csize;
        on_bytes(done, total);
    }

    Ok(())
}

/// Download an entire file with streaming to .part and rename.
pub async fn download_file<F>(url: &str, dest: &std::path::Path, mut on_bytes: F) -> Result<(), String>
where
    F: FnMut(u64, u64),
{
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("Failed to create client: {e}"))?;

    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {e}"))?;

    if !res.status().is_success() {
        return Err(format!(
            "Download failed (HTTP {}) for {url}",
            res.status()
        ));
    }

    let total = res
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create dir {}: {e}", parent.display()))?;
    }

    let part_path = format!("{}.part", dest.display());
    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| format!("Failed to create file {part_path}: {e}"))?;

    let mut stream = res.bytes_stream();
    let mut got: u64 = 0;

    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("Stream error: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write error: {e}"))?;
        got += chunk.len() as u64;
        on_bytes(got, total);
    }

    file.flush()
        .await
        .map_err(|e| format!("Flush error: {e}"))?;
    drop(file);

    tokio::fs::rename(&part_path, dest)
        .await
        .map_err(|e| format!("Rename error: {e}"))?;

    Ok(())
}

/// Throttles progress emission so that events are emitted at most every `interval_ms`.
pub struct ProgressThrottler<F> {
    callback: F,
    last_emit: Option<std::time::Instant>,
    interval: std::time::Duration,
}

impl<F: FnMut(u64, u64)> ProgressThrottler<F> {
    pub fn new(callback: F, interval_ms: u64) -> Self {
        Self {
            callback,
            last_emit: None,
            interval: std::time::Duration::from_millis(interval_ms),
        }
    }

    pub fn emit(&mut self, got: u64, total: u64) {
        let now = std::time::Instant::now();
        let should_emit = match self.last_emit {
            None => true,
            Some(last) => {
                now.duration_since(last) >= self.interval || (total > 0 && got >= total)
            }
        };
        if should_emit {
            self.last_emit = Some(now);
            (self.callback)(got, total);
        }
    }
}
