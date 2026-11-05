"""Which brands build-eapp-ios.yml builds this run.

Every brand whose contract has an ios: block (its team-id at least) is an
iOS app. Its bundle id is the contract's ios.bundle-id when it names one, else
the brand's Apple id by the usual nomenclature (resolve_contract_delivery.mjs:
the launch-environment without ".*", as on macOS).
One is rebuilt when what it is made from (eapp-live, the contracts, the
published in-app gram) differs from its last build's marker, or on demand.
Writes `brands` (JSON list) and `any` to GITHUB_OUTPUT.
"""
import base64
import glob
import json
import os
import subprocess
import sys

import yaml


def ios_brands():
    out = set()
    for f in glob.glob("contracts/**/ethosapps.yaml", recursive=True):
        for e in yaml.safe_load(open(f, encoding="utf-8")) or []:
            b = e.get("brand") if isinstance(e, dict) else None
            ios = (b or {}).get("ios") if isinstance(b, dict) else None
            if isinstance(ios, dict) and (ios.get("bundle-id") or ios.get("team-id")):
                out.add(b["id"])
    return sorted(out)


def last_built(brand):
    r = subprocess.run(["gh", "api", f"repos/50gramx/eapp-releases/contents/data/last-built/{brand}-ios.json",
                        "--jq", ".content"], capture_output=True, text=True)
    if r.returncode != 0:
        return ""
    try:
        d = json.loads(base64.b64decode(r.stdout))
    except Exception:
        return ""
    return " ".join(d.get(k, "") for k in ("eapp_sha", "contracts_sha", "epnd_state"))


def main():
    only = os.environ.get("ONLY", "").strip()
    forced = os.environ.get("FORCED") == "true"
    now = " ".join(os.environ["NOW"].split())
    brands = ios_brands()
    print("brands declaring iOS:", " ".join(brands) or "(none)")
    if only and only not in brands:
        sys.exit(f"brand {only} declares no ios block in its contract")
    todo = []
    for b in brands:
        if only and b != only:
            continue
        if forced or last_built(b) != now:
            todo.append(b)
        else:
            print(b, "unchanged since its last build; skipping")
    print("building:", todo)
    with open(os.environ["GITHUB_OUTPUT"], "a") as o:
        o.write("brands=%s\n" % json.dumps(todo))
        o.write("any=%s\n" % ("true" if todo else "false"))


if __name__ == "__main__":
    main()
