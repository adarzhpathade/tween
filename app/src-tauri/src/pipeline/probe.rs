use super::plan::parse_rate;
use super::types::{ColourInfo, ColourInput, PipelineConfig, ProbeInfo};
use std::path::Path;

pub fn colour_of(v: &ColourInput) -> ColourInfo {
    let matrix = match v.color_space.as_deref() {
        Some("bt709") => "bt709",
        Some("smpte170m") | Some("bt470bg") => "bt601",
        Some("bt2020nc") | Some("bt2020c") => "bt2020",
        Some("smpte240m") => "smpte240m",
        Some("fcc") => "fcc",
        _ => {
            if v.height >= 720 {
                "bt709"
            } else {
                "bt601"
            }
        }
    };

    let def = match matrix {
        "bt709" => "bt709",
        "bt2020" => "bt2020",
        _ => "smpte170m",
    };

    let range = if v.color_range.as_deref() == Some("pc") {
        "pc"
    } else {
        "tv"
    };

    let space = match matrix {
        "bt709" => "bt709",
        "bt601" => "smpte170m",
        "bt2020" => "bt2020nc",
        "smpte240m" => "smpte240m",
        "fcc" => "fcc",
        other => other,
    };

    let primaries = match v.color_primaries.as_deref() {
        Some(p) if !p.is_empty() && p != "unknown" => p,
        _ => def,
    };

    let trc = match v.color_transfer.as_deref() {
        Some(t) if !t.is_empty() && t != "unknown" => t.to_string(),
        _ => {
            if def == "bt2020" {
                "bt709".to_string()
            } else {
                def.to_string()
            }
        }
    };

    let hdr = v
        .color_transfer
        .as_deref()
        .map(|ct| ct.contains("smpte2084") || ct.contains("arib-std-b67"))
        .unwrap_or(false);

    ColourInfo {
        matrix: matrix.to_string(),
        range: range.to_string(),
        space: space.to_string(),
        primaries: primaries.to_string(),
        trc,
        hdr,
    }
}

pub async fn probe(cfg: &PipelineConfig, file: &str) -> Result<ProbeInfo, String> {
    let mut cmd = tokio::process::Command::new(&cfg.ffprobe);
    cmd.args([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        file,
    ]);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("ffprobe failed to run: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe failed: {}", err.trim()));
    }

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let j: serde_json::Value = serde_json::from_str(&stdout_str)
        .map_err(|e| format!("Failed to parse ffprobe json: {}", e))?;

    let streams = j
        .get("streams")
        .and_then(|s| s.as_array())
        .ok_or_else(|| "No streams found in ffprobe output".to_string())?;

    let v = streams
        .iter()
        .find(|s| {
            s.get("codec_type").and_then(|c| c.as_str()) == Some("video")
                && s.get("disposition")
                    .and_then(|d| d.get("attached_pic"))
                    .and_then(|a| a.as_i64())
                    != Some(1)
        })
        .ok_or_else(|| "No video stream found in this file.".to_string())?;

    let a = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("audio"));

    let avg_fps = v
        .get("avg_frame_rate")
        .and_then(|f| f.as_str())
        .unwrap_or("0/0");
    let r_fps = v
        .get("r_frame_rate")
        .and_then(|f| f.as_str())
        .unwrap_or("0/1");
    let rate_str = if avg_fps != "0/0" { avg_fps } else { r_fps };
    let rate = parse_rate(rate_str);

    let format_obj = j.get("format");
    let duration = v
        .get("duration")
        .and_then(|d| d.as_str().and_then(|s| s.parse::<f64>().ok()))
        .or_else(|| {
            format_obj
                .and_then(|f| f.get("duration"))
                .and_then(|d| d.as_str().and_then(|s| s.parse::<f64>().ok()))
        })
        .unwrap_or(0.0);

    let rot_from_side = v
        .get("side_data_list")
        .and_then(|sdl| sdl.as_array())
        .and_then(|arr| {
            arr.iter().find_map(|s| {
                s.get("rotation").and_then(|r| {
                    r.as_f64()
                        .or_else(|| r.as_str().and_then(|st| st.parse::<f64>().ok()))
                })
            })
        })
        .unwrap_or(0.0);

    let rot_from_tags = v
        .get("tags")
        .and_then(|t| t.get("rotate"))
        .and_then(|r| {
            r.as_f64()
                .or_else(|| r.as_str().and_then(|st| st.parse::<f64>().ok()))
        })
        .unwrap_or(0.0);

    let rot_deg = if rot_from_side != 0.0 {
        rot_from_side
    } else {
        rot_from_tags
    };
    let rot = (rot_deg.abs().round() as i64) % 180 == 90;

    let raw_w = v
        .get("width")
        .and_then(|w| w.as_u64())
        .unwrap_or(0) as u32;
    let raw_h = v
        .get("height")
        .and_then(|h| h.as_u64())
        .unwrap_or(0) as u32;

    let (width, height) = if rot {
        (raw_h, raw_w)
    } else {
        (raw_w, raw_h)
    };

    let codec = v
        .get("codec_name")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let pix_fmt = v
        .get("pix_fmt")
        .and_then(|p| p.as_str())
        .unwrap_or("")
        .to_string();

    let vfr = avg_fps != r_fps;
    let frames = v
        .get("nb_frames")
        .and_then(|f| {
            f.as_str().and_then(|s| s.parse::<u64>().ok()).or_else(|| f.as_u64())
        })
        .unwrap_or_else(|| (duration * rate.2).round() as u64);

    let has_audio = a.is_some();
    let audio_codec = a.and_then(|s| s.get("codec_name").and_then(|c| c.as_str()).map(String::from));

    let colour_input = ColourInput {
        height,
        color_space: v.get("color_space").and_then(|c| c.as_str()).map(String::from),
        color_range: v.get("color_range").and_then(|c| c.as_str()).map(String::from),
        color_primaries: v.get("color_primaries").and_then(|c| c.as_str()).map(String::from),
        color_transfer: v.get("color_transfer").and_then(|c| c.as_str()).map(String::from),
    };
    let colour = colour_of(&colour_input);

    let size = format_obj
        .and_then(|f| f.get("size"))
        .and_then(|s| {
            s.as_str().and_then(|st| st.parse::<u64>().ok()).or_else(|| s.as_u64())
        })
        .unwrap_or(0);

    let file_path = Path::new(file);
    let name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(file)
        .to_string();

    Ok(ProbeInfo {
        file: file.to_string(),
        name,
        width,
        height,
        codec,
        pix_fmt,
        fps_num: rate.0,
        fps_den: rate.1,
        fps: rate.2,
        vfr,
        duration,
        frames,
        has_audio,
        audio_codec,
        colour,
        size,
    })
}

