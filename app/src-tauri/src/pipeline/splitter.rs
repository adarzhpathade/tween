pub struct PngSplitter {
    buf: Vec<u8>,
}

impl Default for PngSplitter {
    fn default() -> Self {
        Self::new()
    }
}

impl PngSplitter {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn push<F>(&mut self, data: &[u8], mut on_image: F)
    where
        F: FnMut(Vec<u8>),
    {
        self.buf.extend_from_slice(data);
        loop {
            if self.buf.len() < 8 {
                return;
            }
            let mut p = 8;
            let mut end = None;
            while p + 8 <= self.buf.len() {
                let len = u32::from_be_bytes([
                    self.buf[p],
                    self.buf[p + 1],
                    self.buf[p + 2],
                    self.buf[p + 3],
                ]) as usize;
                let chunk_type = &self.buf[p + 4..p + 8];
                let next_p = match p.checked_add(12).and_then(|x| x.checked_add(len)) {
                    Some(np) => np,
                    None => return,
                };
                p = next_p;
                if chunk_type == b"IEND" {
                    end = Some(p);
                    break;
                }
            }
            match end {
                Some(e) if e <= self.buf.len() => {
                    let image = self.buf.drain(..e).collect::<Vec<u8>>();
                    on_image(image);
                }
                _ => return,
            }
        }
    }
}
