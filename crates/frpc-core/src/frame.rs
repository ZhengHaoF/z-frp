//! 数据帧（WebSocket binary message）编解码。
//! 与 Node 端 packages/shared/src/protocol.ts 逐字节兼容。
//!
//! 格式（8 字节头 + payload）：
//!   [0..3] streamId  uint32 BE
//!   [4]    flags     bit0=FIN, bit1=RST
//!   [5..7] reserved  0
//!   [8..]  payload

pub const HEADER_SIZE: usize = 8;
pub const MAX_PAYLOAD: usize = 64 * 1024;
pub const FLAG_FIN: u8 = 0x01;
pub const FLAG_RST: u8 = 0x02;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataFrame {
    pub stream_id: u32,
    pub flags: u8,
    pub payload: Vec<u8>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("streamId 必须为 1..=u32::MAX，实际 {0}")]
    InvalidStreamId(u32),
    #[error("payload 超过 {MAX_PAYLOAD} 字节，实际 {0}")]
    PayloadTooLarge(usize),
    #[error("帧长度不足 {HEADER_SIZE} 字节，实际 {0}")]
    TooShort(usize),
}

/// 编码一帧；参数非法时返回错误（对应 Node 的抛错语义）。
pub fn encode_data_frame(stream_id: u32, payload: &[u8], flags: u8) -> Result<Vec<u8>, FrameError> {
    if stream_id == 0 {
        return Err(FrameError::InvalidStreamId(stream_id));
    }
    if payload.len() > MAX_PAYLOAD {
        return Err(FrameError::PayloadTooLarge(payload.len()));
    }
    let mut out = Vec::with_capacity(HEADER_SIZE + payload.len());
    out.extend_from_slice(&stream_id.to_be_bytes());
    out.push(flags & 0xff);
    out.extend_from_slice(&[0, 0, 0]);
    out.extend_from_slice(payload);
    Ok(out)
}

/// 解码一帧；畸形帧返回 None（对应 Node 的 `decodeDataFrame` 返回 null）。
pub fn decode_data_frame(raw: &[u8]) -> Option<DataFrame> {
    if raw.len() < HEADER_SIZE {
        return None;
    }
    let stream_id = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]);
    if stream_id == 0 {
        return None;
    }
    let flags = raw[4];
    let payload = &raw[HEADER_SIZE..];
    if payload.len() > MAX_PAYLOAD {
        return None;
    }
    Some(DataFrame {
        stream_id,
        flags,
        payload: payload.to_vec(),
    })
}

/// 生成 streamId：从 1 起递增，绕回 0 时回到 1。
pub struct StreamIdGenerator {
    next: u32,
}

impl StreamIdGenerator {
    pub fn new() -> Self {
        Self { next: 0 }
    }

    pub fn next(&mut self) -> u32 {
        self.next = self.next.wrapping_add(1);
        if self.next == 0 {
            self.next = 1;
        }
        self.next
    }
}

impl Default for StreamIdGenerator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_matches_node_layout() {
        // Node: encodeDataFrame(1, Buffer.from("hi"), 0)
        //   -> 00 00 00 01 00 00 00 00 68 69
        let frame = encode_data_frame(1, b"hi", 0).unwrap();
        assert_eq!(
            frame,
            vec![0, 0, 0, 1, 0, 0, 0, 0, 0x68, 0x69]
        );
    }

    #[test]
    fn encode_fin_and_rst_flags() {
        let fin = encode_data_frame(0x0102_0304, &[], FLAG_FIN).unwrap();
        assert_eq!(fin[..8], [1, 2, 3, 4, 0x01, 0, 0, 0]);
        let rst = encode_data_frame(7, b"x", FLAG_RST).unwrap();
        assert_eq!(rst[..8], [0, 0, 0, 7, 0x02, 0, 0, 0]);
        assert_eq!(&rst[8..], b"x");
    }

    #[test]
    fn reject_invalid_inputs() {
        assert_eq!(encode_data_frame(0, b"", 0), Err(FrameError::InvalidStreamId(0)));
        assert_eq!(
            encode_data_frame(1, &vec![0; MAX_PAYLOAD + 1], 0),
            Err(FrameError::PayloadTooLarge(MAX_PAYLOAD + 1))
        );
    }

    #[test]
    fn decode_roundtrip() {
        let raw = encode_data_frame(42, b"payload", FLAG_FIN).unwrap();
        let frame = decode_data_frame(&raw).unwrap();
        assert_eq!(frame.stream_id, 42);
        assert_eq!(frame.flags, FLAG_FIN);
        assert_eq!(frame.payload, b"payload");
    }

    #[test]
    fn decode_malformed_returns_none() {
        assert!(decode_data_frame(&[]).is_none());
        assert!(decode_data_frame(&[0; 8]).is_none()); // streamId=0
        let mut oversized = vec![0; HEADER_SIZE + MAX_PAYLOAD + 1];
        oversized[3] = 1; // streamId=1
        assert!(decode_data_frame(&oversized).is_none());
    }

    #[test]
    fn stream_id_wraps_to_one() {
        let mut generator = StreamIdGenerator::new();
        assert_eq!(generator.next(), 1);
        assert_eq!(generator.next(), 2);
    }
}
