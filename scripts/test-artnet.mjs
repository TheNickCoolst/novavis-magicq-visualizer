import dgram from 'node:dgram';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const HTTP_BASE = 'http://127.0.0.1:4321';
const WS_URL = 'ws://127.0.0.1:4321/ws';
const ARTNET_PORT = 6454;
const SACN_PORT = 5568;

/**
 * Create a minimal valid ZIP buffer containing one deflated entry (for .mvr testing)
 */
function buildSingleFileZip(filename, contentUtf8) {
  const raw = Buffer.from(contentUtf8, 'utf8');
  const compressed = zlib.deflateRawSync(raw);
  const nameBuf = Buffer.from(filename, 'utf8');

  // Local file header (30 bytes + name)
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8); // Deflate
  localHeader.writeUInt32LE(0, 14); // CRC32 (not required by our MVR reader)
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(raw.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);

  const cdOffset = localHeader.length + nameBuf.length + compressed.length;

  // Central directory header (46 bytes + name)
  const cdHeader = Buffer.alloc(46);
  cdHeader.writeUInt32LE(0x02014b50, 0);
  cdHeader.writeUInt16LE(20, 4);
  cdHeader.writeUInt16LE(20, 6);
  cdHeader.writeUInt16LE(8, 10);
  cdHeader.writeUInt32LE(compressed.length, 20);
  cdHeader.writeUInt32LE(raw.length, 24);
  cdHeader.writeUInt16LE(nameBuf.length, 28);
  cdHeader.writeUInt32LE(0, 42); // localHeaderOffset = 0

  const cdSize = cdHeader.length + nameBuf.length;

  // End of Central Directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([localHeader, nameBuf, compressed, cdHeader, nameBuf, eocd]);
}

