process.on('unhandledRejection',(e)=>console.error('UNHANDLED',e&&(e.stack||e)));
process.on('uncaughtException',(e)=>console.error('UNCAUGHT',e&&(e.stack||e)));

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { DtlsClient } = require('werift-dtls/lib/dtls/src/index.js');

const HOST = '127.0.0.1';
const PORT = parseInt(process.argv[2], 10);
const certDir = path.join(__dirname, 'certs');
const cert = fs.readFileSync(path.join(certDir, 'client.crt'), 'utf8');
const key = fs.readFileSync(path.join(certDir, (process.env.CKEY||'client.key')), 'utf8');

// Minimal Transport backed by a connected UDP socket (mirrors the plugin's planned transport)
const sock = dgram.createSocket('udp4');
const transport = {
  type: 'udp',
  address: { address: HOST, family: 'IPv4', port: 0 },
  closed: false,
  onData: () => {},
  send: (data) => new Promise((res, rej) => sock.send(data, PORT, HOST, (e) => e ? rej(e) : res())),
  close: async () => { try { sock.close(); } catch {} },
};
sock.on('message', (msg) => { console.log('INBOUND bytes=' + msg.length); try { transport.onData(msg, [HOST, PORT]); } catch (e) { console.error('onData err', e && (e.stack||e)); } });

const client = new DtlsClient({ transport, cert, key, certificateRequest: true, signatureHash: { hash: 4, signature: 1 } });
let done = false;
const finish = (code, msg) => { if (done) return; done = true; console.log(msg); try { client.close(); } catch {} try { sock.close(); } catch {} setTimeout(() => process.exit(code), 50); };

client.onConnect.subscribe(() => {
  console.log('EVENT connected=true');
  client.send(Buffer.from('HELLO-WERIFT-APPDATA\n')).then(() => console.log('sent app data')).catch(e => console.error('send err', e));
});
client.onData.subscribe((buf) => { console.log('RECV ' + JSON.stringify(buf.toString())); finish(0, 'OK bidirectional app data'); });
client.onError.subscribe((e) => console.error('EVENT error', e && (e.stack||e.message)));
client.onClose.subscribe(() => console.log('EVENT close'));

sock.bind(0, () => {
  client.connect().then(() => console.log('connect() resolved')).catch(e => console.error('connect() rejected', e && e.message));
});
setTimeout(() => finish(2, 'TIMEOUT (no app data echo within 12s)'), 12000);
