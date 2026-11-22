
const dgram=require('dgram');
const fs=require('fs');
const s=dgram.createSocket('udp4');
let first=null;
s.on('message',(m,ri)=>{ if(!first){first=m; fs.writeFileSync(process.argv[3], m);} s.send(m, ri.port, ri.address); });
s.bind(parseInt(process.argv[2],10), ()=>console.log('echo bound'));
setTimeout(()=>process.exit(0), 8000);
