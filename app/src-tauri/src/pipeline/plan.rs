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
            let val = s.parse::<f64>().unwrap_or(0.0);
            let expr = format!("{}/1000", (val * 1000.0).round() as u64);
            parse_rate(&expr)
        }
        TargetValue::Number(val) => {
            let expr = format!("{}/1000", (val * 1000.0).round() as u64);
            parse_rate(&expr)
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

pub fn chunk_size(width: u32, height: u32, p: u64, q: u64) -> usize {
    let per_frame = (width as f64) * (height as f64) * 1.6;
    let ratio = (p as f64) / (q as f64);
    let raw = (1.2e9 / (per_frame * (1.0 + ratio))).round() as i64;
    raw.clamp(24, 600) as usize
}
