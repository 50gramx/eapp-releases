"""Which brands build-eapp-ios.yml builds this run.

Every brand whose contract has an ios: block (its team-id at least) is an
iOS app. Its bundle id is the contract's ios.bundle-id when it names one, else
the brand's store identity by the usual nomenclature
(resolve_contract_delivery.mjs: its Android applicationId).
One is rebuilt when what it is made from differs from its last build's
marker, or on demand. "What it is made from" is build-plan.mjs's fingerprint:
eapp-live minus docs, tests and other platforms' folders, the brand's
resolved contract, the workflow, the iOS gram. A marker from before
fingerprints is compared on its three commits instead.
Writes `brands` (JSON list) and `any` to GITHUB_OUTPUT.
"""
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


def plan(brand, now):
    """build-plan.mjs's verdict for one brand: (rebuild?, fingerprint, parts)."""
    out = os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "plan-%s.out" % brand)
    open(out, "w").close()
    subprocess.run(["node", ".github/scripts/build-plan.mjs", "--brand", brand, "--platform", "ios",
                    "--channel", "ios", "--marker-name", "%s-ios" % brand, "--promotable", "false",
                    "--eapp", ".plan-eapp", "--contracts", "contracts",
                    "--workflow", ".github/workflows/build-eapp-ios.yml",
                    "--epnd-state", os.environ.get("EPND_STATE", ""), "--legacy", now],
                   check=True, env=dict(os.environ, GITHUB_OUTPUT=out))
    vals = dict(line.split("=", 1) for line in open(out).read().splitlines() if "=" in line)
    return vals.get("action") == "build", vals.get("fingerprint", ""), json.loads(vals.get("parts") or "{}")


def main():
    only = os.environ.get("ONLY", "").strip()
    forced = os.environ.get("FORCED") == "true"
    now = " ".join(os.environ["NOW"].split())
    brands = ios_brands()
    print("brands declaring iOS:", " ".join(brands) or "(none)")
    if only and only not in brands:
        sys.exit(f"brand {only} declares no ios block in its contract")
    todo, prints = [], {}
    for b in brands:
        if only and b != only:
            continue
        rebuild, fingerprint, parts = plan(b, now)
        prints[b] = {"fingerprint": fingerprint, "parts": parts}
        if forced or rebuild:
            todo.append(b)
        else:
            print(b, "unchanged since its last build; skipping")
    print("building:", todo)
    with open(os.environ["GITHUB_OUTPUT"], "a") as o:
        o.write("brands=%s\n" % json.dumps(todo))
        o.write("any=%s\n" % ("true" if todo else "false"))
        o.write("fingerprints=%s\n" % json.dumps(prints, separators=(",", ":")))


if __name__ == "__main__":
    main()
