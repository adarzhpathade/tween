//! Structural Similarity Index (SSIM) metric for RGB24 image comparison.
//! Used for the 10-frame self-test and quality verification.

/// Computes SSIM between two RGB24 image buffers of dimension `width` x `height`.
/// Buffers must have size `width * height * 3`.
pub fn calculate_ssim(a: &[u8], b: &[u8], width: usize, height: usize) -> f64 {
    let frame_bytes = width * height * 3;
    if a.len() < frame_bytes || b.len() < frame_bytes || width == 0 || height == 0 {
        return 0.0;
    }
    if a[..frame_bytes] == b[..frame_bytes] {
        return 1.0;
    }

    // Convert RGB24 to grayscale luminance: Y = 0.299 * R + 0.587 * G + 0.114 * B
    let mut y_a = Vec::with_capacity(width * height);
    let mut y_b = Vec::with_capacity(width * height);
    for i in 0..(width * height) {
        let off = i * 3;
        let l_a = 0.299 * (a[off] as f64) + 0.587 * (a[off + 1] as f64) + 0.114 * (a[off + 2] as f64);
        let l_b = 0.299 * (b[off] as f64) + 0.587 * (b[off + 1] as f64) + 0.114 * (b[off + 2] as f64);
        y_a.push(l_a);
        y_b.push(l_b);
    }

    const C1: f64 = 6.5025;  // (0.01 * 255)^2
    const C2: f64 = 58.5225; // (0.03 * 255)^2

    let window_size = 8;
    if width < window_size || height < window_size {
        // Fall back to whole-image SSIM if image is smaller than 8x8
        let n = (width * height) as f64;
        let mean_a = y_a.iter().sum::<f64>() / n;
        let mean_b = y_b.iter().sum::<f64>() / n;
        let var_a = y_a.iter().map(|&x| (x - mean_a).powi(2)).sum::<f64>() / (n - 1.0).max(1.0);
        let var_b = y_b.iter().map(|&x| (x - mean_b).powi(2)).sum::<f64>() / (n - 1.0).max(1.0);
        let cov_ab = y_a
            .iter()
            .zip(y_b.iter())
            .map(|(&x, &y)| (x - mean_a) * (y - mean_b))
            .sum::<f64>()
            / (n - 1.0).max(1.0);

        let numerator = (2.0 * mean_a * mean_b + C1) * (2.0 * cov_ab + C2);
        let denominator = (mean_a.powi(2) + mean_b.powi(2) + C1) * (var_a + var_b + C2);
        return (numerator / denominator).clamp(0.0, 1.0);
    }

    let n_blocks_x = width / window_size;
    let n_blocks_y = height / window_size;
    let n_pixels = (window_size * window_size) as f64;
    let mut total_ssim = 0.0;
    let mut count = 0;

    for by in 0..n_blocks_y {
        for bx in 0..n_blocks_x {
            let start_x = bx * window_size;
            let start_y = by * window_size;

            let mut sum_a = 0.0;
            let mut sum_b = 0.0;
            for dy in 0..window_size {
                for dx in 0..window_size {
                    let idx = (start_y + dy) * width + (start_x + dx);
                    sum_a += y_a[idx];
                    sum_b += y_b[idx];
                }
            }
            let mean_a = sum_a / n_pixels;
            let mean_b = sum_b / n_pixels;

            let mut var_a = 0.0;
            let mut var_b = 0.0;
            let mut cov_ab = 0.0;
            for dy in 0..window_size {
                for dx in 0..window_size {
                    let idx = (start_y + dy) * width + (start_x + dx);
                    let diff_a = y_a[idx] - mean_a;
                    let diff_b = y_b[idx] - mean_b;
                    var_a += diff_a * diff_a;
                    var_b += diff_b * diff_b;
                    cov_ab += diff_a * diff_b;
                }
            }
            var_a /= (n_pixels - 1.0).max(1.0);
            var_b /= (n_pixels - 1.0).max(1.0);
            cov_ab /= (n_pixels - 1.0).max(1.0);

            let num = (2.0 * mean_a * mean_b + C1) * (2.0 * cov_ab + C2);
            let den = (mean_a.powi(2) + mean_b.powi(2) + C1) * (var_a + var_b + C2);
            let block_ssim = (num / den).clamp(0.0, 1.0);

            total_ssim += block_ssim;
            count += 1;
        }
    }

    if count > 0 {
        total_ssim / (count as f64)
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_identical_ssim() {
        let frame = vec![128u8; 64 * 64 * 3];
        assert_eq!(calculate_ssim(&frame, &frame, 64, 64), 1.0);
    }

    #[test]
    fn test_minor_difference_high_ssim() {
        let frame_a = vec![128u8; 64 * 64 * 3];
        let mut frame_b = vec![128u8; 64 * 64 * 3];
        // Introduce tiny 1-value noise on 5 pixels
        for i in 0..5 {
            frame_b[i * 3] = 129;
        }
        let score = calculate_ssim(&frame_a, &frame_b, 64, 64);
        assert!(score > 0.999 && score < 1.0, "Expected very high SSIM, got {}", score);
    }

    #[test]
    fn test_inverted_image_low_ssim() {
        let frame_a = vec![0u8; 64 * 64 * 3];
        let frame_b = vec![255u8; 64 * 64 * 3];
        let score = calculate_ssim(&frame_a, &frame_b, 64, 64);
        assert!(score < 0.1, "Expected low SSIM, got {}", score);
    }
}
