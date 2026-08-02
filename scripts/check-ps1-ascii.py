#!/usr/bin/env python3
"""Refuse to publish a PowerShell script that is not pure ASCII.

WHY THIS EXISTS
---------------
Windows PowerShell 5.1 decodes a BOM-less .ps1 as CP1252, not UTF-8. An em dash
(E2 80 94) therefore arrives as three characters, the last of which is U+201D --
a RIGHT DOUBLE QUOTATION MARK, which PowerShell honours as a string terminator.

One em dash inside a Write-Host string in epnd-autoupdate.ps1 ended that string
early, so everything after it re-parsed as garbage. The updater silently took its
checksum-mismatch branch and exited 0: every Windows node stopped updating while
Task Scheduler reported success for two weeks. It went unnoticed because the
failure is indistinguishable from "nothing to do".

These files are prose-heavy and the house style uses em dashes everywhere, so
this WILL be reintroduced. Catching it at publish time costs a build; catching it
in the field costs every node on the network.

Checked here in Python rather than with `grep -P`, which is unavailable under
LC_ALL=C on the CI runner -- and a gate whose check silently errors out is worse
than no gate, because it reports success for exactly the input it was built to
catch.
"""
import glob
import sys

# What to write instead. The point is not that Unicode is wrong, it is that these
# files are read by an interpreter that cannot be told which encoding they are in.
SUGGEST = {
    0x93: 'a smart quote', 0x94: 'a smart quote',
    0x91: 'a smart quote', 0x92: 'a smart quote',
}


def main(patterns):
    bad = False
    for pattern in patterns:
        for path in sorted(glob.glob(pattern)):
            raw = open(path, 'rb').read()
            if raw[:3] == b'\xef\xbb\xbf':
                # A BOM would actually fix the decoding, but it breaks other
                # consumers (sha256 pinning, `bash` reading the .sh siblings), so
                # the rule stays "ASCII only" rather than "BOM or ASCII".
                print('::error file=%s::starts with a UTF-8 BOM; keep these files pure ASCII instead' % path)
                bad = True
            for n, line in enumerate(raw.split(b'\n'), 1):
                offenders = [b for b in line if b > 127]
                if not offenders:
                    continue
                bad = True
                print('::error file=%s,line=%d::non-ASCII byte(s) %s in a PowerShell script. '
                      'Windows PowerShell 5.1 reads a BOM-less file as CP1252, where 0x91-0x94 '
                      'become smart quotes that terminate strings early. '
                      'Write -- for an em dash and ... for an ellipsis.'
                      % (path, n, ' '.join(hex(b) for b in offenders[:8])))
                print('    %s' % line.decode('utf-8', 'replace').strip()[:140])
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:] or ['scripts/*.ps1']))
