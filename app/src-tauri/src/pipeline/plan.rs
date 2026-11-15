use super::types::{
    Chunk, ChunkPlan, CutFix, ProbeInfo, RatioResult, RifeMapping, Target, TargetValue,
};
use std::collections::HashSet;

pub fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let temp = b;
        b = a % b;
        a = temp;
    }
    if a == 0 {
        1
    } else {
        a
    }
}

pub fn parse_rate(s: &str) -> (u64, u64, f64) {
    let s = s.trim();
    if s.is_empty() {
        return (0, 1, 0.0);
    }
    let mut parts = s.split('/');
    let n = parts
        .next()
        .and_then(|x| x.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let d = parts
        .next()
        .and_then(|x| x.trim().parse::<u64>().ok())
        .unwrap_or(1);
    let den = if d == 0 { 1 } else { d };
    let val = (n as f64) / (den as f64);
    (n, den, val)
}

pub fn ratio(info: &ProbeInfo, target: &Target) -> RatioResult {
    if target.mode == "multiplier" {
        let m = match &target.value {
            TargetValue::Number(n) => n.round() as u64,
            TargetValue::String(s) => s.parse::<f64>().unwrap_or(1.0).round() as u64,
        };
        let m = if m == 0 { 1 } else { m };
        return RatioResult {
            p: m,
            q: 1,
            out_fps_expr: format!("{}/{}", info.fps_num * m, info.fps_den),
            out_fps: info.fps * (m as f64),
        };
    }

    let fr = match &target.value {
        TargetValue::String(s) if s.contains('/') => parse_rate(s),
        TargetValue::String(s) => {
            let s_trim = s.trim();
            if s_trim == "59.94" || s_trim == "59.940" {
                (60000, 1001, 60000.0 / 1001.0)
            } else if s_trim == "29.97" || s_trim == "29.970" {
                (30000, 1001, 30000.0 / 1001.0)
            } else if s_trim == "23.976" || s_trim == "23.98" {
                (24000, 1001, 24000.0 / 1001.0)
            } else {
                let val = s.parse::<f64>().unwrap_or(0.0);
                if (val - 59.94).abs() < 0.005 {
                    (60000, 1001, 60000.0 / 1001.0)
                } else if (val - 29.97).abs() < 0.005 {
                    (30000, 1001, 30000.0 / 1001.0)
                } else if (val - 23.976).abs() < 0.005 {
                    (24000, 1001, 24000.0 / 1001.0)
                } else {
                    let expr = format!("{}/1000", (val * 1000.0).round() as u64);
                    parse_rate(&expr)
                }
            }
        }
        TargetValue::Number(val) => {
            if (*val - 59.94).abs() < 0.005 {
                (60000, 1001, 60000.0 / 1001.0)
            } else if (*val - 29.97).abs() < 0.005 {
                (30000, 1001, 30000.0 / 1001.0)
            } else if (*val - 23.976).abs() < 0.005 {
                (24000, 1001, 24000.0 / 1001.0)
            } else {
                let expr = format!("{}/1000", (*val * 1000.0).round() as u64);
                parse_rate(&expr)
            }
        }
    };

    let mut p = fr.0 * info.fps_den;
    let mut q = fr.1 * info.fps_num;
    let g = gcd(p, q);
    p /= g;
    q /= g;
    RatioResult {
        p,
        q,
        out_fps_expr: format!("{}/{}", fr.0, fr.1),
        out_fps: fr.2,
    }
}

pub fn plan_chunks(count: usize, p: u64, q: u64, chunk_in_frames: usize) -> ChunkPlan {
    let total = ((count as f64) * (p as f64) / (q as f64)).round() as usize;
    if q > 1000 || (count as u64) <= (chunk_in_frames as u64) + q {
        return ChunkPlan {
            total,
            chunks: vec![Chunk {
                a: 0,
                files: count,
                n: total,
                keep: total,
                out_offset: 0,
            }],
        };
    }

    let k = std::cmp::max(1, (chunk_in_frames as u64) / q) as usize;
    let mut chunks = Vec::new();
    let mut a = 0usize;
    let q_u = q as usize;
    let p_u = p as usize;

    while count - a > q_u * k + q_u {
        let out_offset = (a / q_u) * p_u;
        chunks.push(Chunk {
            a,
            files: q_u * k + q_u,
            n: (k + 1) * p_u,
            keep: k * p_u,
            out_offset,
        });
        a += q_u * k;
    }

    let out_offset = (a / q_u) * p_u;
    chunks.push(Chunk {
        a,
        files: count - a,
        n: total.saturating_sub(out_offset),
        keep: total.saturating_sub(out_offset),
        out_offset,
    });

    ChunkPlan { total, chunks }
}

pub fn rife_map(i: usize, files: usize, n: usize) -> RifeMapping {
    let scale = (files as f64) / (n as f64);
    let mut fx: f32 = ((i as f64) * scale) as f32;
    let mut sx: i64 = fx.floor() as i64;
    fx -= sx as f32;
    if sx < 0 {
        sx = 0;
        fx = 0.0;
    }
    if sx >= (files as i64) - 1 {
        sx = (files as i64) - 2;
        fx = 1.0;
    }
    RifeMapping {
        sx: sx as usize,
        t: fx,
    }
}

pub fn cut_fixes(chunk: &Chunk, cuts: &HashSet<usize>) -> Vec<CutFix> {
    let mut fixes = Vec::new();
    if cuts.is_empty() {
        return fixes;
    }
    for i in 0..chunk.keep {
        let m = rife_map(i, chunk.files, chunk.n);
        if m.t > 0.0 && m.t < 1.0 && cuts.contains(&(chunk.a + m.sx + 1)) {
            let src = if m.t < 0.5 { m.sx } else { m.sx + 1 };
            fixes.push(CutFix { i, src });
        }
    }
    fixes
}

pub fn rife_threads(cpu_threads: usize, is_gpu: bool, is_integrated: bool) -> String {
    if !is_gpu || is_integrated {
        return "1:1:1".to_string();
    }
    if cpu_threads >= 8 {
        "4:2:4".to_string()
    } else if cpu_threads >= 4 {
        "2:2:2".to_string()
    } else {
        "1:1:1".to_string()
    }
}

pub fn chunk_size_with_disk(width: u32, height: u32, p: u64, q: u64, free_disk: Option<u64>) -> usize {
    let in_per_frame = (width as f64) * (height as f64) * 3.1;
    let out_per_frame = (width as f64) * (height as f64) * 1.6;
    let ratio = (p as f64) / (q as f64);
    let bytes_per_input_frame = in_per_frame + (out_per_frame * ratio);

    let max_target_bytes: f64 = 4.0e9; // 4 GB cap
    let target_bytes = if let Some(free) = free_disk {
        let available = free.saturating_sub(1_000_000_000) as f64;
        let per_chunk = (available / 2.0).max(1.0e8);
        per_chunk.min(max_target_bytes)
    } else {
        max_target_bytes
    };

    let raw = (target_bytes / bytes_per_input_frame).round() as i64;
    raw.clamp(24, 1500) as usize
}

pub fn chunk_size(width: u32, height: u32, p: u64, q: u64) -> usize {
    chunk_size_with_disk(width, height, p, q, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rife_threads_tuning() {
        assert_eq!(rife_threads(16, true, false), "4:2:4");
        assert_eq!(rife_threads(8, true, false), "4:2:4");
        assert_eq!(rife_threads(6, true, false), "2:2:2");
        assert_eq!(rife_threads(4, true, false), "2:2:2");
        assert_eq!(rife_threads(2, true, false), "1:1:1");
        assert_eq!(rife_threads(16, true, true), "1:1:1"); // integrated GPU
        assert_eq!(rife_threads(16, false, false), "1:1:1"); // CPU mode
    }

    #[test]
    fn test_chunk_size_uncompressed_and_caps() {
        // 1080p at 2x with no disk limit reaches 4 GB cap (~300 frames instead of old ~93)
        let cs_1080p_2x = chunk_size(1920, 1080, 2, 1);
        assert!((280..=350).contains(&cs_1080p_2x), "Expected ~306 frames for 1080p 2x, got {}", cs_1080p_2x);

        // Low resolution capped at 1500 frames
        let cs_low_res = chunk_size(320, 240, 2, 1);
        assert_eq!(cs_low_res, 1500);

        // High resolution still at least 24 frames
        let cs_4k_4x = chunk_size(3840, 2160, 4, 1);
        assert!(cs_4k_4x >= 24);

        // With tight free disk space (e.g. 2 GB free -> 500 MB per chunk)
        let cs_tight = chunk_size_with_disk(1920, 1080, 2, 1, Some(2_000_000_000));
        assert!(cs_tight < cs_1080p_2x, "Tight disk chunk size {} should be smaller than uncapped {}", cs_tight, cs_1080p_2x);
        assert!(cs_tight >= 24);

        // With ample free disk space (e.g. 100 GB free -> 4 GB cap)
        let cs_ample = chunk_size_with_disk(1920, 1080, 2, 1, Some(100_000_000_000));
        assert_eq!(cs_ample, cs_1080p_2x);
    }
}
