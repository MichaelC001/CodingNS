/**
 * DataChannel 发送载荷（spec001.9 W2.1）
 *
 * `RTCDataChannel.send()` 既接受 `ArrayBufferView`，也接受 `ArrayBuffer`。
 * 这里统一处理一件事：**不要**把 `Uint8Array` 的视图直接当成整个 buffer 发出去。
 *
 * 为什么单独一份：`encodeFrame()` 返回的 `Uint8Array` 在有些实现里是某个更大
 * `ArrayBuffer` 上的视图（偏移和长度不一定是 0..byteLength）。
 * 直接 `send(uint8Array.buffer)` 会把整块 buffer 都发出去，多出一堆垃圾字节。
 * 所以这里只在「视图等于整块 buffer」时才走零拷贝，否则按视图边界复制一份。
 */
export function encodeDataChannelPayload(bytes: Uint8Array): ArrayBuffer | Uint8Array {
  const isWholeBuffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;

  if (isWholeBuffer) {
    return bytes;
  }

  return bytes.slice();
}
