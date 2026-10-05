"""Trusted local solver host. Process separation only, NOT an OS security sandbox."""
import copy
import hashlib
import json
import sys


def main():
    raw = sys.stdin.buffer.read(192 * 1024 + 1)
    if len(raw) > 192 * 1024:
        raise ValueError("input limit")
    request = json.loads(raw)
    source = request["source"].encode("utf-8")
    if hashlib.sha256(source).hexdigest() != request["sourceSha256"]:
        raise ValueError("source mismatch")
    if not 8 <= len(request["cases"]) <= 32:
        raise ValueError("case count")
    namespace = {"__name__": "verified_local_solver", "__file__": "<verified-source>"}
    # Compile the same bytes that were hashed, rather than reopening a changeable source path.
    exec(compile(source, "<verified-source>", "exec"), namespace)
    solve = namespace["solve"]
    results = [{"caseId": c["id"], "answers": copy.deepcopy(solve(copy.deepcopy(c["challenge"])))}
               for c in request["cases"]]
    print(json.dumps({"sourceSha256": request["sourceSha256"], "pythonVersion": sys.version,
                      "results": results}, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Do not print solver exceptions, source, inputs or environment values.
        sys.stderr.write("Trusted local solver failed\n")
        sys.exit(1)
