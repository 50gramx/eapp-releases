#!/usr/bin/env python3
"""Keep every Kaggle gram notebook running: a session ends, the next starts.

A Kaggle CPU session stops at 12 hours and nothing starts the next one, so a
gram sat idle from the end of one run until someone clicked "Save & Run All"
again. This runs on a schedule (.github/workflows/kaggle-grams.yml): for every
account and every notebook in data/kaggle/grams.json it asks Kaggle for the
notebook's status, and when the last version has finished (complete, error or
cancelled) it pulls the notebook's own saved code and metadata and pushes them
back, which is exactly "Save & Run All": a new version, run from the top.

Accounts come from the KAGGLE_ACCOUNTS secret, a JSON list of
{"username": ..., "key": ...} (the two fields of a kaggle.json API token).

A notebook that does not exist on an account yet is created from the template
account's copy with NO inputs: a new gram must start from no epn-home.tgz, or
it would load another gram's device key and be the same DID twice. Once a
version of it has run, its own output is attached as its input, so every later
run restores its identity and its signed results.

Usage: kaggle_keepalive.py [--dry-run]
"""
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "data", "kaggle", "grams.json")
FINISHED = {"complete", "error", "cancelacknowledged", "cancelrequested"}
DRY = "--dry-run" in sys.argv


def kaggle(cfg_dir, *args):
    env = dict(os.environ, KAGGLE_CONFIG_DIR=cfg_dir)
    r = subprocess.run(["kaggle", *args], capture_output=True, text=True, env=env)
    return r.returncode, (r.stdout + r.stderr).strip()


def account_dir(acct):
    d = tempfile.mkdtemp(prefix="kaggle-")
    path = os.path.join(d, "kaggle.json")
    with open(path, "w") as f:
        json.dump({"username": acct["username"], "key": acct["key"]}, f)
    os.chmod(path, 0o600)
    return d


def status(cfg_dir, ref):
    """'running', 'complete', ... or 'missing' when the notebook does not exist."""
    code, out = kaggle(cfg_dir, "kernels", "status", ref)
    m = re.search(r'status "?([A-Za-z]+)"?', out)
    if code == 0 and m:
        return m.group(1).lower(), out
    if re.search(r"404|not found|does not exist", out, re.I):
        return "missing", out
    return "unknown", out


def pull(cfg_dir, ref, into):
    code, out = kaggle(cfg_dir, "kernels", "pull", ref, "-p", into, "-m")
    if code != 0:
        raise RuntimeError("pull %s: %s" % (ref, out[-300:]))
    with open(os.path.join(into, "kernel-metadata.json")) as f:
        return json.load(f)


def push(cfg_dir, folder, meta):
    with open(os.path.join(folder, "kernel-metadata.json"), "w") as f:
        json.dump(meta, f, indent=2)
    if DRY:
        return 0, "dry run: would push %s" % meta["id"]
    return kaggle(cfg_dir, "kernels", "push", "-p", folder)


def main():
    with open(CONFIG) as f:
        cfg = json.load(f)
    accounts = json.loads(os.environ.get("KAGGLE_ACCOUNTS") or "[]")
    if not accounts:
        print("KAGGLE_ACCOUNTS is empty: add the secret (a JSON list of kaggle.json tokens) to keep the grams running")
        return 0
    by_name = {a["username"]: a for a in accounts}
    template = by_name.get(cfg["template_account"])
    tdir = account_dir(template) if template else None
    started = 0
    for acct in accounts:
        adir = account_dir(acct)
        own = acct["username"] == cfg["template_account"]
        for nb in cfg["notebooks"]:
            slug = nb["slug"] if own else nb.get("clone_slug", nb["slug"])
            ref = "%s/%s" % (acct["username"], slug)
            st, said = status(adir, ref)
            print("%-45s %s" % (ref, st))
            if st not in FINISHED and st != "missing":
                continue
            work = tempfile.mkdtemp(prefix="nb-")
            try:
                if st == "missing":
                    if not tdir:
                        print("  cannot create: the template account %s is not in KAGGLE_ACCOUNTS" % cfg["template_account"])
                        continue
                    meta = pull(tdir, "%s/%s" % (cfg["template_account"], nb["slug"]), work)
                    meta.update(id=ref, title=slug)
                    # A NEW GRAM STARTS WITH NO HOME. Inputs carry epn-home.tgz,
                    # and with it another gram's device key.
                    meta["dataset_sources"], meta["kernel_sources"] = [], []
                else:
                    meta = pull(adir, ref, work)
                    # ITS OWN LAST OUTPUT IS ITS HOME: attached once a version
                    # has run, so a created clone keeps its identity from then on.
                    if st == "complete" and ref not in meta.get("kernel_sources", []):
                        meta.setdefault("kernel_sources", []).append(ref)
                meta["enable_internet"] = True
                meta["enable_gpu"] = bool(nb.get("gpu", False))
                code, out = push(adir, work, meta)
                ok = code == 0 and not re.search(r"error|limit|maximum", out, re.I)
                print("  %s: %s" % ("started" if ok else "NOT started", out.splitlines()[-1] if out else ""))
                started += ok
            except Exception as e:  # one notebook's failure never stops the rest
                print("  NOT started: %s" % e)
    print("started %d notebook run(s)" % started)
    return 0


if __name__ == "__main__":
    sys.exit(main())