pub fn split_mjpeg(buf: &[u8]) -> Vec<&[u8]> {
    let mut images = Vec::new();
    let mut i = 0;
    while i + 1 < buf.len() {
        if buf[i] == 0xFF && buf[i + 1] == 0xD8 {
            let start = i;
            i += 2;
            while i + 1 < buf.len() {
                if buf[i] == 0xFF && buf[i + 1] == 0xD9 {
                    images.push(&buf[start..=i + 1]);
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    images
}

pub async fn extract_thumbnails(
    cfg: &PipelineConfig,
    file: &str,
    count: usize,
    height: u32,
) -> Result<Vec<String>, String> {
    if count == 0 {
        return Ok(Vec::new());
    }
    let h = if height == 0 { 56 } else { height };

    let dur = match probe(cfg, file).await {
        Ok(info) if info.duration > 0.0 => info.duration,
        _ => 1.0,
    };

    let fps = (count as f64) / dur;
    let mut cmd = tokio::process::Command::new(&cfg.ffmpeg);
    cmd.args([
        "-nostdin",
        "-y",
        "-an",
        "-sn",
        "-dn",
        "-i",
        file,
        "-vf",
        &format!("fps={:.4},scale=-2:{}", fps, h),
        "-frames:v",
        &count.to_string(),
        "-pix_fmt",
        "yuvj420p",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-q:v",
        "3",
        "pipe:1",
    ]);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("ffmpeg thumbnails failed to run: {e}"))?;

    if !output.status.success() && output.stdout.is_empty() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg extract thumbnails failed: {}", err.trim()));
    }

    use base64::Engine;
    let parts = split_mjpeg(&output.stdout);
    let mut result = Vec::with_capacity(parts.len());
    for part in parts {
        let b64 = base64::engine::general_purpose::STANDARD.encode(part);
        result.push(format!("data:image/jpeg;base64,{}", b64));
    }

    Ok(result)
}

pub async fn extract_frame(
    cfg: &PipelineConfig,
    file: &str,
    time: Option<f64>,
) -> Result<String, String> {
    let t = time.unwrap_or(0.0);
    let mut cmd = tokio::process::Command::new(&cfg.ffmpeg);

    let mut args: Vec<String> = vec![
        "-nostdin".into(),
        "-y".into(),
    ];

    if t > 0.0 {
        args.push("-ss".into());
        args.push(format!("{:.3}", t));
    }

    args.extend([
        "-i".into(),
        file.into(),
        "-map".into(),
        "0:v:0".into(),
        "-frames:v".into(),
        "1".into(),
        "-an".into(),
        "-sn".into(),
        "-dn".into(),
        "-pix_fmt".into(),
        "yuvj420p".into(),
        "-f".into(),
        "image2pipe".into(),
        "-vcodec".into(),
        "mjpeg".into(),
        "-q:v".into(),
        "2".into(),
        "pipe:1".into(),
    ]);

    cmd.args(&args);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().await.map_err(|e| format!("ffmpeg failed: {e}"))?;

    let stdout = if output.status.success() && !output.stdout.is_empty() {
        output.stdout
    } else {
        let mut fb = tokio::process::Command::new(&cfg.ffmpeg);
        let mut fb_args: Vec<String> = vec![
            "-nostdin".into(),
            "-y".into(),
            "-i".into(),
            file.into(),
        ];
        if t > 0.0 {
            fb_args.push("-ss".into());
            fb_args.push(format!("{:.3}", t));
        }
        fb_args.extend([
            "-map".into(),
            "0:v:0".into(),
            "-frames:v".into(),
            "1".into(),
            "-an".into(),
            "-sn".into(),
            "-dn".into(),
            "-pix_fmt".into(),
            "yuvj420p".into(),
            "-f".into(),
            "image2pipe".into(),
            "-vcodec".into(),
            "mjpeg".into(),
            "-q:v".into(),
            "2".into(),
            "pipe:1".into(),
        ]);
        fb.args(&fb_args);
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            fb.creation_flags(CREATE_NO_WINDOW);
        }
        let fb_out = fb.output().await.map_err(|e| format!("ffmpeg fallback failed: {e}"))?;
        if !fb_out.status.success() || fb_out.stdout.is_empty() {
            let err = String::from_utf8_lossy(&fb_out.stderr);
            let first_err = String::from_utf8_lossy(&output.stderr);
            let combined = if !err.trim().is_empty() {
                err.trim().to_string()
            } else {
                first_err.trim().to_string()
            };
            return Err(format!("ffmpeg extract frame failed: {}", combined));
        }
        fb_out.stdout
    };

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&stdout);
    Ok(format!("data:image/jpeg;base64,{}", b64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_extract_frame_bouncing_ball() {
        let has_ffmpeg = std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !has_ffmpeg {
            eprintln!("SKIPPING test_extract_frame_bouncing_ball: ffmpeg not on PATH");
            return;
        }

        let work = std::env::temp_dir().join(format!("tween-test-extract-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();

        let clip = work.join("Bouncing Ball.mp4");
        let status = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=1920x1080:rate=60",
                "-t",
                "2",
                "-pix_fmt",
                "yuv420p",
                "-c:v",
                "libx264",
                clip.to_str().unwrap(),
            ])
            .status()
            .unwrap();
        assert!(status.success());

        let cfg = PipelineConfig::default();
        let res = extract_frame(&cfg, clip.to_str().unwrap(), Some(0.0)).await;
        eprintln!("extract_frame result ok? {}", res.is_ok());
        if let Err(e) = &res {
            eprintln!("extract_frame error: {}", e);
        }
        let _ = std::fs::remove_dir_all(&work);
        assert!(res.is_ok(), "extract_frame failed: {:?}", res.err());
    }

    #[tokio::test]
    async fn test_extract_thumbnails() {
        let has_ffmpeg = std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !has_ffmpeg {
            return;
        }

        let work = std::env::temp_dir().join(format!("tween-test-thumbs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();

        let clip = work.join("test_clip.mp4");
        let status = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=30",
                "-t",
                "3",
                "-pix_fmt",
                "yuv420p",
                "-c:v",
                "libx264",
                clip.to_str().unwrap(),
            ])
            .status()
            .unwrap();
        assert!(status.success());

        let cfg = PipelineConfig::default();
        let res = extract_thumbnails(&cfg, clip.to_str().unwrap(), 5, 56).await;
        assert!(res.is_ok(), "thumbnails failed: {:?}", res.err());
        let thumbs = res.unwrap();
        assert_eq!(thumbs.len(), 5);
        for t in &thumbs {
            assert!(t.starts_with("data:image/jpeg;base64,"));
        }
        let _ = std::fs::remove_dir_all(&work);
    }
}