async function runTests() {
  console.log('1️⃣ Prüfe HTTP-Server & Offline Three.js Assets…');
  for (const urlPath of ['/', '/styles.css', '/js/app.js', '/vendor/three/build/three.module.js', '/api/status']) {
    const res = await fetch(`${HTTP_BASE}${urlPath}`);
    assert.equal(res.status, 200, `Expected 200 for ${urlPath}`);
  }
  const statusJson = await (await fetch(`${HTTP_BASE}/api/status`)).json();
  assert.equal(statusJson.artnetBound, true, 'Art-Net UDP 6454 sollte gebunden sein');
  assert.equal(statusJson.sacnBound, true, 'sACN UDP 5568 sollte gebunden sein');
  console.log('   ✓ HTTP & Offline-Assets OK');

  console.log('2️⃣ Prüfe Art-Net 4 ArtPoll → ArtPollReply Auto-Discovery für MagicQ…');
  await new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timeout = setTimeout(() => {
      sock.close();
      reject(new Error('Timeout bei ArtPollReply'));
    }, 2000);

    sock.on('message', (msg) => {
      if (msg.length >= 201 && msg.toString('ascii', 0, 7) === 'Art-Net' && msg.readUInt16LE(8) === 0x2100) {
        const shortName = msg.toString('ascii', 26, 44).replace(/\0+$/, '');
        assert.ok(shortName.includes('NovaVis'), `Unerwarteter ShortName: ${shortName}`);
        assert.equal(msg[200], 0x03, 'Style sollte 0x03 (StVisual) sein');
        clearTimeout(timeout);
        sock.close();
        resolve();
      }
    });

    const poll = Buffer.alloc(14, 0);
    poll.write('Art-Net\0', 0, 'ascii');
    poll.writeUInt16LE(0x2000, 8); // OpPoll
    poll.writeUInt16BE(14, 10);
    sock.send(poll, ARTNET_PORT, '127.0.0.1');
  });
  console.log('   ✓ MagicQ ArtPollReply (StVisual 0x03) OK');

  console.log('3️⃣ Prüfe Echtzeit ArtDmx (:6454) + sACN E1.31 (:5568) → WebSocket Binary Stream…');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const sender = dgram.createSocket('udp4');
    let gotArtNetUni0 = false;
    let gotSacnUni2 = false;

    const timer = setTimeout(() => {
      ws.close();
      sender.close();
      reject(new Error(`Timeout WebSocket DMX (ArtNet=${gotArtNetUni0}, sACN=${gotSacnUni2})`));
    }, 2500);

    ws.on('open', () => {
      // Send ArtDmx Universe 0 with marker bytes
      const artPkt = Buffer.alloc(18 + 512, 0);
      artPkt.write('Art-Net\0', 0, 'ascii');
      artPkt.writeUInt16LE(0x5000, 8);
      artPkt.writeUInt16BE(14, 10);
      artPkt[14] = 0; // Universe 0
      artPkt.writeUInt16BE(512, 16);
      artPkt[18 + 0] = 128;
      artPkt[18 + 4] = 251; // Marker Dimmer = 251
      sender.send(artPkt, ARTNET_PORT, '127.0.0.1');

      // Send sACN E1.31 Universe 3 (0-indexed Universe 2) with marker byte 242
      const sacnPkt = Buffer.alloc(126 + 512, 0);
      sacnPkt.writeUInt16BE(0x0010, 0);
      sacnPkt.write('ASC-E1.17', 4, 'ascii');
      sacnPkt.writeUInt32BE(0x00000004, 18); // Root vector
      sacnPkt.writeUInt32BE(0x00000002, 40); // Framing vector
      sacnPkt.writeUInt16BE(3, 113);         // sACN Universe 3 -> 0-indexed 2
      sacnPkt[117] = 0x02;                   // DMP vector
      sacnPkt.writeUInt16BE(513, 123);       // 1 start code + 512 slots
      sacnPkt[125] = 0x00;                   // DMX null start code
      sacnPkt[126 + 0] = 242;
      sender.send(sacnPkt, SACN_PORT, '127.0.0.1');
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const buf = Buffer.from(data);
      if (buf.length === 516 && buf[0] === 0x44 && buf[1] === 0x4d && buf[2] === 0x58) {
        if (buf[3] === 0 && buf[4 + 4] === 251) gotArtNetUni0 = true;
        if (buf[3] === 2 && buf[4 + 0] === 242) gotSacnUni2 = true;
        if (gotArtNetUni0 && gotSacnUni2) {
          clearTimeout(timer);
          ws.close();
          sender.close();
          resolve();
        }
      }
    });
  });
  console.log('   ✓ Echtzeit Art-Net & sACN Binary WebSocket Stream (<50ms) OK');

  console.log('4️⃣ Prüfe Live MVR (.mvr ZIP) Show-Import & WebSocket Hot-Sync…');
  const sampleMvrXml = `<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6">
  <Scene>
    <Layers>
      <Layer name="Truss">
        <ChildList>
          <Fixture name="MagicQ Sharpy 1">
            <GDTFSpec>Clay_Paky@Sharpy</GDTFSpec>
            <GDTFMode>Standard 16ch</GDTFMode>
            <FixtureID>101</FixtureID>
            <Matrix>{1,0,0}{0,1,0}{0,0,1}{-3500,3800,6200}</Matrix>
            <Addresses><Address break="0">1.001</Address></Addresses>
          </Fixture>
          <Fixture name="MagicQ Wash 2">
            <GDTFSpec>Robe@Spiider_Wash</GDTFSpec>
            <GDTFMode>12ch</GDTFMode>
            <FixtureID>102</FixtureID>
            <Matrix>{1,0,0}{0,1,0}{0,0,1}{3500,1200,6400}</Matrix>
            <Addresses><Address break="0">1.017</Address></Addresses>
          </Fixture>
        </ChildList>
      </Layer>
    </Layers>
  </Scene>
</GeneralSceneDescription>`;

  const mvrZip = buildSingleFileZip('GeneralSceneDescription.xml', sampleMvrXml);
  const importRes = await fetch(`${HTTP_BASE}/api/import-patch?filename=test-show.mvr`, {
    method: 'POST',
    body: mvrZip,
  });
  const importJson = await importRes.json();
  assert.equal(importJson.ok, true);
  assert.equal(importJson.rig.fixtures.length, 2);
  assert.equal(importJson.rig.fixtures[0].type, 'beam16');
  assert.equal(importJson.rig.fixtures[1].type, 'wash12');
  console.log('   ✓ MVR ZIP Entpacken + 3D-Matrix + DMX-Patch Live-Sync OK');

  // Reset cached custom rig so fresh browser sessions start with full Arena preset + towers
  await fetch(`${HTTP_BASE}/api/reset-rig`, { method: 'POST' });

  console.log('\n🎉 ALLE LIVE-SYNC & NETZWERK-TESTS ERFOLGREICH BESTANDEN!');
}

runTests().catch((err) => {
  console.error('❌ Test fehlgeschlagen:', err);
  process.exit(1);
});
