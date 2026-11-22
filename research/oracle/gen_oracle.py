import json, sys, glob, os, traceback
WORK = os.path.join(os.path.dirname(__file__), 'work')
sys.path.insert(0, WORK)
from custom_components.localthings.registry.batch import parse_device0_batch
from custom_components.localthings.registry.by_type import resolve
from custom_components.localthings.registry.registry import CAPABILITIES
from custom_components.localthings.registry.discovery import discover
from custom_components.localthings.registry.adapter import flatten

FIX = sys.argv[1]
OUT = sys.argv[2]
results = {}
summary = {"ok":0, "fail":0, "by_type":{}}
for path in sorted(glob.glob(os.path.join(FIX, '*_device.json'))):
    name = os.path.basename(path)[:-len('_device.json')]
    try:
        d = json.load(open(path))
        resources = parse_device0_batch(d['device0'])
        oic_d = resources.get('/oic/d', {})
        dtypes = tuple(t for t in (oic_d.get('rt') or []) if isinstance(t,str))
        reg = resolve(resources, device_types=dtypes)
        if reg is None:
            caps, pats, regname = CAPABILITIES, [], None
        else:
            caps, pats, regname = reg.capabilities, reg.pattern_capabilities, reg.name
        bound = discover(resources, caps, pats)
        state = flatten(bound, resources)
        # entity kinds: the dataclass subclass name per bound entity
        kinds = {}
        for b in bound:
            desc = getattr(b, 'desc', None) or getattr(b, 'description', None)
            k = type(desc).__name__ if desc is not None else type(b).__name__
            kinds[k] = kinds.get(k, 0) + 1
        results[name] = {
            "registry": regname,
            "device_types": list(dtypes),
            "num_resources": len(resources),
            "num_bound_entities": len(bound),
            "state_keys": sorted(state.keys()),
            "entity_kinds": kinds,
            "state": {k: (v if isinstance(v,(str,int,float,bool)) or v is None else str(v)) for k,v in state.items()},
        }
        summary["ok"] += 1
        summary["by_type"][regname] = summary["by_type"].get(regname,0)+1
    except Exception as e:
        results[name] = {"error": repr(e), "trace": traceback.format_exc()[-600:]}
        summary["fail"] += 1
json.dump({"summary":summary, "fixtures":results}, open(OUT,'w'), indent=1)
print("ok",summary["ok"],"fail",summary["fail"])
print("registries:", json.dumps(summary["by_type"]))
