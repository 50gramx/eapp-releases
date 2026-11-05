"""Give a brand's iOS app the same internal TestFlight testers every other app has.

A new brand's App Store record starts with no TestFlight group, so its builds
reach nobody. After an upload, build-eapp-ios.yml runs this: if the app has
no internal group, it is given one shaped like the account's existing ones
(same name, automatic distribution of every build) with the union of their
testers. An app that already has an internal group is left alone, so a
hand-made change is never undone.

Needs ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 and BUNDLE_ID in the environment.
"""
import os
import sys
import time

import jwt
import requests

API = "https://api.appstoreconnect.apple.com/v1"


def token():
    now = int(time.time())
    return jwt.encode(
        {"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"},
        os.environ["ASC_KEY_P8"],
        algorithm="ES256",
        headers={"kid": os.environ["ASC_KEY_ID"], "typ": "JWT"},
    )


def call(method, path, **kw):
    r = requests.request(method, API + path, headers={"Authorization": "Bearer " + token()}, timeout=60, **kw)
    if r.status_code >= 400:
        sys.exit(f"{method} {path}: {r.status_code} {r.text[:400]}")
    return r.json() if r.text else {}


def internal_groups(app_id):
    groups = call("GET", f"/apps/{app_id}/betaGroups", params={"limit": 200})["data"]
    return [g for g in groups if g["attributes"].get("isInternalGroup")]


def main():
    bundle = os.environ["BUNDLE_ID"]
    apps = call("GET", "/apps", params={"limit": 200})["data"]
    mine = next((a for a in apps if a["attributes"]["bundleId"] == bundle), None)
    if not mine:
        print(f"no App Store record for {bundle} yet; nothing to do")
        return
    if internal_groups(mine["id"]):
        print(f"{bundle} already has an internal TestFlight group; left as it is")
        return

    name, testers = None, set()
    for app in apps:
        if app["id"] == mine["id"]:
            continue
        for g in internal_groups(app["id"]):
            name = name or g["attributes"]["name"]
            for t in call("GET", f"/betaGroups/{g['id']}/betaTesters", params={"limit": 200})["data"]:
                testers.add(t["id"])
    if not testers:
        print("no other app has internal testers to copy; nothing to do")
        return

    group = call("POST", "/betaGroups", json={"data": {
        "type": "betaGroups",
        "attributes": {"name": name or "Internal testers", "isInternalGroup": True, "hasAccessToAllBuilds": True},
        "relationships": {"app": {"data": {"type": "apps", "id": mine["id"]}}},
    }})["data"]
    call("POST", f"/betaGroups/{group['id']}/relationships/betaTesters",
         json={"data": [{"type": "betaTesters", "id": t} for t in sorted(testers)]})
    print(f"{bundle}: internal group '{group['attributes']['name']}' with {len(testers)} testers, every build")


if __name__ == "__main__":
    main()
