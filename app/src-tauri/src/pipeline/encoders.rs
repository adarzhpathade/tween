#[derive(Debug, Clone)]
pub struct EncoderDef {
    pub id: &'static str,
    pub name: &'static str,
    pub fmt: &'static str,
    args_fn: fn(u32) -> Vec<String>,
}

impl EncoderDef {
    pub fn args(&self, q: u32) -> Vec<String> {
        (self.args_fn)(q)
    }
}

pub static ENCODERS: &[EncoderDef] = &[
    EncoderDef {
        id: "hevc_nvenc",
        name: "H.265 · NVIDIA",
        fmt: "yuv420p",
        args_fn: |q| {
            vec![
                "-c:v".into(),
                "hevc_nvenc".into(),
                "-preset".into(),
                "p6".into(),
                "-tune".into(),
                "hq".into(),
                "-rc".into(),
                "vbr".into(),
                "-cq".into(),
                q.to_string(),
                "-b:v".into(),
                "0".into(),
                "-spatial-aq".into(),
                "1".into(),
                "-temporal-aq".into(),
                "1".into(),
                "-tag:v".into(),
                "hvc1".into(),
            ]
        },
    },
    EncoderDef {
        id: "h264_nvenc",
        name: "H.264 · NVIDIA",
        fmt: "yuv420p",
        args_fn: |q| {
            vec![
                "-c:v".into(),
                "h264_nvenc".into(),
                "-preset".into(),
                "p6".into(),
                "-tune".into(),
                "hq".into(),
                "-rc".into(),
                "vbr".into(),
                "-cq".into(),
                q.to_string(),
                "-b:v".into(),
                "0".into(),
                "-spatial-aq".into(),
                "1".into(),
                "-temporal-aq".into(),
                "1".into(),
            ]
        },
    },
    EncoderDef {
        id: "hevc_amf",
        name: "H.265 · AMD",
        fmt: "yuv420p",
        args_fn: |q| {
            vec![
                "-c:v".into(),
                "hevc_amf".into(),
                "-quality".into(),
                "quality".into(),
                "-rc".into(),
                "cqp".into(),
                "-qp_i".into(),
                q.to_string(),
                "-qp_p".into(),
                (q + 2).to_string(),
                "-tag:v".into(),
                "hvc1".into(),
            ]
        },
    },
    EncoderDef {
        id: "h264_amf",
        name: "H.264 · AMD",
        fmt: "yuv420p",
        args_fn: |q| {
            vec![
                "-c:v".into(),
                "h264_amf".into(),
                "-quality".into(),
                "quality".into(),
                "-rc".into(),
                "cqp".into(),
                "-qp_i".into(),
                q.to_string(),
                "-qp_p".into(),
                (q + 2).to_string(),
                "-qp_b".into(),
                (q + 4).to_string(),
            ]
        },
    },
    EncoderDef {
        id: "hevc_qsv",
        name: "H.265 · Intel",
        fmt: "nv12",
        args_fn: |q| {
            vec![
                "-c:v".into(),
                "hevc_qsv".into(),
                "-preset".into(),
                "slower".into(),
                "-global_quality".into(),
                q.to_string(),
                "-tag:v".into(),
                "hvc1".into(),
            ]
        },
    },
    EncoderDef {
        id: "h264_qsv",
        name: "H.264 · Intel",
        fmt: "nv12",
        args_fn: |q| {
            vec![
                "-c:v".into(),
                "h264_qsv".into(),
                "-preset".into(),
                "slower".into(),
                "-global_quality".into(),
                q.to_string(),
            ]
        },
    },
    EncoderDef {
        id: "hevc_videotoolbox",
        name: "H.265 · Apple",
        fmt: "nv12",
        args_fn: |q| {
            let val = (100i32 - (q as i32 - 10) * 3).clamp(1, 100);
            vec![
                "-c:v".into(),
                "hevc_videotoolbox".into(),
                "-q:v".into(),
                val.to_string(),
                "-tag:v".into(),
                "hvc1".into(),
            ]
        },
    },
    EncoderDef {
        id: "h264_videotoolbox",
        name: "H.264 · Apple",
        fmt: "nv12",
        args_fn: |q| {
            let val = (100i32 - (q as i32 - 10) * 3).clamp(1, 100);
            vec![
                "-c:v".into(),
                "h264_videotoolbox".into(),
                "-q:v".into(),
                val.to_string(),
            ]
        },
    },
    EncoderDef {
        id: "libx265",
        name: "H.265 · CPU",
        fmt: "yuv420p",
        args_fn: |q| {
            vec![
                "-c:v".into(),
                "libx265".into(),
                "-preset".into(),
                "medium".into(),
                "-crf".into(),
                (q + 2).to_string(),
                "-tag:v".into(),
                "hvc1".into(),
            ]
        },
    },
    EncoderDef {
        id: "libx264",
        name: "H.264 · CPU",
        fmt: "yuv420p",
        args_fn: |q| {
            vec![
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "slow".into(),
                "-crf".into(),
                q.to_string(),
            ]
        },
    },
];

pub fn get_encoder(id: &str) -> &'static EncoderDef {
    ENCODERS
        .iter()
        .find(|e| e.id == id)
        .unwrap_or(&ENCODERS[9]) // default libx264
}
