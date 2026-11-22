import sys, os
sys.path.insert(0, "/tmp/claude-1000/-home-aziz-localthings/3934c388-d639-43b0-8389-7b4d3d4a4de1/scratchpad/research/smartthings-local")
import smartthings_local.protocol.auth as auth
# Trust the simulator's self-signed server cert (stands in for the OCF root CA).
auth._OCF_ROOT_CA = sys.argv[3]
from smartthings_local.protocol.dtls_session import DtlsCoapSession
from smartthings_local.protocol.auth import CertificateAuth
import cbor2
HOST="127.0.0.1"; PORT=int(sys.argv[1])
a = CertificateAuth.from_files("/tmp/claude-1000/-home-aziz-localthings/3934c388-d639-43b0-8389-7b4d3d4a4de1/scratchpad/research/interop/certs/client.crt", "/tmp/claude-1000/-home-aziz-localthings/3934c388-d639-43b0-8389-7b4d3d4a4de1/scratchpad/research/interop/certs/client.key")
sess = DtlsCoapSession(HOST, PORT, auth=a, on_notification=lambda h,p: None)
sess.connect(timeout=6.0)
sess.start_reader()
code, body = sess.get(["device","0"])
obj = cbor2.loads(body) if body else None
print("GET /device/0 code=0x%02x len=%d items=%s" % (code, len(body or b''), (len(obj) if isinstance(obj,list) else 'n/a')))
sess.close()
