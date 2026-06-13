import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return false;
  }

  const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      ''
    ].join('\r\n')
  );
  return true;
}

export function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const header = [];
  header.push(0x81);

  if (body.length < 126) {
    header.push(body.length);
  } else if (body.length < 65_536) {
    header.push(126, (body.length >> 8) & 255, body.length & 255);
  } else {
    header.push(127, 0, 0, 0, 0, (body.length >> 24) & 255, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255);
  }

  return Buffer.concat([Buffer.from(header), body]);
}

export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const byte1 = buffer[offset];
    const byte2 = buffer[offset + 1];
    const opcode = byte1 & 0x0f;
    const masked = (byte2 & 0x80) === 0x80;
    let length = byte2 & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const totalLength = headerLength + maskLength + length;
    if (offset + totalLength > buffer.length) break;

    const mask = masked ? buffer.subarray(offset + headerLength, offset + headerLength + 4) : null;
    const payloadStart = offset + headerLength + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));

    if (mask) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= mask[i % 4];
      }
    }

    frames.push({ opcode, payload: payload.toString('utf8') });
    offset += totalLength;
  }

  return { frames, remaining: buffer.subarray(offset) };
}
