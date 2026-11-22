
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { DtlsServer } = require(path.join(ROOT, 'node_modules/werift-dtls/lib/dtls/src/index.js'));
const M = require(path.join(ROOT, 'dist/coap/message.js'));
const { encodeCbor } = require(path.join(ROOT, 'dist/ocf/cbor.js'));
const { parseDevice0Batch } = require(path.join(ROOT, 'dist/ocf/discovery.js'));

const CERT = fs.readFileSync(process.argv[2], 'utf8');
const KEY = fs.readFileSync(process.argv[3], 'utf8');
const FIXTURE = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const device0 = FIXTURE.device0;
const resources = parseDevice0Batch(device0);

const sock = dgram.createSocket('udp4');
let peer;
const backing = { type:'udp', address:{address:'0.0.0.0',family:'IPv4',port:0}, closed:false,
  onData:()=>{}, send:(d)=>new Promise((res,rej)=>{ if(!peer) return res(); sock.send(d, peer.port, peer.address, e=>e?rej(e):res()); }),
  close:async()=>{ try{sock.close()}catch{} } };
sock.on('message',(msg,ri)=>{ peer=ri; backing.onData(msg,[ri.address,ri.port]); });
sock.bind(0, ()=>{ console.error('SIM_PORT ' + sock.address().port); });

const server = new DtlsServer({ transport: backing, cert: CERT, key: KEY, certificateRequest:true, signatureHash:{hash:4,signature:3} });
server.onConnect.subscribe(()=>console.error('SIM dtls connected'));
server.onData.subscribe((buf)=>{
  let m; try{ m=M.decode(buf);}catch{return;}
  if (m.type===M.CoapType.ACK) return;
  const segs = m.options.filter(o=>o.number===M.Opt.URI_PATH).map(o=>o.value.toString());
  const href = '/'+segs.join('/');
  const cf = { number:M.Opt.CONTENT_FORMAT, value: Buffer.from([M.ContentFormat.CBOR]) };
  let full;
  if (href==='/device/0') full = encodeCbor(device0);
  else if (resources[href]) full = encodeCbor(resources[href]);
  else { server.send(M.encode({type:M.CoapType.ACK, code:M.mkCode(4,4), messageId:m.messageId, token:m.token, options:[]})); return; }
  // Block2
  const reqB = m.options.find(o=>o.number===M.Opt.BLOCK2);
  const szx = reqB && reqB.value.length ? M.blockFields(reqB.value).szx : 6;
  const bs = 1<<(szx+4);
  if (full.length<=bs && !reqB) { server.send(M.encode({type:M.CoapType.ACK, code:M.mkCode(2,5), messageId:m.messageId, token:m.token, options:[cf], payload:full})); return; }
  const num = reqB && reqB.value.length ? M.blockFields(reqB.value).num : 0;
  const start = num*bs; const chunk = full.subarray(start, start+bs); const more = start+bs < full.length;
  server.send(M.encode({type:M.CoapType.ACK, code:M.mkCode(2,5), messageId:m.messageId, token:m.token, options:[cf,{number:M.Opt.BLOCK2, value:M.blockValue(num,more,szx)}], payload: chunk.length?Buffer.from(chunk):undefined}));
});
setTimeout(()=>process.exit(0), 20000);
